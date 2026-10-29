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
 * Thin wrapper over node:sqlite. All SQL is written to stay portable to PostgreSQL
 * (positional params, ISO-8601 TEXT timestamps, JSON as TEXT, RETURNING).
 */
export class Db {
  readonly raw: DatabaseSyncT;
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
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

  /** Runs fn in a transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
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
      this.tx(() => {
        this.raw.exec(sql);
        this.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", f, now());
      });
      applied.push(f);
    }
    return applied;
  }

  close() {
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
