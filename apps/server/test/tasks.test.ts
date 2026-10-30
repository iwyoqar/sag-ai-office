import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTransitionTask, TASK_STATUSES } from "@sag/shared";
import { adminClient, makeApp } from "./helpers.js";
import { Db } from "../src/db/db.js";
import { EventBus } from "../src/lib/events.js";
import { claimNextTask, createTask, recoverExpiredLeases, transitionTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";

describe("task creation & routing", () => {
  it("auto-assigns to the least-loaded active agent of the department", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const a = (await api.post("/api/tasks", { title: "a", departmentId: "home" })).body.task;
    const b = (await api.post("/api/tasks", { title: "b", departmentId: "home" })).body.task;
    expect(a.status).toBe("QUEUED");
    expect(new Set([a.agentId, b.agentId]).size).toBe(2); // spread across Diyor and Sabina
  });

  it("explicit agent sets department; mismatched department is rejected", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    expect((await api.post("/api/tasks", { title: "x", agentId: "finance-nilufar" })).body.task.departmentId).toBe("finance");
    expect((await api.post("/api/tasks", { title: "x", agentId: "finance-nilufar", departmentId: "it" })).status).toBe(400);
  });

  it("without department or agent the Director agent orchestrates it", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const t = (await api.post("/api/tasks", { title: "big multi-department job" })).body.task;
    expect(t).toMatchObject({ kind: "orchestrate", status: "QUEUED", agentId: "director-director-ai", departmentId: "director" });
    // explicit backlog keeps it unrouted
    const b = (await api.post("/api/tasks", { title: "later", backlog: true })).body.task;
    expect(b).toMatchObject({ kind: "single", status: "BACKLOG", agentId: null });
  });

  it("validates fields", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    expect((await api.post("/api/tasks", { title: "" })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", priority: "NOW" })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", deadline: "tomorrow" })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", limits: { maxCostUsd: 5000 } })).status).toBe(400);
  });
});

describe("status lifecycle", () => {
  it("transition table matches the spec", () => {
    expect(canTransitionTask("QUEUED", "IN_PROGRESS")).toBe(true);
    expect(canTransitionTask("DONE", "QUEUED")).toBe(false);
    expect(canTransitionTask("CANCELLED", "QUEUED")).toBe(false);
    expect(canTransitionTask("FAILED", "QUEUED")).toBe(true);
    for (const s of TASK_STATUSES) expect(canTransitionTask(s, s)).toBe(false);
  });

  it("API enforces valid transitions and stamps timestamps", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const t = (await api.post("/api/tasks", { title: "x", agentId: "it-aziz" })).body.task;
    const bad = await api.post(`/api/tasks/${t.id}/transition`, { to: "DONE" });
    expect(bad.status).toBe(409);
    expect(bad.body.error.details.allowed).toContain("IN_PROGRESS");
    const run = (await api.post(`/api/tasks/${t.id}/transition`, { to: "IN_PROGRESS" })).body.task;
    expect(run.startedAt).toBeTruthy();
    const done = (await api.post(`/api/tasks/${t.id}/transition`, { to: "DONE" })).body.task;
    expect(done).toMatchObject({ status: "DONE", progress: 100 });
    expect(done.completedAt).toBeTruthy();
    expect((await api.patch(`/api/tasks/${t.id}`, { title: "late edit" })).status).toBe(409);
  });

  it("a stale writer loses (no double transition)", async () => {
    const { deps } = await makeApp();
    const t = createTask(deps, { title: "x", agentId: "it-aziz" }, SYSTEM);
    transitionTask(deps, t.id, "IN_PROGRESS", SYSTEM);
    // second writer still believes the task is QUEUED
    expect(() => transitionTask(deps, t.id, "IN_PROGRESS", SYSTEM)).toThrow(/o'tishi mumkin emas/);
  });

  it("retry and reassign", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const t = (await api.post("/api/tasks", { title: "x", agentId: "it-aziz" })).body.task;
    expect((await api.post(`/api/tasks/${t.id}/retry`)).status).toBe(409);
    await api.post(`/api/tasks/${t.id}/transition`, { to: "IN_PROGRESS" });
    await api.post(`/api/tasks/${t.id}/transition`, { to: "FAILED" });
    expect((await api.post(`/api/tasks/${t.id}/retry`)).body.task.status).toBe("QUEUED");
    const r = (await api.post(`/api/tasks/${t.id}/reassign`, { agentId: "digital-anvar" })).body.task;
    expect(r).toMatchObject({ agentId: "digital-anvar", departmentId: "digital", status: "QUEUED" });
  });

  it("cancel cascades to open subtasks only", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const parent = (await api.post("/api/tasks", { title: "p", agentId: "director-director-ai" })).body.task;
    const s1 = (await api.post("/api/tasks", { title: "s1", agentId: "marketing-madina", parentId: parent.id })).body.task;
    const s2 = (await api.post("/api/tasks", { title: "s2", agentId: "finance-nilufar", parentId: parent.id })).body.task;
    await api.post(`/api/tasks/${s2.id}/transition`, { to: "IN_PROGRESS" });
    await api.post(`/api/tasks/${s2.id}/transition`, { to: "DONE" });
    await api.post(`/api/tasks/${parent.id}/cancel`);
    expect((await api.get(`/api/tasks/${s1.id}`)).body.task.status).toBe("CANCELLED");
    expect((await api.get(`/api/tasks/${s2.id}`)).body.task.status).toBe("DONE");
    const detail = (await api.get(`/api/tasks/${parent.id}`)).body;
    expect(detail.subtasks).toHaveLength(2);
    expect(detail.events.map((e: { type: string }) => e.type)).toContain("task.status");
  });
});

