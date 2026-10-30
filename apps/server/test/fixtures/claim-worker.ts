// Worker for the concurrent-claim test: its own database connection (like a second worker process on the same host)
// claims queued tasks as fast as it can, starting at the same moment as the other workers (shared barrier).
import { parentPort, workerData } from "node:worker_threads";
import { Db } from "../../src/db/db.js";
import { EventBus } from "../../src/lib/events.js";
import { claimNextTask } from "../../src/domain/tasks.js";

const { dbPath, workerId, barrier, workers } = workerData as { dbPath: string; workerId: string; barrier: SharedArrayBuffer; workers: number };
const db = new Db(dbPath);
const ctx = { db, bus: new EventBus(db) };
const flag = new Int32Array(barrier);
Atomics.add(flag, 0, 1);
while (Atomics.load(flag, 0) < workers) Atomics.wait(flag, 0, Atomics.load(flag, 0), 5);
const claimed: { id: string; epoch: number }[] = [];
try {
  for (let idle = 0; idle < 20; ) {
    const t = claimNextTask(ctx, workerId, 60_000);
    if (!t) { idle++; continue; }
    idle = 0;
    claimed.push({ id: t.id, epoch: t.leaseEpoch });
    // finish it at once so the agent can take its next task (one task per agent at a time)
    db.run("UPDATE tasks SET status = 'DONE', lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?", t.id, workerId);
  }
  parentPort!.postMessage({ ok: true, claimed });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message, claimed });
} finally {
  db.close();
}
