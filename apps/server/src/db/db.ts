import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";

// Loaded via require: Vite/Vitest 5 does not know node:sqlite as a builtin and fails to resolve a static import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Param = SQLInputValue | boolean | undefined;
type Row = Record<string, unknown>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

function norm(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}

/**
 * Thin wrapper over node:sqlite (SQLite is the production database — owner decision 2026-10-30).
 *
 * Concurrency model: one writer at a time (WAL lets readers continue). Every write transaction starts with
 * BEGIN IMMEDIATE, so lock contention shows up at the start, where SQLite's busy handler waits up to
 * `busy_timeout` for the other writer — that wait *is* the retry policy; there are no lock-upgrade deadlocks to
 * retry because no transaction starts as a reader. Transactions must stay short: the API is synchronous, a
 * transaction body cannot await (enforced below), and no network or LLM call may run inside one.
 */
export class Db {
  readonly raw: DatabaseSyncT;
  private depth = 0;
  private closed = false;
  /** called when a write transaction held the lock longer than `slowTxMs` (wired to the logger in index.ts) */
  onSlowTx: ((ms: number) => void) | null = null;
  slowTxMs = 250;

  constructor(path: string, opts: { busyTimeoutMs?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))};`);
    if (path !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL;");
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...norm(params)) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...norm(params)) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...norm(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /**
   * Runs fn in a write transaction. fn must be synchronous. A nested call runs in a SAVEPOINT inside the outer
   * transaction: if it throws, only its own writes are undone (and the error propagates), so a caller that catches
   * a nested failure never commits half of it.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      const sp = `sp_${this.depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const out = fn();
        if (out instanceof Promise) {
          out.catch(() => {});
          throw new Error("Db.tx: the transaction body must be synchronous (no await inside a transaction)");
        }
        this.raw.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    const started = Date.now();
    try {
      const out = fn();
      // an async body would commit before its awaits ran, i.e. outside the transaction
      if (out instanceof Promise) {
        out.catch(() => {});
        throw new Error("Db.tx: the transaction body must be synchronous (no await inside a transaction)");
      }
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      // SQLite may already have rolled back (e.g. disk full); the original error is the one that matters
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
      const ms = Date.now() - started;
      if (ms > this.slowTxMs) this.onSlowTx?.(ms);
    }
  }

  /** Migrations not applied yet, and whether this database already holds data (worth a backup first). */
  pendingMigrations(): { pending: string[]; existing: boolean } {
    const has = !!this.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
    const done = new Set(has ? this.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name) : []);
    const pending = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().filter((f) => !done.has(f));
    return { pending, existing: done.size > 0 };
  }

  migrate(): string[] {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const done = new Set(this.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      // Table rebuilds (SQLite's 12-step ALTER) must run with foreign keys off, or DROP TABLE would cascade.
      // The pragma only works outside a transaction; integrity is verified before the migration commits.
      const fkOff = sql.startsWith("-- migrate: foreign_keys=off");
      if (fkOff) this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.tx(() => {
          this.raw.exec(sql);
          if (fkOff) {
            const bad = this.all("PRAGMA foreign_key_check");
            if (bad.length) throw new Error(`${f}: foreign key check failed (${bad.length} rows)`);
          }
          this.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", f, now());
        });
      } finally {
        if (fkOff) this.raw.exec("PRAGMA foreign_keys = ON");
      }
      applied.push(f);
    }
    return applied;
  }

  /** Checkpoints the WAL into the main file (clean state for file copies) and closes. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort: another connection may still be reading */
    }
    this.raw.close();
  }
}

export const now = () => new Date().toISOString();

export function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
