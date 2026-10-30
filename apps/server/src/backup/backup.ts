// Encrypted, verified, off-site backups of the SQLite database.
//
//   snapshot  VACUUM INTO a temp file (a consistent copy while the app keeps serving) → PRAGMA integrity_check
//   package   gzip → AES-256-GCM with BACKUP_KEY (never the connector key); header = magic + key id + iv (+ tag),
//             authenticated as AAD, so a wrong key, a truncated or a tampered file is detected
//   upload    object + manifest (sha256 of the encrypted object, bytes, schema version, row counts) to the store
//   verify    download → sha256 → decrypt → gunzip → open → integrity_check → row counts equal the manifest.
//             A backup counts as verified only after this restore test succeeded.
//   retain    keep the newest N hourly, one per day for D days, one per month for M months; delete the rest
//
// Every step is recorded in backup_runs and the audit log. Credentials and keys are never logged.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import type { Db } from "../db/db.js";
import { now } from "../db/db.js";
import { SYSTEM, audit } from "../lib/audit.js";
import { uid } from "../lib/ids.js";
import type { ObjectStore } from "./store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const MAGIC = Buffer.from("SAGBK1");
/** Tables whose row counts are recorded and compared on verify (the business data that matters most). */
const COUNTED = ["users", "departments", "agents", "tasks", "task_events", "deliverables", "approvals", "knowledge_documents", "audit_logs"];

export interface BackupKey { id: string; key: Buffer }

export interface Retention { hourly: number; daily: number; monthly: number }
export const DEFAULT_RETENTION: Retention = { hourly: 48, daily: 30, monthly: 12 };

export interface Manifest {
  format: "SAGBK1";
  key: string;
  createdAt: string;
  schema: string[];
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261030T120000Z

function openReadOnly(path: string): DatabaseSyncT {
  return new DatabaseSync(path, { readOnly: true });
}

function countsOf(db: DatabaseSyncT): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (exists) out[t] = Number((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
  }
  return out;
}

function integrity(db: DatabaseSyncT) {
  const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error(`integrity_check failed: ${rows.map((r) => r.integrity_check).join("; ").slice(0, 300)}`);
}

/** Consistent copy of the live database into `path` (must not exist). Safe while the app is running. */
export function snapshotTo(db: Db, path: string) {
  db.raw.prepare("VACUUM INTO ?").run(path);
}

export function encrypt(plain: Buffer, k: BackupKey): Buffer {
  const id = Buffer.from(k.id, "utf8");
  if (id.length < 1 || id.length > 64) throw new Error("backup key id must be 1–64 bytes");
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([id.length]), id, iv]);
  const c = createCipheriv("aes-256-gcm", k.key, iv);
  c.setAAD(header);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([header, c.getAuthTag(), ct]);
}

export function decrypt(blob: Buffer, keys: BackupKey[]): Buffer {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a SAG backup file");
  const idLen = blob[MAGIC.length];
  const id = blob.subarray(MAGIC.length + 1, MAGIC.length + 1 + idLen).toString("utf8");
  const ivAt = MAGIC.length + 1 + idLen;
  const header = blob.subarray(0, ivAt + 12);
  const iv = blob.subarray(ivAt, ivAt + 12);
  const tag = blob.subarray(ivAt + 12, ivAt + 28);
  const k = keys.find((x) => x.id === id);
  if (!k) throw new Error(`backup was encrypted with key "${id}", which is not configured`);
  const d = createDecipheriv("aes-256-gcm", k.key, iv);
  d.setAAD(header);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(blob.subarray(ivAt + 28)), d.final()]);
  } catch {
    throw new Error("backup decryption failed: wrong key or the file was modified");
  }
}

