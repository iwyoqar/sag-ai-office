// W0 — reliable agent execution: heartbeat leases, fencing of runs that lost their lease, graceful stop, startup
// recovery of abandoned work, attempt limits after repeated crashes, and concurrent claiming from several
// database connections. All LLM calls use the MockLlm test double.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { makeApp } from "./helpers.js";
import { AgentRunner } from "../src/agents/runner.js";
import { MockLlm } from "../src/llm/mock.js";
import { LlmError } from "../src/llm/types.js";
import { claimNextTask, createTask, getTask, recoverExpiredLeases, renewLease } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";
import type { Deps } from "../src/app.js";

const pricing = { inputPerM: 0.3, outputPerM: 2.5 };
// pollMs is long on purpose: the tests drive tick() themselves; start() is used only for heartbeats and recovery
const base = { concurrency: 3, pollMs: 3_600_000, taskTimeoutMs: 5000, retryDelayMs: 1, settleMs: 5 };

function gate<T>() {
  let open!: (v: T) => void;
  const p = new Promise<T>((r) => (open = r));
  return { p, open };
}
/** An LLM call that ends only when aborted (like a slow request cancelled by stop/cancel/lost lease). */
const untilAborted = (req: { signal?: AbortSignal }) =>
  new Promise<string>((_, rej) => req.signal?.addEventListener("abort", () => rej(new LlmError("Bekor qilindi", "aborted", false))));
const n = (d: Deps, sql: string, ...p: string[]) => d.db.get<{ n: number }>(sql, ...p)!.n;
const runsOf = (d: Deps, taskId: string) =>
  d.db.all<{ status: string; end_reason: string | null; worker_id: string | null; lease_epoch: number | null }>(
    "SELECT status, end_reason, worker_id, lease_epoch FROM agent_runs WHERE task_id = ? ORDER BY started_at", taskId,
  );

async function drain(r: AgentRunner, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    const started = r.tick();
    if (!started.length && r.activeCount === 0) return;
    await Promise.all(started);
  }
}

