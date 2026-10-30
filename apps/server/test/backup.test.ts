// W0 — off-site backups: encryption, full cycle (snapshot → upload → verify by restore → prune), restore, tamper
// detection, retention, S3 request signing (checked against AWS's published SigV4 examples) and configuration.
// No real object storage is used here: a local directory store and a fake HTTP layer stand in for it.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { makeApp } from "./helpers.js";
import { createTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";
import { decrypt, encrypt, pruneBackups, restoreBackup, runBackup, selectKept, verifyBackup } from "../src/backup/backup.js";
import { LocalDirStore, S3Store, signS3 } from "../src/backup/store.js";
import { backupSettingsFrom } from "../src/backup/config.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const key = (id = "k1") => ({ id, key: randomBytes(32) });

async function liveDb() {
  const env = await makeApp(join(tmp("sag-live-"), "live.db"));
  createTask(env.deps, { title: "Maxfiy-loyiha-Movarounnahr", agentId: "it-aziz" }, SYSTEM);
  return env;
}

describe("backup encryption", () => {
  it("round-trips, and rejects a wrong key, an unknown key id and any modified byte", () => {
    const k = key();
    const blob = encrypt(Buffer.from("sirli ma'lumot"), k);
    expect(blob.includes(Buffer.from("sirli"))).toBe(false);
    expect(decrypt(blob, [k]).toString()).toBe("sirli ma'lumot");
    expect(() => decrypt(blob, [{ id: "k1", key: randomBytes(32) }])).toThrow(/wrong key or the file was modified/);
    expect(() => decrypt(blob, [key("k2")])).toThrow(/"k1"/);
    const bad = Buffer.from(blob);
    bad[bad.length - 1] ^= 1;
    expect(() => decrypt(bad, [k])).toThrow(/modified/);
    const header = Buffer.from(blob);
    header[10] ^= 1; // inside the authenticated header (iv)
    expect(() => decrypt(header, [k])).toThrow();
  });
});

describe("backup cycle", () => {
  it("snapshot → encrypted upload → verified by restore; recorded and audited; restore writes a working database", async () => {
    const { db } = await liveDb();
    const storeDir = tmp("sag-store-");
    const store = new LocalDirStore(storeDir);
    const k = key();
    const r = await runBackup({ db, store, key: k, prefix: "office/" }, new Date("2026-10-30T10:00:00Z"));
    expect(r).toMatchObject({ key: "office/sag-20261030T100000Z.db.gz.enc", verified: true });
    const objects = (await store.list("office/")).map((o) => o.key);
    expect(objects).toEqual(["office/sag-20261030T100000Z.db.gz.enc", "office/sag-20261030T100000Z.manifest.json"]);
    const blob = readFileSync(join(storeDir, r.key));
    expect(blob.includes(Buffer.from("Maxfiy-loyiha"))).toBe(false); // encrypted before it left the machine
    expect(db.get("SELECT status, verified_at IS NOT NULL v FROM backup_runs WHERE id = ?", r.runId)).toEqual({ status: "verified", v: 1 });
    const actions = db.all<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'backup.%' ORDER BY id").map((a) => a.action);
    expect(actions).toEqual(["backup.created", "backup.verified"]);

    const target = join(tmp("sag-restore-"), "restored.db");
    const m = await restoreBackup({ store, key: k }, r.key, target);
    expect(m.counts.tasks).toBeGreaterThanOrEqual(1);
    const restored = new DatabaseSync(target, { readOnly: true });
    expect(restored.prepare("SELECT title FROM tasks WHERE title = ?").get("Maxfiy-loyiha-Movarounnahr")).toBeTruthy();
    restored.close();
    await expect(restoreBackup({ store, key: k }, r.key, target)).rejects.toThrow(/refusing to overwrite/);
  });

  it("a modified object or manifest is caught before anything is trusted; the failure is recorded", async () => {
    const { db } = await liveDb();
    const storeDir = tmp("sag-store-");
    const store = new LocalDirStore(storeDir);
    const k = key();
    const r = await runBackup({ db, store, key: k });
    const path = join(storeDir, r.key);
    const blob = readFileSync(path);
    blob[blob.length - 5] ^= 0xff;
    writeFileSync(path, blob);
    await expect(verifyBackup({ db, store, key: k }, r.key)).rejects.toThrow(/does not match its manifest/);
    // an upload that cannot be verified marks the run failed
    const broken = { ...store, describe: "broken", put: store.put.bind(store), list: store.list.bind(store), delete: store.delete.bind(store),
      get: async () => Buffer.from("garbage") };
    await expect(runBackup({ db, store: broken, key: k }, new Date("2026-10-30T11:00:00Z"))).rejects.toThrow();
    expect(db.get<{ status: string }>("SELECT status FROM backup_runs ORDER BY started_at DESC LIMIT 1")!.status).toBe("failed");
    expect(db.get("SELECT 1 FROM audit_logs WHERE action = 'backup.failed'")).toBeTruthy();
  });

  it("backups made with a retired key stay restorable when that key is configured as an old key", async () => {
    const { db } = await liveDb();
    const store = new LocalDirStore(tmp("sag-store-"));
    const old = key("k0");
    const r = await runBackup({ db, store, key: old });
    const current = key("k1");
    await expect(verifyBackup({ db, store, key: current }, r.key)).rejects.toThrow(/"k0"/);
    await expect(verifyBackup({ db, store, key: current, keys: [current, old] }, r.key)).resolves.toMatchObject({ key: "k0" });
  });
});

describe("retention", () => {
  const keys = (stamps: string[]) => stamps.map((s) => `p/sag-${s}.db.gz.enc`);

  it("keeps the newest N, then one per day, then one per month", () => {
    const all = keys([
      "20261030T120000Z", "20261030T110000Z", "20261030T100000Z", // today
      "20261029T230000Z", "20261029T080000Z", // yesterday
      "20261028T090000Z", // two days ago
      "20260930T090000Z", "20260915T090000Z", // last month
      "20260801T090000Z", // two months ago
    ]);
    const kept = [...selectKept(all, { hourly: 2, daily: 2, monthly: 2 })].sort();
    expect(kept).toEqual(keys(["20260930T090000Z", "20261029T230000Z", "20261030T110000Z", "20261030T120000Z"]).sort());
  });

  it("prune deletes expired objects and their manifests from the store", async () => {
    const { db } = await liveDb();
    const storeDir = tmp("sag-store-");
    const store = new LocalDirStore(storeDir);
    const k = key();
    for (const h of [8, 9, 10, 11]) await runBackup({ db, store, key: k, retention: { hourly: 2, daily: 0, monthly: 0 } }, new Date(`2026-10-30T${String(h).padStart(2, "0")}:00:00Z`));
    expect(readdirSync(storeDir).sort()).toEqual([
      "sag-20261030T100000Z.db.gz.enc", "sag-20261030T100000Z.manifest.json", "sag-20261030T110000Z.db.gz.enc", "sag-20261030T110000Z.manifest.json",
    ]);
    expect(await pruneBackups({ db, store, key: k, retention: { hourly: 2, daily: 0, monthly: 0 } })).toBe(0);
  });
});

describe("S3-compatible storage", () => {
  const AWS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", amzDate: "20130524T000000Z" };
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  it("signs requests exactly like AWS's published Signature V4 examples (GET object, list objects)", () => {
    const get = signS3({ ...AWS, method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" }, payloadHash: EMPTY });
    expect(get.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    const list = signS3({ ...AWS, method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/", query: { "max-keys": "2", prefix: "J" }, payloadHash: EMPTY });
    expect(list.authorization).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("uses path-style URLs, sends a signed request per operation, and never leaks the secret in errors", async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const objects = new Map<string, Buffer>();
    const http = (async (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method ?? "GET", headers });
      const u = new URL(url);
      const k = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ""));
      if (init.method === "PUT") { objects.set(k, Buffer.from(init.body as Uint8Array)); return new Response(null, { status: 200 }); }
      if (init.method === "DELETE") { objects.delete(k); return new Response(null, { status: 204 }); }
      if (u.searchParams.get("list-type") === "2")
        return new Response(`<ListBucketResult>${[...objects].filter(([n]) => n.startsWith(u.searchParams.get("prefix") ?? "")).map(([n, b]) => `<Contents><Key>${n}</Key><Size>${b.length}</Size><LastModified>2026-10-30T00:00:00Z</LastModified></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      if (k === "missing") return new Response(`<Error><Code>NoSuchKey</Code><Message>x</Message></Error>`, { status: 404 });
      return new Response(new Uint8Array(objects.get(k)!));
    }) as typeof fetch;
    const secret = "very-secret-key-123";
    const s3 = new S3Store({ endpoint: "https://s3.example.test", region: "auto", bucket: "bucket", accessKeyId: "AKID", secretAccessKey: secret }, http);
    await s3.put("office/a.bin", Buffer.from("abc"));
    expect((await s3.get("office/a.bin")).toString()).toBe("abc");
    expect((await s3.list("office/")).map((o) => o.key)).toEqual(["office/a.bin"]);
    await s3.delete("office/a.bin");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["PUT /bucket/office/a.bin", "GET /bucket/office/a.bin", "GET /bucket", "DELETE /bucket/office/a.bin"]);
    for (const c of calls) {
      expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*x-amz-date, Signature=[0-9a-f]{64}$/);
      expect(JSON.stringify(c.headers)).not.toContain(secret);
    }
    const err = await s3.get("missing").catch((e: Error) => e.message);
    expect(err).toBe("object storage GET missing failed: HTTP 404 NoSuchKey");
    await expect(s3.get("../etc/passwd")).rejects.toThrow(/invalid object key/);
  });
});

describe("backup configuration", () => {
  const good = { BACKUP_KEY: randomBytes(32).toString("base64") };

  it("is off without a target, and fails loudly (naming variables, never values) when half configured", () => {
    expect(backupSettingsFrom({}).settings).toBeNull();
    expect(() => backupSettingsFrom({ BACKUP_TARGET: "s3" })).toThrow(/BACKUP_KEY/);
    let msg = "";
    try {
      backupSettingsFrom({ ...good, BACKUP_TARGET: "s3", BACKUP_S3_SECRET_ACCESS_KEY: "s3cr3t-value" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("BACKUP_S3_ENDPOINT");
    expect(msg).not.toContain("s3cr3t-value");
    expect(() => backupSettingsFrom({ ...good, BACKUP_TARGET: "s3", BACKUP_S3_ENDPOINT: "http://plain", BACKUP_S3_REGION: "r", BACKUP_S3_BUCKET: "b", BACKUP_S3_ACCESS_KEY_ID: "a", BACKUP_S3_SECRET_ACCESS_KEY: "s" })).toThrow(/https/);
    expect(() => backupSettingsFrom({ ...good, BACKUP_TARGET: "ftp" })).toThrow(/s3.*dir/);
  });

  it("builds a schedule, retention and the key ring (current + old keys)", () => {
    const old = randomBytes(32).toString("base64");
    const r = backupSettingsFrom({ ...good, BACKUP_TARGET: "dir", BACKUP_DIR: tmp("sag-b-"), BACKUP_INTERVAL_MINUTES: "15", BACKUP_RETAIN_DAILY: "7", BACKUP_KEY_ID: "k2", BACKUP_OLD_KEYS: `k1:${old}`, BACKUP_PREFIX: "x" }).settings!;
    expect(r.everyMs).toBe(15 * 60_000);
    expect(r.retention).toEqual({ hourly: 48, daily: 7, monthly: 12 });
    expect(r.keys.map((k) => k.id)).toEqual(["k2", "k1"]);
    expect(r.prefix).toBe("x/");
  });
});

describe("readiness endpoint", () => {
  it("is public but reports only states and ages; backup age appears once a backup is verified", async () => {
    const { app, db } = await liveDb();
    const before = await app.inject({ method: "GET", url: "/api/ready" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ ok: true, database: "writable", worker: "absent", lastVerifiedBackupAgeSeconds: null });
    expect(before.json().queueLagSeconds).toBeGreaterThanOrEqual(0); // the queued task from liveDb()
    await runBackup({ db, store: new LocalDirStore(tmp("sag-store-")), key: key() });
    const after = (await app.inject({ method: "GET", url: "/api/ready" })).json();
    expect(after.lastVerifiedBackupAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(Object.keys(after).sort()).toEqual(["database", "lastVerifiedBackupAgeSeconds", "ok", "queueLagSeconds", "worker"]);
  });
});