export interface BackupOptions {
  db: Db;
  store: ObjectStore;
  key: BackupKey;
  /** decryption keys for verify/restore (current + retired, so old backups stay restorable after rotation) */
  keys?: BackupKey[];
  prefix?: string;
  retention?: Retention;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface BackupResult { runId: string; key: string; bytes: number; sha256: string; verified: boolean; pruned: number }

const objectKey = (prefix: string, at: Date) => `${prefix}sag-${stamp(at)}.db.gz.enc`;
const manifestKey = (k: string) => k.replace(/\.db\.gz\.enc$/, ".manifest.json");

/** One full cycle: snapshot → encrypt → upload → verify by restoring → prune. Throws on failure (recorded). */
export async function runBackup(o: BackupOptions, at = new Date()): Promise<BackupResult> {
  const prefix = o.prefix ?? "";
  const runId = uid("bkp");
  const key = objectKey(prefix, at);
  o.db.run("INSERT INTO backup_runs (id, started_at, object_key, status) VALUES (?,?,?, 'running')", runId, now(), key);
  const dir = mkdtempSync(join(tmpdir(), "sag-backup-"));
  try {
    const snap = join(dir, "snapshot.db");
    snapshotTo(o.db, snap);
    const ro = openReadOnly(snap);
    let counts: Record<string, number>;
    let schema: string[];
    try {
      integrity(ro);
      counts = countsOf(ro);
      schema = (ro.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    } finally {
      ro.close();
    }
    const blob = encrypt(gzipSync(readFileSync(snap), { level: 9 }), o.key);
    const manifest: Manifest = { format: "SAGBK1", key: o.key.id, createdAt: at.toISOString(), schema, bytes: blob.length, sha256: sha(blob), counts };
    await o.store.put(key, blob);
    await o.store.put(manifestKey(key), Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
    o.db.run("UPDATE backup_runs SET bytes = ?, sha256 = ?, schema_version = ?, finished_at = ?, status = 'uploaded' WHERE id = ?",
      blob.length, manifest.sha256, schema.at(-1) ?? null, now(), runId);
    audit(o.db, SYSTEM, "backup.created", { type: "backup", id: runId }, { object: key, bytes: blob.length, store: o.store.describe });

    await verifyBackup({ ...o }, key, runId);
    const pruned = await pruneBackups(o, at);
    return { runId, key, bytes: blob.length, sha256: manifest.sha256, verified: true, pruned };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    o.db.run("UPDATE backup_runs SET status = 'failed', error = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?", msg, now(), runId);
    audit(o.db, SYSTEM, "backup.failed", { type: "backup", id: runId }, { object: key, error: msg });
    o.log?.("backup failed", { runId, error: msg });
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Downloads one backup and restores it into a temporary file to prove it is usable. */
export async function verifyBackup(o: BackupOptions, key: string, runId?: string): Promise<Manifest> {
  const dir = mkdtempSync(join(tmpdir(), "sag-verify-"));
  try {
    const manifest = await restoreInto(o, key, join(dir, "restored.db"));
    if (runId) o.db.run("UPDATE backup_runs SET status = 'verified', verified_at = ? WHERE id = ?", now(), runId);
    audit(o.db, SYSTEM, "backup.verified", { type: "backup", id: runId ?? null }, { object: key });
    return manifest;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function restoreInto(o: Pick<BackupOptions, "store" | "key" | "keys">, key: string, target: string): Promise<Manifest> {
  const manifest = JSON.parse((await o.store.get(manifestKey(key))).toString("utf8")) as Manifest;
  const blob = await o.store.get(key);
  if (blob.length !== manifest.bytes || sha(blob) !== manifest.sha256) throw new Error("backup object does not match its manifest (size or checksum)");
  const plain = gunzipSync(decrypt(blob, o.keys ?? [o.key]));
  writeFileSync(target, plain);
  const ro = openReadOnly(target);
  try {
    integrity(ro);
    const counts = countsOf(ro);
    for (const [t, n] of Object.entries(manifest.counts))
      if (counts[t] !== n) throw new Error(`restored row count differs for ${t}: ${counts[t]} ≠ ${n}`);
  } finally {
    ro.close();
  }
  return manifest;
}

/**
 * Restore for disaster recovery: writes the verified database to `target` (refuses to overwrite an existing file).
 * The service must be stopped and the file moved into place by the operator (see DEPLOY.md runbook).
 */
export async function restoreBackup(o: Pick<BackupOptions, "store" | "key" | "keys">, key: string, target: string, auditDb?: Db): Promise<Manifest> {
  if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);
  const tmp = `${target}.partial`;
  const manifest = await restoreInto(o, key, tmp);
  renameSync(tmp, target);
  if (auditDb) audit(auditDb, SYSTEM, "backup.restored", { type: "backup", id: null }, { object: key, target });
  return manifest;
}

/** Which backups to keep: newest `hourly`, then the newest of each day for `daily` days, of each month for `monthly` months. */
export function selectKept(keys: string[], r: Retention): Set<string> {
  const dated = keys
    .map((k) => ({ k, t: /sag-(\d{8}T\d{6}Z)\.db\.gz\.enc$/.exec(k)?.[1] }))
    .filter((x): x is { k: string; t: string } => !!x.t)
    .sort((a, b) => b.t.localeCompare(a.t));
  const keep = new Set(dated.slice(0, r.hourly).map((x) => x.k));
  const pick = (len: number, n: number) => {
    const seen = new Set<string>();
    for (const x of dated) {
      const bucket = x.t.slice(0, len);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      if (seen.size > n) break;
      keep.add(x.k);
    }
  };
  pick(8, r.daily); // YYYYMMDD
  pick(6, r.monthly); // YYYYMM
  return keep;
}

export async function pruneBackups(o: BackupOptions, _at = new Date()): Promise<number> {
  const prefix = o.prefix ?? "";
  const objects = (await o.store.list(prefix)).map((x) => x.key).filter((k) => k.endsWith(".db.gz.enc"));
  const keep = selectKept(objects, o.retention ?? DEFAULT_RETENTION);
  let n = 0;
  for (const k of objects) {
    if (keep.has(k)) continue;
    await o.store.delete(k);
    await o.store.delete(manifestKey(k));
    n++;
  }
  if (n) audit(o.db, SYSTEM, "backup.pruned", { type: "backup", id: null }, { deleted: n });
  return n;
}

/** Periodic job inside the server. Runs are serialised; a failure is recorded and retried on the next tick. */
export class BackupJob {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  constructor(private o: BackupOptions, private everyMs: number) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.everyMs);
    this.timer.unref();
  }

  runOnce() {
    if (this.running) return this.running;
    this.running = runBackup(this.o)
      .then((r) => this.o.log?.("backup verified", { object: r.key, bytes: r.bytes, pruned: r.pruned }))
      .catch(() => { /* recorded in backup_runs + audit */ })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