describe("dependencies", () => {
  it("waits for dependencies and is released when they are done", async () => {
    const { app } = await makeApp();
    const api = await adminClient(app);
    const finance = (await api.post("/api/tasks", { title: "budget", agentId: "finance-sherzod" })).body.task;
    const strategy = (await api.post("/api/tasks", { title: "strategy", agentId: "marketing-madina", dependsOn: [finance.id] })).body.task;
    expect(strategy).toMatchObject({ status: "WAITING_FOR_DEPENDENCY", dependsOn: [finance.id] });
    await api.post(`/api/tasks/${finance.id}/transition`, { to: "IN_PROGRESS" });
    await api.post(`/api/tasks/${finance.id}/transition`, { to: "DONE" });
    expect((await api.get(`/api/tasks/${strategy.id}`)).body.task.status).toBe("QUEUED");
  });

  it("rejects cycles and unknown dependencies", async () => {
    const { deps } = await makeApp();
    const { assertNoCycle } = await import("../src/domain/tasks.js");
    const a = createTask(deps, { title: "a", agentId: "it-aziz" }, SYSTEM);
    const b = createTask(deps, { title: "b", agentId: "it-aziz", dependsOn: [a.id] }, SYSTEM);
    expect(() => assertNoCycle(deps, a.id, [b.id])).toThrow(/halqa/);
    expect(() => createTask(deps, { title: "c", agentId: "it-aziz", dependsOn: ["tsk_missing"] }, SYSTEM)).toThrow(/topilmadi/);
  });
});

describe("worker claim (parallel safety)", () => {
  it("never hands the same task to two workers, even across connections", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sag-")), "claim.db");
    const { deps } = await makeApp(path);
    // one task per agent (an agent only ever holds one task in progress)
    const agents = deps.db.all<{ id: string }>("SELECT id FROM agents ORDER BY id LIMIT 20");
    for (const [i, a] of agents.entries()) createTask(deps, { title: `t${i}`, agentId: a.id }, SYSTEM);
    // two independent connections = two worker processes
    const c1 = { db: new Db(path), bus: new EventBus(deps.db) };
    const c2 = { db: new Db(path), bus: new EventBus(deps.db) };
    const got: string[] = [];
    for (let i = 0; i < 15; i++) {
      for (const c of [c1, c2]) {
        const t = claimNextTask(c, "w", 60_000);
        if (t) got.push(t.id);
      }
    }
    expect(got).toHaveLength(20);
    expect(new Set(got).size).toBe(20);
    expect(claimNextTask(c1, "w", 60_000)).toBeNull();
  });

  it("respects priority, paused agents and dependencies", async () => {
    const { deps } = await makeApp();
    const low = createTask(deps, { title: "low", agentId: "it-aziz", priority: "LOW" }, SYSTEM);
    const urgent = createTask(deps, { title: "urgent", agentId: "it-malika", priority: "URGENT" }, SYSTEM);
    const paused = createTask(deps, { title: "paused", agentId: "it-jasur", priority: "URGENT" }, SYSTEM);
    deps.db.run("UPDATE agents SET lifecycle = 'PAUSED' WHERE id = 'it-jasur'");
    createTask(deps, { title: "dep", agentId: "it-nodira", priority: "URGENT", dependsOn: [low.id] }, SYSTEM);
    createTask(deps, { title: "second for busy agent", agentId: "it-malika", priority: "URGENT" }, SYSTEM);
    expect(claimNextTask(deps, "w", 60_000)!.id).toBe(urgent.id);
    expect(claimNextTask(deps, "w", 60_000)!.id).toBe(low.id);
    // dep not done, paused agent skipped, it-malika already busy
    expect(claimNextTask(deps, "w", 60_000)).toBeNull();
    expect(paused.status).toBe("QUEUED");
  });

  it("re-queues work whose lease expired (crash recovery)", async () => {
    const { deps } = await makeApp();
    const t = createTask(deps, { title: "x", agentId: "it-aziz" }, SYSTEM);
    claimNextTask(deps, "w", -1000); // already expired
    // the crashed worker left an AI call open in the log
    deps.db.run("INSERT INTO agent_runs (id, task_id, agent_id, correlation_id, model, status, started_at) VALUES ('run_x', ?, 'it-aziz', 'c', 'm', 'running', ?)", t.id, new Date().toISOString());
    expect(recoverExpiredLeases(deps)).toEqual([t.id]);
    expect(deps.db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", t.id)!.status).toBe("QUEUED");
    expect(deps.db.get("SELECT status FROM agent_runs WHERE id = 'run_x'")).toEqual({ status: "failed" });
  });
});
