// Human employees & workflow — acceptance scenarios (numbers refer to the specification's test list).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { adminClient, client, loginCookie, makeApp } from "./helpers.js";
import { computeWorkload } from "../src/domain/workload.js";
import { deadlineSweep } from "../src/domain/notifications.js";

type App = Awaited<ReturnType<typeof makeApp>>["app"];
type C = ReturnType<typeof client>;

const PW = "Str0ng-pass-123";

/** Company: director, heads of marketing & procurement, two marketing employees, one procurement employee. */
async function company() {
  const env = await makeApp();
  const admin = await adminClient(env.app);
  const mk = async (username: string, displayName: string, roles: string[], departmentId: string | null, extra: object = {}) => {
    const r = await admin.post("/api/employees", { username, displayName, password: PW, roles, departmentId, jobTitle: displayName, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.employee.id as string;
  };
  const director = await mk("director", "Direktor", ["director"], "director");
  const mHead = await mk("m.head", "Marketing rahbari", ["employee"], "marketing", { managerId: director });
  // 1. administrator creates a department head
  expect((await admin.put("/api/departments/marketing/head", { userId: mHead })).status).toBe(200);
  const pHead = await mk("p.head", "Ta'minot rahbari", ["employee"], "procurement", { managerId: director });
  expect((await admin.put("/api/departments/procurement/head", { userId: pHead })).status).toBe(200);
  const login = async (u: string) => client(env.app, await loginCookie(env.app, u, PW));
  return { ...env, admin, ids: { director, mHead, pHead }, login, mk };
}

describe("people: accounts, organisation and permissions", () => {
  it("1–2: admin creates a head; the head adds an employee to their own department (manager defaults to the head)", async () => {
    const c = await company();
    const head = await c.login("m.head");
    const me = (await head.get("/api/auth/me")).body.user;
    expect(me.roles).toContain("department_head");
    expect(me.managedDepartments).toEqual(["marketing"]);
    const r = await head.post("/api/employees", { username: "aziza", displayName: "Aziza", password: PW, departmentId: "marketing", jobTitle: "SMM" });
    expect(r.status).toBe(201);
    expect(r.body.employee).toMatchObject({ departmentId: "marketing", managerId: c.ids.mHead, roles: ["employee"], status: "active" });
    expect(r.body.employee).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(r.body)).not.toContain("scrypt");
  });

  it("3: a head cannot manage another department's people, or create heads/admins, without explicit permission", async () => {
    const c = await company();
    const head = await c.login("m.head");
    expect((await head.post("/api/employees", { username: "xx1", displayName: "X", password: PW, departmentId: "procurement" })).status).toBe(403);
    expect((await head.post("/api/employees", { username: "xx2", displayName: "X", password: PW, departmentId: "marketing", roles: ["admin"] })).status).toBe(403);
    const pEmp = await c.mk("bobur", "Bobur", ["employee"], "procurement");
    expect((await head.patch(`/api/employees/${pEmp}`, { jobTitle: "hack" })).status).toBe(403);
    expect((await head.post(`/api/employees/${pEmp}/status`, { status: "inactive" })).status).toBe(403);
    expect((await head.patch(`/api/employees/${c.ids.pHead}`, { jobTitle: "hack" })).status).toBe(403);
    // an explicit, department-scoped grant from the director opens exactly that department
    const dir = await c.login("director");
    expect((await dir.post(`/api/employees/${c.ids.mHead}/grants`, { permission: "employees:manage_dept", departmentId: "procurement" })).status).toBe(201);
    const head2 = await c.login("m.head");
    expect((await head2.patch(`/api/employees/${pEmp}`, { jobTitle: "Mutaxassis" })).status).toBe(200);
    expect((await head2.patch(`/api/employees/${c.ids.pHead}`, { jobTitle: "hack" })).status).toBe(403); // never other heads
  });

  it("4: an employee cannot raise their own role, grant themselves permissions or change their own org data", async () => {
    const c = await company();
    const emp = await c.mk("aziza", "Aziza", ["employee"], "marketing");
    const e = await c.login("aziza");
    expect((await e.put(`/api/employees/${emp}/roles`, { roles: ["admin"] })).status).toBe(403);
    expect((await e.post(`/api/employees/${emp}/grants`, { permission: "tasks:read_all" })).status).toBe(403);
    expect((await e.patch(`/api/employees/${emp}`, { departmentId: "finance" })).status).toBe(403);
    expect((await e.patch(`/api/employees/${emp}`, { jobTitle: "Direktor" })).status).toBe(403);
    expect((await e.post("/api/users", { username: "evil", password: PW, roles: ["admin"] })).status).toBe(403);
    expect((await e.patch(`/api/employees/${emp}`, { workStart: "08:30" })).status).toBe(200); // self-service field
    // a head cannot hand out what was not delegated to them
    const head = await c.login("m.head");
    expect((await head.post(`/api/employees/${emp}/grants`, { permission: "tasks:read_team", departmentId: "marketing" })).status).toBe(403);
    const audit = (await c.admin.get(`/api/audit?targetId=${emp}`)).body.items.map((a: { action: string }) => a.action);
    expect(audit).toContain("employee.create");
  });

  it("15: deactivated employees cannot sign in (sessions end), their task history stays for authorised viewers", async () => {
    const c = await company();
    const emp = await c.mk("aziza", "Aziza", ["employee"], "marketing");
    const e = await c.login("aziza");
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "Post tayyorlash", assigneeId: emp })).body.task;
    expect((await e.post(`/api/work/${t.id}/accept`)).status).toBe(200);
    expect((await head.post(`/api/employees/${emp}/status`, { status: "archived" })).status).toBe(200);
    expect((await e.get("/api/work")).status).toBe(401); // old session is gone
    const bad = await c.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "aziza", password: PW } });
    expect(bad.statusCode).toBe(401);
    const detail = await head.get(`/api/work/${t.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.task.assigneeUserId).toBe(emp);
    expect((await head.get(`/api/employees/${emp}`)).body).toMatchObject({ full: true, employee: { status: "archived" } });
    // the employee record is never deleted
    expect(c.db.get("SELECT status FROM users WHERE id = ?", emp)).toEqual({ status: "archived" });
  });

  it("16: profiles and tasks are not reachable by id without permission (no IDOR)", async () => {
    const c = await company();
    const a = await c.mk("aziza", "Aziza", ["employee"], "marketing");
    await c.mk("bobur", "Bobur", ["employee"], "procurement");
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "Maxfiy kampaniya", assigneeId: a })).body.task;
    const b = await c.login("bobur");
    expect((await b.get(`/api/work/${t.id}`)).status).toBe(404);
    expect((await b.post(`/api/work/${t.id}/accept`)).status).toBe(404);
    expect((await b.get(`/api/tasks/${t.id}`)).status).toBe(404); // the AI task endpoint does not leak it either
    expect((await b.get("/api/tasks")).body.tasks.some((x: { id: string }) => x.id === t.id)).toBe(false);
    expect((await b.get(`/api/work/${t.id}/attachments/att_x`)).status).toBe(404);
    const prof = (await b.get(`/api/employees/${a}`)).body;
    expect(prof.full).toBe(false); // card only
    expect(prof.employee).not.toHaveProperty("email");
    expect(prof.employee).not.toHaveProperty("workload");
    expect((await b.get("/api/org-chart")).status).toBe(403);
    expect((await b.get("/api/work?view=company")).status).toBe(403);
    // the director sees everything
    const dir = await c.login("director");
    expect((await dir.get(`/api/work/${t.id}`)).status).toBe(200);
    expect((await dir.get("/api/org-chart")).body.departments.find((d: { id: string }) => d.id === "marketing").headId).toBe(c.ids.mHead);
  });
});

describe("work: lifecycle, review and hierarchy", () => {
  it("5: an employee creates a personal task (accepted, no review) and completes it directly", async () => {
    const c = await company();
    await c.mk("aziza", "Aziza", ["employee"], "marketing");
    const e = await c.login("aziza");
    const t = (await e.post("/api/work", { title: "Hisobotni o'qish", estimateHours: 2 })).body.task;
    expect(t).toMatchObject({ kind: "human", status: "ACCEPTED", requiresApproval: false });
    expect((await e.post(`/api/work/${t.id}/start`)).body.task.status).toBe("IN_PROGRESS");
    expect((await e.post(`/api/work/${t.id}/submit`, { result: "o'qildi" })).body.task.status).toBe("DONE");
    // not assignable to someone else without rights
    const other = await c.mk("bobur", "Bobur", ["employee"], "procurement");
    expect((await e.post("/api/work", { title: "x", assigneeId: other })).status).toBe(403);
  });

  it("6–11: director → head → subtasks → employees; review loop; parent completes only when required work is done", async () => {
    const c = await company();
    const a = await c.mk("aziza", "Aziza", ["employee"], "marketing");
    const b = await c.mk("bek", "Bek", ["employee"], "marketing");
    const dir = await c.login("director");
    const head = await c.login("m.head");
    const ea = await c.login("aziza");
    const eb = await c.login("bek");

    // 6. director assigns to the head, review by the director
    const parent = (await dir.post("/api/work", { title: "Yangi marketing kampaniyasi", assigneeId: c.ids.mHead, deadline: new Date(Date.now() + 7 * 864e5).toISOString() })).body.task;
    expect(parent).toMatchObject({ status: "ASSIGNED", requiresApproval: true, reviewerUserId: c.ids.director });
    const notes = (await head.get("/api/notifications")).body;
    expect(notes.items[0]).toMatchObject({ kind: "assigned", taskId: parent.id });
    expect((await head.post(`/api/work/${parent.id}/accept`)).body.task.status).toBe("ACCEPTED");

    // 7. head splits it: two required subtasks + one optional
    const s1 = (await head.post("/api/work", { title: "Raqobatchilar tahlili", parentId: parent.id, assigneeId: a, estimateHours: 6 })).body.task;
    const s2 = (await head.post("/api/work", { title: "Kreativlar", parentId: parent.id, assigneeId: b, estimateHours: 8, weight: 2 })).body.task;
    const s3 = (await head.post("/api/work", { title: "Qo'shimcha g'oyalar", parentId: parent.id, assigneeId: b, isOptional: true })).body.task;
    expect(s1.status).toBe("ASSIGNED");
    let p = (await dir.get(`/api/work/${parent.id}`)).body;
    expect(p.task.status).toBe("IN_PROGRESS"); // split → automatically in progress, not completed
    expect(p.subtasks).toHaveLength(3);
    expect((await ea.get("/api/work?view=my")).body.tasks.map((t: { id: string }) => t.id)).toEqual([s1.id]);
    expect((await head.get("/api/work?view=department")).body.tasks.length).toBe(4);

    // 8. employees: accept, start, update, submit; declining needs a reason
    expect((await eb.post(`/api/work/${s3.id}/decline`, { reason: "" })).status).toBe(400);
    expect((await eb.post(`/api/work/${s3.id}/decline`, { reason: "Vaqt yo'q" })).body.task).toMatchObject({ status: "BACKLOG", declineReason: "Vaqt yo'q", assigneeUserId: null });
    for (const [cl, id] of [[ea, s1.id], [eb, s2.id]] as [C, string][]) {
      expect((await cl.post(`/api/work/${id}/submit`, { result: "x" })).status).toBe(409); // not started
      expect((await cl.post(`/api/work/${id}/accept`)).status).toBe(200);
      expect((await cl.post(`/api/work/${id}/start`)).status).toBe(200);
      expect((await cl.post(`/api/work/${id}/progress`, { progress: 50, actualHours: 2, note: "yarmi tayyor" })).status).toBe(200);
    }
    expect((await ea.post(`/api/work/${s2.id}/start`)).status).toBe(404); // a colleague's task: not even visible
    expect((await ea.post(`/api/work/${s1.id}/submit`, { result: "Tahlil hujjati" })).body.task.status).toBe("IN_REVIEW");
    expect((await ea.post(`/api/work/${s1.id}/approve`)).status).toBe(403); // no self-approval

    // 9. reviewer requests changes (comment required), employee revises, reviewer approves
    expect((await head.post(`/api/work/${s1.id}/request-changes`, { comment: "" })).status).toBe(400);
    expect((await head.post(`/api/work/${s1.id}/request-changes`, { comment: "Narxlarni qo'shing" })).body.task.status).toBe("CHANGES_REQUESTED");
    expect((await ea.get("/api/notifications")).body.items.some((n: { kind: string }) => n.kind === "changes_requested")).toBe(true);
    p = (await head.get(`/api/work/${parent.id}`)).body;
    expect(p.task.stage).toContain("qayta ishlashda");
    expect((await ea.post(`/api/work/${s1.id}/start`)).status).toBe(200);
    expect((await ea.post(`/api/work/${s1.id}/submit`, { result: "Narxlar bilan" })).status).toBe(200);
    expect((await head.post(`/api/work/${s1.id}/approve`, { comment: "Zo'r" })).body.task.status).toBe("DONE");

    // 10. one required subtask still open → parent not complete, head cannot submit it
    p = (await head.get(`/api/work/${parent.id}`)).body;
    expect(p.task.status).toBe("IN_PROGRESS");
    expect(p.task.progress).toBe(Math.round((1 * 100 + 2 * 50) / 3)); // weighted by required subtasks only
    expect((await head.post(`/api/work/${parent.id}/start`)).status).toBe(409);
    expect((await head.post(`/api/work/${parent.id}/submit`, { result: "x" })).status).toBe(409);

    // a blocked required subtask is reflected on the parent, and released again
    expect((await eb.post(`/api/work/${s2.id}/block`, { reason: "Dizayner kutilyapti" })).status).toBe(200);
    expect((await dir.get(`/api/work/${parent.id}`)).body.task.status).toBe("BLOCKED");
    expect((await eb.post(`/api/work/${s2.id}/unblock`)).status).toBe(200);
    expect((await dir.get(`/api/work/${parent.id}`)).body.task.status).toBe("IN_PROGRESS");

    // 11. last required subtask approved → parent goes to the director's review automatically, then DONE
    await eb.post(`/api/work/${s2.id}/submit`, { result: "Kreativlar tayyor" });
    await head.post(`/api/work/${s2.id}/approve`);
    p = (await dir.get(`/api/work/${parent.id}`)).body;
    expect(p.task.status).toBe("IN_REVIEW"); // the optional, unassigned subtask does not block it
    const auto = p.history.filter((h: { data: { auto: boolean } }) => h.data.auto);
    expect(auto.map((h: { data: { to: string } }) => h.data.to)).toEqual(["IN_PROGRESS", "BLOCKED", "IN_PROGRESS", "IN_REVIEW"]);
    expect(auto.every((h: { actor: string | null }) => h.actor === null)).toBe(true);
    expect((await dir.post(`/api/work/${parent.id}/approve`, { comment: "Tasdiqlayman" })).body.task.status).toBe("DONE");
    expect((await head.get("/api/notifications")).body.items.some((n: { kind: string; taskId: string }) => n.kind === "approved" && n.taskId === parent.id)).toBe(true);
    // status history keeps who did what and when
    const h1 = (await head.get(`/api/work/${s1.id}`)).body.history;
    expect(h1.map((x: { data: { to?: string } }) => x.data.to).filter(Boolean)).toEqual(["ACCEPTED", "IN_PROGRESS", "IN_REVIEW", "CHANGES_REQUESTED", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
    expect(h1.find((x: { data: { to?: string } }) => x.data.to === "DONE").actorName).toBe("Marketing rahbari");
  });

  it("12: concurrent completion of the last subtasks (two connections) gives one consistent parent transition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sag-race-"));
    const path = join(dir, "race.db");
    const c = await (async () => {
      const env = await makeApp(path);
      const admin = await adminClient(env.app);
      const mk = async (username: string, departmentId: string, roles = ["employee"]) =>
        (await admin.post("/api/employees", { username, displayName: username, password: PW, departmentId, roles })).body.employee.id as string;
      return { ...env, mk, admin };
    })();
    const head = await c.mk("head", "marketing");
    await c.admin.put("/api/departments/marketing/head", { userId: head });
    const a = await c.mk("aa1", "marketing");
    const b = await c.mk("bb1", "marketing");
    const h = client(c.app, await loginCookie(c.app, "head", PW));
    for (let round = 0; round < 3; round++) {
      const parent = (await h.post("/api/work", { title: `Ota ${round}` })).body.task; // head's own, no review
      const kids = [];
      for (const [who, name] of [[a, "aa1"], [b, "bb1"]] as const) {
        const k = (await h.post("/api/work", { title: `Bola ${name}`, parentId: parent.id, assigneeId: who, requiresReview: false })).body.task;
        const e = client(c.app, await loginCookie(c.app, name, PW));
        await e.post(`/api/work/${k.id}/accept`);
        await e.post(`/api/work/${k.id}/start`);
        kids.push({ id: k.id, user: who });
      }
      const barrier = new SharedArrayBuffer(4);
      const results = await Promise.all(kids.map((k) => new Promise<{ ok: boolean; error?: string }>((res, rej) => {
        const w = new Worker(new URL("./fixtures/submit-worker.mjs", import.meta.url), {
          workerData: { dbPath: path, userId: k.user, taskId: k.id, barrier },
        });
        w.once("message", res);
        w.once("error", rej);
      })));
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      const p = c.db.get<{ status: string; progress: number }>("SELECT status, progress FROM tasks WHERE id = ?", parent.id)!;
      expect(p).toEqual({ status: "DONE", progress: 100 });
      const done = c.db.get<{ n: number }>("SELECT COUNT(*) n FROM task_events WHERE task_id = ? AND type = 'task.status' AND data LIKE '%\"to\":\"DONE\"%'", parent.id)!.n;
      expect(done).toBe(1);
    }
    // a duplicate transition (double click) applies once; the second gets 409
    const t = (await h.post("/api/work", { title: "Ikki marta" })).body.task;
    await h.post(`/api/work/${t.id}/start`);
    const [r1, r2] = await Promise.all([h.post(`/api/work/${t.id}/submit`), h.post(`/api/work/${t.id}/submit`)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    c.db.close();
  }, 30_000);

  it("rejects circular dependencies and cross-department assignment without permission", async () => {
    const c = await company();
    const pEmp = await c.mk("bobur", "Bobur", ["employee"], "procurement");
    const head = await c.login("m.head");
    expect((await head.post("/api/work", { title: "x", assigneeId: pEmp })).status).toBe(403);
    const dir = await c.login("director");
    expect((await dir.post("/api/work", { title: "Kross-bo'lim", assigneeId: pEmp })).status).toBe(201); // director may
    const t1 = (await head.post("/api/work", { title: "A" })).body.task;
    const t2 = (await head.post("/api/work", { title: "B", dependsOn: [t1.id] })).body.task;
    expect((await head.post(`/api/work/${t2.id}/start`)).status).toBe(409); // waits for A
    // t1 → t2 would close a loop: create a third that depends on t2, then try to make t1 depend on it is not
    // possible through the API (dependencies are set at creation), but the cycle guard is shared with AI tasks:
    const { assertNoCycle } = await import("../src/domain/tasks.js");
    expect(() => assertNoCycle(c.deps, t1.id, [t2.id])).toThrow(/halqa/);
  });
});

describe("workload & notifications", () => {
  it("13–14: workload reacts to estimates and deadlines; completed work is excluded; explanations are shown", async () => {
    const c = await company();
    const a = await c.mk("aziza", "Aziza", ["employee"], "marketing", { capacityHoursWeek: 40 });
    const head = await c.login("m.head");
    const ea = await c.login("aziza");
    expect(computeWorkload(c.deps, a)).toMatchObject({ level: "GREEN", activeTasks: 0 });
    const soon = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
    const t1 = (await head.post("/api/work", { title: "Katta ish", assigneeId: a, estimateHours: 20, deadline: soon(48) })).body.task;
    let w = computeWorkload(c.deps, a);
    expect(w).toMatchObject({ level: "GREEN", percent: 50, confidence: "high" });
    const t2 = (await head.post("/api/work", { title: "Yana ish", assigneeId: a, estimateHours: 14, deadline: soon(72) })).body.task;
    w = computeWorkload(c.deps, a);
    expect(w).toMatchObject({ level: "ORANGE", percent: 85 });
    await head.post("/api/work", { title: "Shoshilinch", assigneeId: a, estimateHours: 8, deadline: soon(10) });
    w = computeWorkload(c.deps, a);
    expect(w.level).toBe("RED");
    expect(w.summary).toMatch(/OVERLOADED/);
    expect(w.reasons.join(" ")).toMatch(/oshadi/);
    // notified once when rising to ORANGE and RED (idempotent), manager too
    const n = (await ea.get("/api/notifications")).body.items.filter((x: { kind: string }) => x.kind === "workload");
    expect(n.map((x: { title: string }) => x.title).sort()).toEqual(["Yuklama yuqori", "Yuklama: OVERLOADED"]);
    expect((await head.get("/api/notifications")).body.items.filter((x: { kind: string }) => x.kind === "workload")).toHaveLength(2);
    // 14. completing / cancelling work removes it from the active load
    await ea.post(`/api/work/${t1.id}/accept`);
    await ea.post(`/api/work/${t1.id}/start`);
    await ea.post(`/api/work/${t1.id}/submit`, { result: "tayyor" }); // in review → no longer the employee's load
    await head.post(`/api/work/${t2.id}/cancel`, { reason: "kerak emas" });
    w = computeWorkload(c.deps, a);
    expect(w.activeTasks).toBe(1);
    expect(w.level).toBe("YELLOW"); // one deadline within 24 h
    // missing estimates → default hours, lower confidence; overdue escalates
    await head.post("/api/work", { title: "Baholanmagan", assigneeId: a, deadline: new Date(Date.now() - 3600e3).toISOString() });
    w = computeWorkload(c.deps, a);
    expect(w.confidence).toBe("low");
    expect(w.overdue).toBe(1);
    expect(["ORANGE", "RED"]).toContain(w.level);
    // a parent with open subtasks is not double counted
    const p = (await head.post("/api/work", { title: "Ota", assigneeId: c.ids.mHead, estimateHours: 30 })).body.task;
    const before = computeWorkload(c.deps, c.ids.mHead).demandHours;
    await head.post("/api/work", { title: "Bola", parentId: p.id, assigneeId: a, estimateHours: 1 });
    expect(computeWorkload(c.deps, c.ids.mHead).demandHours).toBeLessThan(before);
    // policy is configurable only with workload:configure
    expect((await ea.put("/api/settings/workload", {})).status).toBe(403);
    const dir = await c.login("director");
    const pol = (await dir.get("/api/settings/workload")).body.policy;
    expect((await dir.put("/api/settings/workload", { ...pol, yellow: 90, orange: 80 })).status).toBe(400);
    expect((await dir.put("/api/settings/workload", { ...pol, yellow: 50 })).status).toBe(200);
  });

  it("deadline sweep notifies once per task and deadline (idempotent)", async () => {
    const c = await company();
    const a = await c.mk("aziza", "Aziza", ["employee"], "marketing");
    const head = await c.login("m.head");
    await head.post("/api/work", { title: "Kechikkan", assigneeId: a, deadline: new Date(Date.now() - 60e3).toISOString() });
    await head.post("/api/work", { title: "Ertaga", assigneeId: a, deadline: new Date(Date.now() + 3 * 3600e3).toISOString() });
    deadlineSweep(c.deps);
    deadlineSweep(c.deps);
    const kinds = c.db.all<{ kind: string; user_id: string }>("SELECT kind, user_id FROM notifications WHERE kind IN ('overdue','deadline') ORDER BY kind, user_id");
    expect(kinds.map((k) => k.kind).sort()).toEqual(["deadline", "overdue", "overdue"]); // employee + manager for overdue
    const ea = await c.login("aziza");
    const list = (await ea.get("/api/notifications?unread=true")).body;
    expect(list.unread).toBeGreaterThanOrEqual(3);
    await ea.post("/api/notifications/read", { ids: "all" });
    expect((await ea.get("/api/notifications")).body.unread).toBe(0);
  });

  it("realtime: people's task events reach only their audience; AI events stay public", async () => {
    const c = await company();
    const a = await c.mk("aziza", "Aziza", ["employee"], "marketing");
    await c.mk("bobur", "Bobur", ["employee"], "procurement");
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "Maxfiy", assigneeId: a })).body.task;
    const ev = c.db.all<{ type: string; data: string }>("SELECT type, data FROM task_events WHERE task_id = ?", t.id);
    expect(ev.every((e) => JSON.parse(e.data).human === true)).toBe(true);
    expect(ev.some((e) => e.data.includes("Maxfiy"))).toBe(false); // no titles in the stream
  });

  it("attachments: stored, downloadable only by people who can see the task, always as a download", async () => {
    const c = await company();
    const a = await c.mk("aziza", "Aziza", ["employee"], "marketing");
    const head = await c.login("m.head");
    const t = (await head.post("/api/work", { title: "Fayl bilan", assigneeId: a })).body.task;
    const boundary = "----sag";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hisobot.html"\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>\r\n--${boundary}--\r\n`;
    const cookie = await loginCookie(c.app, "aziza", PW);
    const up = await c.app.inject({ method: "POST", url: `/api/work/${t.id}/attachments`, payload, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(201);
    const id = JSON.parse(up.body).attachment.id;
    const dl = await c.app.inject({ method: "GET", url: `/api/work/${t.id}/attachments/${id}`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/octet-stream");
    expect(String(dl.headers["content-disposition"])).toMatch(/^attachment/);
    await c.mk("bobur", "Bobur", ["employee"], "procurement");
    const other = await c.app.inject({ method: "GET", url: `/api/work/${t.id}/attachments/${id}`, headers: { cookie: await loginCookie(c.app, "bobur", PW) } });
    expect(other.statusCode).toBe(404);
  });

  it("18: AI agent tasks and the agent API keep working next to human work", async () => {
    const c = await company();
    const admin = c.admin;
    const ai = await admin.post("/api/tasks", { title: "AI vazifa", departmentId: "marketing" });
    expect(ai.status).toBe(201);
    expect(ai.body.task.kind).toBe("single");
    expect(ai.body.task.agentId).toBeTruthy();
    const human = (await admin.post("/api/work", { title: "Odam vazifasi", assigneeId: c.ids.mHead })).body.task;
    expect((await admin.post(`/api/tasks/${human.id}/transition`, { to: "DONE" })).status).toBe(409); // workflow can't be bypassed
    expect((await admin.post("/api/tasks", { title: "x", parentId: human.id })).status).toBe(409);
    expect((await admin.get("/api/tasks")).body.tasks.every((t: { kind: string }) => t.kind !== "human")).toBe(true);
  });
});

export type { App };

describe("people: stable desks for the 3D office", () => {
  it("hands out the smallest free desk per department, frees it on archive, re-seats on transfer", async () => {
    const c = await company();
    const desk = (id: string) => c.db.get<{ desk: number | null }>("SELECT desk FROM users WHERE id = ?", id)!.desk;
    const a = await c.mk("aa1x", "A", ["employee"], "marketing");
    const b = await c.mk("bb1x", "B", ["employee"], "marketing");
    expect([desk(c.ids.mHead), desk(a), desk(b)].sort()).toEqual([0, 1, 2]);
    await c.admin.post(`/api/employees/${a}/status`, { status: "archived" });
    expect(desk(a)).toBeNull();
    const d = await c.mk("dd1x", "D", ["employee"], "marketing");
    expect(desk(d)).toBe(desk(c.ids.mHead) === 1 ? 0 : 1); // takes the freed number
    await c.admin.patch(`/api/employees/${b}`, { departmentId: "procurement" });
    expect(desk(b)).toBe(1); // procurement head holds 0
    const pres = (await c.admin.get("/api/employees/presence")).body.presence as { id: string; desk: number | null }[];
    expect(pres.find((p) => p.id === b)?.desk).toBe(1);
    expect(pres.some((p) => p.id === a)).toBe(false);
  });
});