describe("leases: heartbeat and fencing", () => {
  it("a run longer than its lease keeps it through heartbeats and finishes exactly once", async () => {
    const { deps } = await makeApp();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "clearTimeout", "Date"] });
    try {
      const llm = new MockLlm(() => new Promise<string>((res) => setTimeout(() => res("## Uzoq ish natijasi"), 1_000)));
      const r = new AgentRunner(deps, llm, pricing, { ...base, leaseMs: 120, heartbeatMs: 30 });
      r.start();
      const t = createTask(deps, { title: "Uzoq vazifa", agentId: "it-aziz" }, SYSTEM);
      const started = r.tick();
      await vi.advanceTimersByTimeAsync(600); // five lease lengths later the lease is still alive
      expect(recoverExpiredLeases(deps)).toEqual([]);
      expect(getTask(deps, t.id).status).toBe("IN_PROGRESS");
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all(started);
      await r.stop();
      expect(getTask(deps, t.id).status).toBe("DONE");
      expect(runsOf(deps, t.id)).toEqual([{ status: "succeeded", end_reason: "succeeded", worker_id: r.workerId, lease_epoch: 1 }]);
      expect(n(deps, "SELECT COUNT(*) n FROM deliverables WHERE task_id = ?", t.id)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a run whose lease expired and was re-run elsewhere cannot write its late result (no duplicate deliverable)", async () => {
    const { deps } = await makeApp();
    const slow = gate<string>();
    const llmA = new MockLlm(() => slow.p);
    const a = new AgentRunner(deps, llmA, pricing, { ...base, leaseMs: 60_000 }); // never started: no heartbeat (a hung worker)
    const t = createTask(deps, { title: "Hisobot", agentId: "it-aziz" }, SYSTEM);
    const runA = a.tick();
    await vi.waitFor(() => expect(llmA.calls).toHaveLength(1));
    // the lease runs out while A hangs, and recovery hands the task to another worker
    deps.db.run("UPDATE tasks SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?", t.id);
    expect(recoverExpiredLeases(deps)).toEqual([t.id]);
    const bGate = gate<string>();
    const llmB = new MockLlm(() => bGate.p);
    const b = new AgentRunner(deps, llmB, pricing, base);
    const runB = b.tick();
    await vi.waitFor(() => expect(llmB.calls).toHaveLength(1));
    // A wakes up with its stale answer while B holds the task (same status, same agent — only the lease differs)
    slow.open("## A kechikkan natijasi");
    await Promise.all(runA);
    expect(n(deps, "SELECT COUNT(*) n FROM deliverables WHERE task_id = ?", t.id)).toBe(0);
    expect(getTask(deps, t.id).status).toBe("IN_PROGRESS");
    bGate.open("## B natijasi");
    await Promise.all(runB);
    const dl = deps.db.all<{ content: string }>("SELECT content FROM deliverables WHERE task_id = ?", t.id);
    expect(dl.map((x) => x.content.split("\n")[0])).toEqual(["## B natijasi"]);
    expect(getTask(deps, t.id).status).toBe("DONE");
    expect(renewLease(deps, { taskId: t.id, workerId: a.workerId, epoch: 1 }, 1000)).toBe(false);
    // both runs are on record, each with the claim it belonged to
    expect(runsOf(deps, t.id).map((r) => [r.worker_id, r.lease_epoch])).toEqual([[a.workerId, 1], [b.workerId, 2]]);
  });

  it("the heartbeat notices a lost lease and aborts the run without touching the task", async () => {
    const { deps } = await makeApp();
    const llm = new MockLlm(untilAborted);
    const r = new AgentRunner(deps, llm, pricing, { ...base, leaseMs: 60_000, heartbeatMs: 10 });
    r.start();
    const t = createTask(deps, { title: "Tahlil", agentId: "hr-gavhar" }, SYSTEM);
    const started = r.tick();
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
    deps.db.run("UPDATE tasks SET lease_epoch = lease_epoch + 1 WHERE id = ?", t.id); // someone else holds it now
    await Promise.all(started);
    await r.stop();
    expect(runsOf(deps, t.id)[0]).toMatchObject({ status: "cancelled", end_reason: "lost_lease" });
    expect(getTask(deps, t.id).status).toBe("IN_PROGRESS"); // not failed, not overwritten: the new holder decides
  });
});

