// Worker for the concurrency test: its own database connection submits one subtask at the same moment as another
// worker submits a sibling. Both wait on a shared barrier so the transactions really race.
import { parentPort, workerData } from "node:worker_threads";
import { Db } from "../../src/db/db.js";
import { EventBus } from "../../src/lib/events.js";
import { loadUser } from "../../src/lib/auth.js";
import { submitWork } from "../../src/domain/work.js";

const { dbPath, userId, taskId, barrier } = workerData as { dbPath: string; userId: string; taskId: string; barrier: SharedArrayBuffer };
const db = new Db(dbPath);
const ctx = { db, bus: new EventBus(db) };
const flag = new Int32Array(barrier);
Atomics.add(flag, 0, 1);
while (Atomics.load(flag, 0) < 2) Atomics.wait(flag, 0, Atomics.load(flag, 0), 5);
try {
  submitWork(ctx, loadUser(db, userId)!, taskId, "tayyor");
  parentPort!.postMessage({ ok: true });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
} finally {
  db.close();
}
