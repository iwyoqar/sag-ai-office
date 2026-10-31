// T1 Unified Task Engine (WORK_MANAGEMENT_ROADMAP.md): one task and assignment model for people and AI agents,
// validated lifecycle, assignment rules, optimistic concurrency, idempotent creation and unit isolation. Every AI
// run here is a test double; nothing claims real AI execution.
import { describe, expect, it } from "vitest";
import { adminClient, client, loginCookie, makeApp } from "./helpers.js";
import { claimNextTask, createTask, transitionTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";
import { provisionStoreUnit } from "../src/domain/units.js";

const PW = "Str0ng-pass-123";
const T = () => new Date().toISOString();

async function org() {
  const env = await makeApp();
  const admin = await adminClient(env.app);
  const mk = async (username: string, roles: string[], departmentId: string) => {
    const r = await admin.post("/api/employees", { username, displayName: username, password: PW, roles, departmentId, jobTitle: username });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.employee.id as string;
  };
  const ids = {
    dir: await mk("dir", ["director"], "director"),
    head: await mk("m.head", ["employee"], "marketing"),
    e1: await mk("m.e1", ["employee"], "marketing"),
    e2: await mk("m.e2", ["employee"], "marketing"),
    rev: await mk("m.rev", ["employee"], "marketing"),
    fEmp: await mk("f.emp", ["employee"], "finance"),
    gone: await mk("m.gone", ["employee"], "marketing"),
  };
  expect((await admin.put("/api/departments/marketing/head", { userId: ids.head })).status).toBe(200);
  expect((await admin.post(`/api/employees/${ids.gone}/status`, { status: "inactive" })).status).toBe(200);
  const login = async (u: string) => client(env.app, await loginCookie(env.app, u, PW));
  return { ...env, admin, ids, login };
}

type Api = Awaited<ReturnType<Awaited<ReturnType<typeof org>>["login"]>>;
const engine = async (api: Api, id: string) => (await api.get(`/api/tasks/${id}/engine`)).body;
const move = (api: Api, id: string, to: string, extra: object = {}) => api.post(`/api/tasks/${id}/lifecycle`, { to, ...extra });
const owners = (v: { assignments: { role: string; state: string; assigneeId: string }[] }) =>
  v.assignments.filter((a) => a.role === "OWNER" && (a.state === "ASSIGNED" || a.state === "ACCEPTED")).map((a) => a.assigneeId).sort();

describe("T1: one task model, one assignment model", () => {
  it("human and AI tasks both get a lifecycle, assignments mirrored from the legacy columns and a logged creation", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const h = (await head.post("/api/work", { title: "Banner matni", assigneeId: c.ids.e1 })).body.task;
    expect(h).toMatchObject({ kind: "human", lifecycle: "ASSIGNED", status: "ASSIGNED" });
    const hv = await engine(head, h.id);
    expect(hv.assignments.map((a: { assigneeType: string; role: string; state: string }) => [a.assigneeType, a.role, a.state]))
      .toEqual(expect.arrayContaining([["HUMAN", "OWNER", "ASSIGNED"], ["HUMAN", "REVIEWER", "ASSIGNED"]]));
    expect(hv.transitions.at(-1)).toMatchObject({ from: null, to: "ASSIGNED", actor: `user:${c.ids.head}` });

    const ai = (await head.post("/api/tasks", { title: "Raqobatchilar tahlili", agentId: "marketing-javohir" })).body.task;
    expect(ai).toMatchObject({ kind: "single", lifecycle: "ASSIGNED", status: "QUEUED" });
    const av = await engine(head, ai.id);
    expect(av.assignments).toEqual([expect.objectContaining({ assigneeType: "AI_AGENT", assigneeId: "marketing-javohir", role: "OWNER", state: "ACCEPTED" })]);
  });

  it("assignment types and roles: co-owners, AI contributor and reviewer; AI never owns a person's task or approves", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const h = (await head.post("/api/work", { title: "Kampaniya", assigneeId: c.ids.e1, requiresReview: false })).body.task;
    const add = (body: object) => head.post(`/api/tasks/${h.id}/assignments`, body);
    expect((await add({ assigneeType: "HUMAN", assigneeId: c.ids.e2, role: "OWNER" })).status).toBe(200); // several owners
    expect((await add({ assigneeType: "AI_AGENT", assigneeId: "marketing-javohir", role: "CONTRIBUTOR" })).status).toBe(200);
    expect((await add({ assigneeType: "AI_AGENT", assigneeId: "marketing-javohir", role: "REVIEWER" })).status).toBe(200); // advisory
    expect((await add({ assigneeType: "AI_AGENT", assigneeId: "marketing-javohir", role: "APPROVER" })).status).toBe(400);
    expect((await add({ assigneeType: "AI_AGENT", assigneeId: "marketing-javohir", role: "OWNER" })).status).toBe(400);
    expect(owners(await engine(head, h.id))).toEqual([c.ids.e1, c.ids.e2].sort());
    // the database refuses an AI approver whoever writes it
    expect(() => c.db.run(
      "INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, agent_id, role, assigned_at) VALUES ('x', ?, 'hq', 'AI_AGENT', 'marketing-javohir', 'APPROVER', ?)", h.id, T(),
    )).toThrow(/CHECK/);
    // a co-owner sees and works on the task through the assignment
    const e2 = await c.login("m.e2");
    expect((await e2.get(`/api/work/${h.id}`)).status).toBe(200);
  });

  it("invalid, inactive, duplicate and unauthorised assignments are refused", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const h = (await head.post("/api/work", { title: "Hisobot", assigneeId: c.ids.e1 })).body.task;
    const add = (api: Api, body: object) => api.post(`/api/tasks/${h.id}/assignments`, body);
    expect((await add(head, { assigneeType: "HUMAN", assigneeId: "usr_yoq", role: "CONTRIBUTOR" })).status).toBe(404);
    expect((await add(head, { assigneeType: "HUMAN", assigneeId: c.ids.gone, role: "CONTRIBUTOR" })).status).toBe(400); // inactive
    c.db.run("UPDATE agents SET lifecycle = 'PAUSED' WHERE id = 'marketing-dildora'");
    expect((await add(head, { assigneeType: "AI_AGENT", assigneeId: "marketing-dildora", role: "CONTRIBUTOR" })).status).toBe(400);
    const dup = await add(head, { assigneeType: "HUMAN", assigneeId: c.ids.e1, role: "OWNER" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("duplicate_assignment");
    // an owner never reviews their own work
    expect((await add(head, { assigneeType: "HUMAN", assigneeId: c.ids.e1, role: "REVIEWER" })).status).toBe(400);
    // only the owner of the work assigns; a head only within their departments (people and agents)
    expect((await add(await c.login("m.e2"), { assigneeType: "HUMAN", assigneeId: c.ids.e2, role: "OWNER" })).status).toBe(404); // cannot even see it
    expect((await add(await c.login("m.e1"), { assigneeType: "HUMAN", assigneeId: c.ids.e2, role: "CONTRIBUTOR" })).status).toBe(403); // assignee, not owner of the work
    expect((await add(head, { assigneeType: "HUMAN", assigneeId: c.ids.fEmp, role: "CONTRIBUTOR" })).status).toBe(403);
    expect((await add(head, { assigneeType: "AI_AGENT", assigneeId: "finance-nilufar", role: "CONTRIBUTOR" })).status).toBe(403);
  });

  it("cross-unit: franchise people, agents and tasks are out of reach (route, domain and database)", async () => {
    const c = await org();
    const region = c.db.get<{ id: string }>("SELECT id FROM org_nodes WHERE level = 'REGION' LIMIT 1")!.id;
    const { unitId } = provisionStoreUnit(c.deps, {
      provisionKey: "t1-store", regionId: region, name: "T1 diler", sourceLabel: "test", businessType: "INDEPENDENT_DEALER",
      ownershipModel: "FRANCHISE", sourceBrand: "HOME_DESIGN", sourceMarker: "F", importBatchId: null,
    });
    const storeAgent = c.db.get<{ id: string }>("SELECT id FROM agents WHERE business_unit_id = ? LIMIT 1", unitId)!.id;
    c.db.run("INSERT INTO users (id, username, display_name, password_hash, created_at, home_unit_id) VALUES ('usr_store', 't1.store', 'Diler', 'x', ?, ?)", T(), unitId);
    c.db.run("INSERT INTO tasks (id, business_unit_id, kind, title, status, created_at, updated_at) VALUES ('t_unit', ?, 'single', 'Diler ishi', 'BACKLOG', ?, ?)", unitId, T(), T());
    const dir = await c.login("dir");
    const h = (await dir.post("/api/work", { title: "HQ ishi", assigneeId: c.ids.e1 })).body.task;
    expect((await dir.post(`/api/tasks/${h.id}/assignments`, { assigneeType: "HUMAN", assigneeId: "usr_store", role: "CONTRIBUTOR" })).status).toBe(403);
    const ai = (await dir.post("/api/tasks", { title: "HQ AI", agentId: "marketing-javohir" })).body.task;
    expect((await dir.post(`/api/tasks/${ai.id}/assignments`, { assigneeType: "AI_AGENT", assigneeId: storeAgent, role: "CONTRIBUTOR" })).status).toBe(403);
    for (const path of ["engine"]) expect((await dir.get(`/api/tasks/t_unit/${path}`)).status).toBe(404);
    expect((await move(dir, "t_unit", "CANCELLED")).status).toBe(404);
    expect(() => c.db.run(
      "INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, role, assigned_at) VALUES ('y', ?, 'hq', 'HUMAN', 'usr_store', 'CONTRIBUTOR', ?)", h.id, T(),
    )).toThrow(/cross_unit/);
  });
});