describe("worker lifecycle: stop, restart, crash", () => {
  it("graceful stop hands leased work back to the queue at once; the next worker finishes it", async () => {
    const { deps } = await makeApp();
    const llm = new MockLlm(untilAborted);
    const a = new AgentRunner(deps, llm, pricing, base);
    a.start();
    const t = createTask(deps, { title: "Deploy paytida", agentId: "it-aziz" }, SYSTEM);
    a.tick();
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
    await a.stop();
    expect(getTask(deps, t.id)).toMatchObject({ status: "QUEUED", attempts: 0 }); // the stop did not cost an attempt
    expect(runsOf(deps, t.id)[0]).toMatchObject({ status: "cancelled", end_reason: "shutdown" });
    expect(n(deps, "SELECT COUNT(*) n FROM worker_heartbeats WHERE worker_id = ?", a.workerId)).toBe(0);
    await a.stop(); // idempotent
    const b = new AgentRunner(deps, new MockLlm("## Tayyor"), pricing, base);
    await drain(b);
    expect(getTask(deps, t.id).status).toBe("DONE");
    expect(n(deps, "SELECT COUNT(*) n FROM deliverables WHERE task_id = ?", t.id)).toBe(1);
  });

  it("startup recovers tasks of dead workers immediately (no waiting for an old 15-minute lease), not of live ones", async () => {
    const { deps } = await makeApp();
    const dead = createTask(deps, { title: "Yetim vazifa", agentId: "it-aziz" }, SYSTEM);
    const live = createTask(deps, { title: "Tirik ishchida", agentId: "hr-gavhar" }, SYSTEM);
    expect(claimNextTask(deps, "w-crashed", 15 * 60_000)?.id).toBe(dead.id);
    expect(claimNextTask(deps, "w-alive", 15 * 60_000)?.id).toBe(live.id);
    const t0 = new Date().toISOString();
    deps.db.run("INSERT INTO worker_heartbeats VALUES ('w-alive', 1, 'h', ?, ?)", t0, t0);
    deps.db.run(
      "INSERT INTO agent_runs (id, task_id, agent_id, correlation_id, model, mode, status, started_at) VALUES ('run_old', ?, 'it-aziz', 'c', 'm', 'mock', 'running', ?)",
      dead.id, t0,
    );
    deps.db.run("UPDATE agents SET status = 'WORKING' WHERE id = 'finance-nilufar'"); // shown busy, nothing running
    const r = new AgentRunner(deps, new MockLlm("## Tiklandi"), pricing, base);
    r.start();
    expect(getTask(deps, dead.id).status).toBe("QUEUED");
    expect(getTask(deps, live.id).status).toBe("IN_PROGRESS");
    expect(deps.db.get("SELECT status, end_reason FROM agent_runs WHERE id = 'run_old'")).toEqual({ status: "failed", end_reason: "orphaned" });
    expect(deps.db.get<{ status: string }>("SELECT status FROM agents WHERE id = 'finance-nilufar'")!.status).toBe("IDLE");
    await drain(r);
    await r.stop();
    expect(getTask(deps, dead.id).status).toBe("DONE");
  });

  it("a task that keeps crashing its worker fails after its attempts instead of looping", async () => {
    const { deps } = await makeApp();
    const t = createTask(deps, { title: "Zaharli vazifa", agentId: "it-aziz", maxAttempts: 2 }, SYSTEM);
    for (const w of ["w-1", "w-2"]) {
      expect(claimNextTask(deps, w, 60_000)?.id).toBe(t.id);
      deps.db.run("UPDATE tasks SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?", t.id); // the worker died
      expect(recoverExpiredLeases(deps)).toEqual([t.id]);
    }
    expect(getTask(deps, t.id)).toMatchObject({ status: "FAILED" });
    expect(getTask(deps, t.id).error).toContain("2 marta");
  });

  it("concurrent workers on separate connections never claim the same task twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sag-claim-"));
    const path = join(dir, "claim.db");
    const { deps, db } = await makeApp(path);
    const agents = db.all<{ id: string }>("SELECT id FROM agents WHERE lifecycle = 'ACTIVE' ORDER BY id LIMIT 6").map((a) => a.id);
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) ids.push(createTask(deps, { title: `Ish ${i}`, agentId: agents[i % agents.length] }, SYSTEM).id);
    const workers = 3;
    const barrier = new SharedArrayBuffer(4);
    const results = await Promise.all(
      Array.from({ length: workers }, (_, k) => new Promise<{ ok: boolean; error?: string; claimed: { id: string; epoch: number }[] }>((res, rej) => {
        const w = new Worker(new URL("./fixtures/claim-worker.mjs", import.meta.url), { workerData: { dbPath: path, workerId: `w-${k}`, barrier, workers } });
        w.once("message", res);
        w.once("error", rej);
      })),
    );
    expect(results.every((r) => r.ok), JSON.stringify(results.map((r) => r.error))).toBe(true);
    const claimed = results.flatMap((r) => r.claimed.map((c) => c.id));
    expect(new Set(claimed).size).toBe(claimed.length); // no duplicates
    expect(claimed.sort()).toEqual([...ids].sort()); // and nothing lost
    expect(n(deps, "SELECT COUNT(*) n FROM tasks WHERE status = 'DONE' AND lease_epoch = 1")).toBe(24);
    db.close();
  }, 30_000);
});
