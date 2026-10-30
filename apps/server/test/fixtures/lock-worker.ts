// Worker for the busy-timeout test: another connection (like a second process) takes the write lock, signals that
// it holds it, keeps it for `holdMs`, then commits.
import { parentPort, workerData } from "node:worker_threads";
import { Db } from "../../src/db/db.js";

const { dbPath, holdMs, flag } = workerData as { dbPath: string; holdMs: number; flag: SharedArrayBuffer };
const db = new Db(dbPath);
const f = new Int32Array(flag);
db.raw.exec("BEGIN IMMEDIATE");
db.run("UPDATE settings SET value = 'held' WHERE key = 'lock-test'");
Atomics.store(f, 0, 1);
Atomics.notify(f, 0);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs); // hold the lock
db.raw.exec("COMMIT");
db.close();
parentPort!.postMessage({ ok: true });