describe("T1: validated lifecycle", () => {
  it("a person's task end to end: assign → accept → start → review → revision → approve → complete, every step logged", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "Taqdimot", departmentId: "marketing", assigneeId: null })).body.task;
    expect(t.lifecycle).toBe("BACKLOG");
    expect((await move(head, t.id, "PLANNED")).body.task.lifecycle).toBe("PLANNED");
    expect((await move(head, t.id, "ASSIGNED")).status).toBe(409); // no owner yet
    await head.post(`/api/tasks/${t.id}/assignments`, { assigneeType: "HUMAN", assigneeId: c.ids.e1, role: "OWNER" });
    await head.post(`/api/tasks/${t.id}/assignments`, { assigneeType: "HUMAN", assigneeId: c.ids.rev, role: "APPROVER" });
    const e1 = await c.login("m.e1");
    let v = await engine(e1, t.id);
    expect(v.task.lifecycle).toBe("ASSIGNED");
    const mine = v.assignments.find((a: { assigneeId: string; role: string }) => a.assigneeId === c.ids.e1 && a.role === "OWNER");
    expect((await e1.post(`/api/tasks/${t.id}/assignments/${mine.id}/accept`)).status).toBe(200);
    expect((await move(e1, t.id, "IN_PROGRESS")).body.task.lifecycle).toBe("IN_PROGRESS");
    c.db.run("UPDATE tasks SET requires_approval = 1 WHERE id = ?", t.id);
    expect((await move(e1, t.id, "COMPLETED")).body.error.code).toBe("review_required");
    expect((await move(e1, t.id, "IN_REVIEW")).body.task.lifecycle).toBe("IN_REVIEW");
    expect((await move(e1, t.id, "APPROVED")).status).toBe(403); // never one's own work
    expect((await move(head, t.id, "APPROVED")).status).toBe(403); // an approver is assigned: the decision is theirs
    const rev = await c.login("m.rev");
    expect((await move(rev, t.id, "REVISION")).status).toBe(400); // reason required
    expect((await move(rev, t.id, "REVISION", { reason: "Raqamlarni yangilang" })).body.task.lifecycle).toBe("REVISION");
    await move(e1, t.id, "IN_PROGRESS");
    await move(e1, t.id, "IN_REVIEW");
    expect((await move(rev, t.id, "APPROVED")).body.task).toMatchObject({ lifecycle: "APPROVED", status: "IN_REVIEW" }); // approval ≠ completion
    v = (await move(rev, t.id, "COMPLETED")).body;
    expect(v.task).toMatchObject({ lifecycle: "COMPLETED", status: "DONE" });
    expect(v.transitions.map((x: { to: string }) => x.to).reverse()).toEqual(
      ["BACKLOG", "PLANNED", "ASSIGNED", "IN_PROGRESS", "IN_REVIEW", "REVISION", "IN_PROGRESS", "IN_REVIEW", "APPROVED", "COMPLETED"],
    );
    expect(v.transitions.find((x: { to: string }) => x.to === "REVISION")).toMatchObject({ actor: `user:${c.ids.rev}` });
    expect(c.db.all("SELECT decision FROM task_reviews WHERE task_id = ? ORDER BY created_at", t.id).map((r) => (r as { decision: string }).decision))
      .toEqual(["CHANGES_REQUESTED", "APPROVED"]);
  });

  it("invalid transitions, missing reasons and the AI runtime's own states are refused; screens get what they may do", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "x", assigneeId: c.ids.e1 })).body.task;
    const bad = await move(head, t.id, "COMPLETED");
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("invalid_transition");
    expect((await move(await c.login("m.e1"), t.id, "CANCELLED")).status).toBe(403); // cancelling is the owner of the work's call
    expect((await engine(head, t.id)).can.transitions).toEqual(["CANCELLED"]); // BACKLOG only once nobody owns it
    expect((await engine(await c.login("m.e1"), t.id)).can.transitions).toEqual(["IN_PROGRESS"]);
    const ai = (await head.post("/api/tasks", { title: "AI", agentId: "marketing-javohir" })).body.task;
    expect((await move(head, ai.id, "IN_PROGRESS")).body.error.code).toBe("ai_execution");
    expect((await move(head, ai.id, "BLOCKED", { reason: "kutamiz" })).status).toBe(409); // queued work is not blocked
  });

  it("an AI task through the engine and the AI runtime: plan → queue → claimed → done, system steps logged as system", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const t = (await head.post("/api/tasks", { title: "Bozor tadqiqoti", departmentId: "marketing", backlog: true })).body.task;
    expect(t).toMatchObject({ lifecycle: "BACKLOG", agentId: null });
    expect((await move(head, t.id, "PLANNED")).body.task.lifecycle).toBe("PLANNED");
    expect((await move(head, t.id, "ASSIGNED")).body.error.code).toBe("no_owner");
    // the executing agent is the AI owner; assigning it queues the work for the AI runtime
    const v1 = (await head.post(`/api/tasks/${t.id}/assignments`, { assigneeType: "AI_AGENT", assigneeId: "marketing-javohir", role: "OWNER" })).body;
    expect(v1.task).toMatchObject({ lifecycle: "ASSIGNED", status: "QUEUED" });
    const claimed = claimNextTask(c.deps, "w1", 60_000)!;
    expect(claimed.id).toBe(t.id);
    transitionTask(c.deps, t.id, "DONE", SYSTEM, { result: "Natija (sinov dublyori)" });
    const v = await engine(head, t.id);
    expect(v.task).toMatchObject({ lifecycle: "COMPLETED", status: "DONE" });
    expect(v.transitions.slice(0, 2).map((x: { to: string; actor: string }) => [x.to, x.actor])).toEqual([["COMPLETED", "system"], ["IN_PROGRESS", "system"]]);
  });
});

