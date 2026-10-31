import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Db } from "../src/db/db.js";
import { seed } from "../src/db/seed.js";
import { redact } from "../src/lib/audit.js";

describe("database & migrations", () => {
  it("applies migrations once and is idempotent", () => {
    const db = new Db(":memory:");
    expect(db.migrate()).toEqual(["001_init.sql", "002_agent_workstation.sql", "003_runtime.sql", "004_brain_telegram.sql", "005_schedule_users.sql", "006_embeddings.sql", "007_people_workflow.sql", "008_employee_desk.sql", "009_connector_actions.sql", "010_org_tree.sql", "011_sensitive_permissions.sql", "012_execution_reliability.sql", "013_login_throttle.sql", "014_backups.sql", "015_w1_foundation.sql", "016_integration_hub.sql", "017_agent_marketplace.sql", "018_ai_director.sql", "019_ai_task_permission.sql", "020_unit_world_placement.sql", "021_dependency_unit_guard.sql"]);
    expect(db.migrate()).toEqual([]);
  });

  it("seeds the organisation once", async () => {
    const db = new Db(":memory:");
    db.migrate();
    const r = await seed(db);
    expect(r.seeded).toBe(true);
    expect(r.admin?.generated).toBe(true);
    expect((await seed(db)).seeded).toBe(false);
    const n = (t: string) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)!.n;
    expect(n("floors")).toBe(7);
    expect(n("departments")).toBe(12);
    expect(n("agents")).toBe(46);
    expect(n("connectors")).toBe(23); // 19 + gemini, anthropic, bitrix24, sap (W2.1 catalog; not connected)
    // honest initial state: nothing connected, every agent idle, no tasks
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM connectors WHERE status <> 'disconnected'")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE status <> 'IDLE'")!.n).toBe(0);
    expect(n("tasks")).toBe(0);
  });

  it("enforces foreign keys, checks and unique constraints", async () => {
    const db = new Db(":memory:");
    db.migrate();
    await seed(db);
    const t = new Date().toISOString();
    expect(() =>
      db.run("INSERT INTO agents (id, name, role, department_id, created_at, updated_at) VALUES ('x','x','x','nope',?,?)", t, t),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.run("INSERT INTO agents (id, name, role, department_id, status, created_at, updated_at) VALUES ('y','y','y','it','DANCING',?,?)", t, t),
    ).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO floors (id, level, title) VALUES ('Z', 1, 'dup level')")).toThrow(/UNIQUE/);
    expect(() =>
      db.run("INSERT INTO routine_runs (id, routine_id, scheduled_for, status, started_at) VALUES ('a','missing',?, 'running', ?)", t, t),
    ).toThrow(/FOREIGN KEY/);
  });

  it("persists across reopen (server restart)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sag-")), "t.db");
    const a = new Db(path);
    a.migrate();
    await seed(a, { adminPassword: "x" });
    a.close();
    const b = new Db(path);
    expect(b.migrate()).toEqual([]);
    expect(b.get<{ n: number }>("SELECT COUNT(*) n FROM agents")!.n).toBe(46);
    b.close();
  });

  it("transactions roll back on error", () => {
    const db = new Db(":memory:");
    db.migrate();
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO roles (id) VALUES ('temp')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.get("SELECT id FROM roles WHERE id = 'temp'")).toBeUndefined();
  });
});

describe("audit redaction", () => {
  it("removes secret-looking fields at any depth", () => {
    expect(redact({ password: "p", nested: { apiKey: "k", ok: 1 }, list: [{ token: "t" }] })).toEqual({
      password: "[redacted]", nested: { apiKey: "[redacted]", ok: 1 }, list: [{ token: "[redacted]" }],
    });
  });
});

describe("SQLite reliability", () => {
  const fileDb = () => {
    const path = join(mkdtempSync(join(tmpdir(), "sag-lock-")), "lock.db");
    const db = new Db(path);
    db.migrate();
    db.run("INSERT INTO settings (key, value, updated_at) VALUES ('lock-test', 'free', ?)", new Date().toISOString());
    return { path, db };
  };
  const holdLock = (path: string, holdMs: number) => {
    const flag = new SharedArrayBuffer(4);
    const done = new Promise((res, rej) => {
      const w = new Worker(new URL("./fixtures/lock-worker.mjs", import.meta.url), { workerData: { dbPath: path, holdMs, flag } });
      w.once("message", res);
      w.once("error", rej);
    });
    const held = new Int32Array(flag);
    // wait (blocking, bounded) until the other connection really holds the write lock
    for (let i = 0; i < 400 && Atomics.load(held, 0) === 0; i++) Atomics.wait(held, 0, 0, 25);
    expect(Atomics.load(held, 0)).toBe(1);
    return done;
  };

  it("a writer waits for another connection's write lock (busy_timeout) instead of failing", async () => {
    const { path, db } = fileDb();
    const done = holdLock(path, 300);
    const started = Date.now();
    db.tx(() => db.run("UPDATE settings SET value = 'mine' WHERE key = 'lock-test'"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(150); // it waited for the lock…
    await done;
    expect(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'lock-test'")!.value).toBe("mine"); // …then wrote after it
    db.close();
  }, 20_000);

  it("past busy_timeout the write fails loudly (database is locked) and leaves no open transaction", async () => {
    const { path, db } = fileDb();
    const impatient = new Db(path, { busyTimeoutMs: 20 });
    const done = holdLock(path, 600);
    expect(() => impatient.tx(() => impatient.run("UPDATE settings SET value = 'x' WHERE key = 'lock-test'"))).toThrow(/locked|busy/i);
    expect(impatient.raw.isTransaction).toBe(false);
    await done;
    impatient.tx(() => impatient.run("UPDATE settings SET value = 'later' WHERE key = 'lock-test'")); // fine once free
    impatient.close();
    db.close();
  }, 20_000);

  it("rejects an async transaction body (it would commit before its awaits) and rolls back", () => {
    const db = new Db(":memory:");
    db.migrate();
    expect(() =>
      db.tx(async () => {
        db.run("INSERT INTO settings (key, value, updated_at) VALUES ('async', '1', 'x')");
        await Promise.resolve();
      }),
    ).toThrow(/synchronous/);
    expect(db.get("SELECT 1 FROM settings WHERE key = 'async'")).toBeUndefined();
    expect(db.raw.isTransaction).toBe(false);
  });

  it("reports slow write transactions and closes idempotently", () => {
    const db = new Db(":memory:");
    db.migrate();
    const slow: number[] = [];
    db.slowTxMs = 0;
    db.onSlowTx = (ms) => slow.push(ms);
    db.tx(() => {
      const end = Date.now() + 5;
      while (Date.now() < end) { /* hold the lock briefly */ }
    });
    expect(slow).toHaveLength(1);
    db.close();
    db.close();
  });
});