describe("T1: concurrency, idempotency and compatibility", () => {
  it("a stale version is refused (409) and every change moves the version on", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "Versiya", departmentId: "marketing", assigneeId: null })).body.task;
    const v0 = (await engine(head, t.id)).task.version;
    const r1 = await move(head, t.id, "PLANNED", { version: v0 });
    expect(r1.status).toBe(200);
    expect(r1.body.task.version).toBeGreaterThan(v0);
    const stale = await move(head, t.id, "BACKLOG", { version: v0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await head.post(`/api/tasks/${t.id}/assignments`, { assigneeType: "HUMAN", assigneeId: c.ids.e1, role: "OWNER", version: v0 })).status).toBe(409);
  });

  it("the same Idempotency-Key creates one task; a retry gets it back", async () => {
    const c = await org();
    const send = async (url: string, body: object, key: string) => {
      const cookie = await loginCookie(c.app, "m.head", PW);
      const r = await c.app.inject({ method: "POST", url, payload: body, headers: { cookie, "idempotency-key": key } });
      return { status: r.statusCode, body: JSON.parse(r.body) };
    };
    const a1 = await send("/api/tasks", { title: "Bir marta", agentId: "marketing-javohir" }, "key-ai-0001");
    const a2 = await send("/api/tasks", { title: "Bir marta", agentId: "marketing-javohir" }, "key-ai-0001");
    expect([a1.status, a2.status]).toEqual([201, 200]);
    expect(a2.body).toMatchObject({ replayed: true, task: { id: a1.body.task.id } });
    const w1 = await send("/api/work", { title: "Bir marta ish" }, "key-hu-0001");
    const w2 = await send("/api/work", { title: "Bir marta ish" }, "key-hu-0001");
    expect(w2.body.task.id).toBe(w1.body.task.id);
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE title IN ('Bir marta', 'Bir marta ish')")!.n).toBe(2);
    expect((await send("/api/work", { title: "boshqa" }, "key-ai-0001")).status).toBe(409); // key of another request
    expect((await send("/api/tasks", { title: "x" }, "short")).status).toBe(400);
  });

  it("priority CRITICAL replaces URGENT; the old name is still accepted and stored as CRITICAL", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const t = (await head.post("/api/tasks", { title: "Shoshilinch", agentId: "marketing-javohir", priority: "URGENT" })).body.task;
    expect(t.priority).toBe("CRITICAL");
    expect((await head.post("/api/work", { title: "Kritik", priority: "CRITICAL" })).body.task.priority).toBe("CRITICAL");
    expect(() => createTask(c.deps, { title: "x", agentId: "marketing-javohir", priority: "URGENT" as never }, SYSTEM)).toThrow(/CHECK/);
  });

  it("legacy flows keep assignments in step: decline, reassignment of the agent, removal of the reviewer", async () => {
    const c = await org();
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "Rad", assigneeId: c.ids.e1 })).body.task;
    expect((await (await c.login("m.e1")).post(`/api/work/${t.id}/decline`, { reason: "Vaqtim yo'q" })).status).toBe(200);
    const v = await engine(head, t.id);
    expect(v.task.lifecycle).toBe("BACKLOG");
    expect(v.assignments.find((a: { role: string; assigneeId: string }) => a.role === "OWNER" && a.assigneeId === c.ids.e1)).toMatchObject({ state: "DECLINED", reason: "Vaqtim yo'q" });
    const ai = (await c.admin.post("/api/tasks", { title: "AI", agentId: "marketing-javohir" })).body.task;
    expect((await c.admin.post(`/api/tasks/${ai.id}/reassign`, { agentId: "marketing-dildora" })).status).toBe(200);
    const av = await engine(c.admin, ai.id);
    expect(owners(av)).toEqual(["marketing-dildora"]);
    expect(av.assignments.find((a: { assigneeId: string }) => a.assigneeId === "marketing-javohir").state).toBe("RELEASED");
  });
});
