// W0.1 — data isolation: every access level of the confirmed model (security model §3.5) is checked for what it
// may and may not see, across tasks, agent chats, realtime events, connector activity, tool payloads, approvals,
// statistics, knowledge, memory, agent profiles and people's parent-task context.
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { adminClient, client, loginCookie, makeApp } from "./helpers.js";
import { createTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";
import { uid } from "../src/lib/ids.js";
import { provisionStoreUnit } from "../src/domain/units.js";
import { agentKnowledgeDept, canManageTask, canSeeTask, requesterOf, taskRef } from "../src/domain/access.js";
import { grantPermission } from "../src/domain/employees.js";
import { ingestDocument } from "../src/knowledge/service.js";
import { MockLlm } from "../src/llm/mock.js";
import { loadUser } from "../src/lib/auth.js";

const PW = "Str0ng-pass-123";
const T = () => new Date().toISOString();

/**
 * Director, marketing head, a marketing and a finance employee, a finance viewer — and AI tasks:
 * tM (created by the marketing employee), tF (system task in finance), P (finance employee's orchestrated job)
 * with subtask S that runs in marketing.
 */
async function org() {
  const env = await makeApp();
  const admin = await adminClient(env.app);
  const mk = async (username: string, roles: string[], departmentId: string) => {
    const r = await admin.post("/api/employees", { username, displayName: username, password: PW, roles, departmentId, jobTitle: username });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.employee.id as string;
  };
  const ids = {
    director: await mk("dir", ["director"], "director"),
    mHead: await mk("m.head", ["employee"], "marketing"),
    mEmp: await mk("m.emp", ["employee"], "marketing"),
    fEmp: await mk("f.emp", ["employee"], "finance"),
    fViewer: await mk("f.view", ["viewer"], "finance"),
  };
  expect((await admin.put("/api/departments/marketing/head", { userId: ids.mHead })).status).toBe(200);
  const d = env.deps;
  const tM = createTask(d, { title: "Marketing tahlili", agentId: "marketing-javohir" }, { type: "user", id: ids.mEmp });
  const tF = createTask(d, { title: "Moliya hisoboti", agentId: "finance-nilufar" }, SYSTEM);
  const P = createTask(d, { title: "Katta loyiha", departmentId: "finance", backlog: true }, { type: "user", id: ids.fEmp });
  const S = createTask(d, { title: "Loyihaning marketing qismi", agentId: "marketing-javohir", parentId: P.id }, SYSTEM);
  const login = async (u: string) => client(env.app, await loginCookie(env.app, u, PW));
  return { ...env, admin, ids, tasks: { tM, tF, P, S }, login };
}

const taskIds = (body: { tasks: { id: string }[] }) => body.tasks.map((t) => t.id).sort();

describe("W0.1 isolation: AI tasks follow the confirmed access model", () => {
  it("creator, department head, parent creator, director, admin and outsiders each see exactly their tasks", async () => {
    const c = await org();
    const { tM, tF, P, S } = c.tasks;
    const list = async (u: string) => taskIds((await (await c.login(u)).get("/api/tasks")).body);
    expect(await list("m.emp")).toEqual([tM.id].sort()); // creator
    expect(await list("m.head")).toEqual([tM.id, S.id].sort()); // department head: marketing tasks only
    expect(await list("f.emp")).toEqual([P.id, S.id].sort()); // parent creator sees the subtask's progress
    expect(await list("f.view")).toEqual([]); // department membership alone grants nothing
    expect(await list("dir")).toEqual([tM.id, tF.id, P.id, S.id].sort()); // unit director (tasks:read_all within the unit)
    expect(taskIds((await c.admin.get("/api/tasks")).body)).toEqual([tM.id, tF.id, P.id, S.id].sort());
  });

  it("detail: hidden tasks are 404; run records and tool payloads need their own permissions", async () => {
    const c = await org();
    const { tM, tF, P, S } = c.tasks;
    const emp = await c.login("m.emp");
    expect((await emp.get(`/api/tasks/${tF.id}`)).status).toBe(404);
    expect((await emp.get(`/api/tasks/${P.id}`)).status).toBe(404);
    const head = await c.login("m.head");
    expect((await head.get(`/api/tasks/${P.id}`)).status).toBe(404); // parent in another department
    expect((await head.get(`/api/tasks/${S.id}`)).status).toBe(200);

    c.db.run(
      "INSERT INTO agent_runs (id, task_id, agent_id, correlation_id, model, mode, status, started_at) VALUES (?,?,?,?,?,?,?,?)",
      "run_x", tM.id, "marketing-javohir", "corr", "m", "mock", "succeeded", T(),
    );
    c.db.run(
      "INSERT INTO approvals (id, task_id, agent_id, action, payload, status, requested_at) VALUES (?,?,?,?,?, 'PENDING', ?)",
      "apr_x", tM.id, "marketing-javohir", "tool:gmail_send", JSON.stringify({ to: "a@b.uz", body: "maxfiy" }), T(),
    );
    const mine = (await emp.get(`/api/tasks/${tM.id}`)).body;
    expect(mine.restricted).toEqual({ runs: true, payloads: true });
    expect(mine.runs).toEqual([]);
    expect(mine.approvals[0]).toMatchObject({ payload: null, payloadHidden: true });
    const dir = (await (await c.login("dir")).get(`/api/tasks/${tM.id}`)).body;
    expect(dir.restricted).toEqual({ runs: false, payloads: false });
    expect(dir.runs).toHaveLength(1);
    expect(JSON.parse(dir.approvals[0].payload)).toMatchObject({ body: "maxfiy" });

    // a parent's detail lists only the subtasks this viewer may see
    const parentForCreator = (await (await c.login("f.emp")).get(`/api/tasks/${P.id}`)).body;
    expect(parentForCreator.subtasks.map((s: { id: string }) => s.id)).toEqual([S.id]);
  });
});

describe("W0.1 isolation: agent chats", () => {
  it("each person reads only their own conversation; others' need agent_chat:read_others and are audited", async () => {
    const c = await org();
    const add = (userId: string, content: string) =>
      c.db.run("INSERT INTO chat_messages (id, agent_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?)",
        uid("chat"), "marketing-javohir", userId, "user", content, T());
    add(c.ids.mEmp, "mening savolim");
    add(c.ids.fEmp, "boshqaning savoli");
    const emp = await c.login("m.emp");
    const own = (await emp.get("/api/agents/marketing-javohir/chat")).body.messages;
    expect(own.map((m: { content: string }) => m.content)).toEqual(["mening savolim"]);
    expect((await emp.get(`/api/agents/marketing-javohir/chat?userId=${c.ids.fEmp}`)).status).toBe(403);
    // the director can see a lot, but not other people's chats
    expect((await (await c.login("dir")).get(`/api/agents/marketing-javohir/chat?userId=${c.ids.fEmp}`)).status).toBe(403);
    const other = (await c.admin.get(`/api/agents/marketing-javohir/chat?userId=${c.ids.fEmp}`)).body.messages;
    expect(other.map((m: { content: string }) => m.content)).toEqual(["boshqaning savoli"]);
    expect(c.db.get("SELECT 1 FROM audit_logs WHERE action = 'agent_chat.read_other'")).toBeTruthy();
  });
});

describe("W0.1 isolation: connector activity, tool payloads and approvals", () => {
  async function withToolLog() {
    const c = await org();
    for (const [t, agent] of [[c.tasks.tM, "marketing-javohir"], [c.tasks.tF, "finance-nilufar"]] as const) {
      const run = uid("run");
      c.db.run(
        "INSERT INTO agent_runs (id, task_id, agent_id, correlation_id, model, mode, status, started_at) VALUES (?,?,?,?,?,?,?,?)",
        run, t.id, agent, "corr", "m", "mock", "succeeded", T(),
      );
      c.db.run(
        `INSERT INTO tool_executions (id, run_id, tool, input, output, status, started_at, agent_id, task_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        uid("tx"), run, "gmail_send", JSON.stringify({ to: "mijoz@x.uz", apiKey: "sk-should-never-show" }), JSON.stringify({ ok: true }), "succeeded", T(), agent, t.id,
      );
      c.db.run(
        "INSERT INTO approvals (id, task_id, agent_id, action, payload, status, requested_at) VALUES (?,?,?,?,?, 'PENDING', ?)",
        uid("apr"), t.id, agent, "tool:gmail_send", JSON.stringify({ body: "maxfiy matn" }), T(),
      );
    }
    return c;
  }

  it("activity log: others' entries hidden, payloads need tool_io:read, secrets always redacted", async () => {
    const c = await withToolLog();
    const emp = (await (await c.login("m.emp")).get("/api/connectors/activity")).body.items;
    expect(emp.map((e: { taskId: string }) => e.taskId)).toEqual([c.tasks.tM.id]);
    expect(emp[0]).toMatchObject({ input: null, output: null, payloadHidden: true });
    const dir = (await (await c.login("dir")).get("/api/connectors/activity")).body.items;
    expect(dir).toHaveLength(2);
    expect(dir[0].input).toMatchObject({ to: "mijoz@x.uz", apiKey: "[redacted]" });
    expect(JSON.stringify(dir)).not.toContain("sk-should-never-show");
  });

  it("approvals: approvers see all with payloads; others only their tasks' requests, payload hidden", async () => {
    const c = await withToolLog();
    const emp = (await (await c.login("m.emp")).get("/api/approvals")).body.approvals;
    expect(emp.map((a: { taskId: string }) => a.taskId)).toEqual([c.tasks.tM.id]);
    expect(emp[0]).toMatchObject({ payload: {}, payloadHidden: true });
    expect((await (await c.login("f.view")).get("/api/approvals")).body.approvals).toEqual([]);
    const all = (await c.admin.get("/api/approvals")).body.approvals;
    expect(all).toHaveLength(2);
    expect(all[0].payload).toMatchObject({ body: "maxfiy matn" });
  });
});

describe("W0.1 isolation: statistics and agent profiles", () => {
  it("stats count only visible tasks; tokens and cost need budget:read", async () => {
    const c = await org();
    c.db.run(
      `INSERT INTO usage_records (id, agent_id, department_id, model, input_tokens, output_tokens, cost_usd, is_estimate, created_at)
       VALUES (?,?,?,?,?,?,?,1,?)`, uid("use"), "finance-nilufar", "finance", "m", 100, 50, 0.5, T(),
    );
    const queued = (s: { departmentId: string; queued: number }[], dep: string) => s.find((x) => x.departmentId === dep)!.queued;
    const emp = (await (await c.login("m.emp")).get("/api/stats")).body.departments;
    expect(queued(emp, "marketing")).toBe(1); // tM only (S is not theirs)
    expect(queued(emp, "finance")).toBe(0); // tF is invisible to them
    const fin = emp.find((x: { departmentId: string }) => x.departmentId === "finance");
    expect(fin).toMatchObject({ tokens: 0, costUsd: 0, usageHidden: true });
    const dir = (await (await c.login("dir")).get("/api/stats")).body.departments;
    expect(queued(dir, "marketing")).toBe(2);
    expect(dir.find((x: { departmentId: string }) => x.departmentId === "finance")).toMatchObject({ tokens: 150, costUsd: 0.5 });
  });

  it("agent profile: the card is public, its tasks follow task visibility and usage needs budget:read", async () => {
    const c = await org();
    const emp = await c.login("m.emp");
    const fin = (await emp.get("/api/agents/finance-nilufar")).body;
    expect(fin.agent.id).toBe("finance-nilufar");
    expect(fin.recentTasks).toEqual([]);
    expect(fin.usage.hidden).toBe(true);
    const mk = (await emp.get("/api/agents/marketing-javohir")).body;
    expect(mk.recentTasks.map((t: { id: string }) => t.id)).toEqual([c.tasks.tM.id]);
  });
});

describe("W0.1 isolation: knowledge and memory", () => {
  it("non-managers read company-wide and own-department items only", async () => {
    const c = await org();
    const doc = (title: string, dep: string | null) =>
      c.db.run(
        "INSERT INTO knowledge_documents (id, title, department_id, status, created_at, updated_at) VALUES (?,?,?, 'indexed', ?, ?)",
        uid("doc"), title, dep, T(), T(),
      );
    doc("Kompaniya qoidalari", null);
    doc("Marketing rejasi", "marketing");
    doc("Moliya maxfiy", "finance");
    const emp = await c.login("m.emp");
    const titles = (await emp.get("/api/knowledge")).body.documents.map((x: { title: string }) => x.title).sort();
    expect(titles).toEqual(["Kompaniya qoidalari", "Marketing rejasi"]);
    expect((await emp.get("/api/knowledge/search?q=moliya&departmentId=finance")).status).toBe(403);
    expect((await emp.get("/api/knowledge/search?q=moliya")).status).toBe(200);
    expect((await c.admin.get("/api/knowledge")).body.documents).toHaveLength(3);

    const mem = (content: string, dep: string | null, status: string) =>
      c.db.run("INSERT INTO company_memory (id, kind, content, department_id, created_at, status) VALUES (?, 'rule', ?, ?, ?, ?)", uid("mem"), content, dep, T(), status);
    mem("umumiy qoida", null, "APPROVED");
    mem("moliya qoidasi", "finance", "APPROVED");
    mem("tekshirilmagan", "marketing", "PENDING");
    const seen = (await emp.get("/api/memory")).body.memory.map((m: { content: string }) => m.content);
    expect(seen).toEqual(["umumiy qoida"]);
    expect((await emp.get("/api/memory?status=PENDING")).body.memory).toEqual([]);
    expect((await c.admin.get("/api/memory")).body.memory).toHaveLength(3);
  });
});

describe("W0.1 isolation: people's work keeps parent context for assignees", () => {
  it("an assignee sees the parent's context, not its comments or other subtasks", async () => {
    const c = await org();
    const dir = await c.login("dir");
    const head = await c.login("m.head");
    const parent = (await dir.post("/api/work", { title: "Kampaniya", description: "Asosiy maqsad", assigneeId: c.ids.mHead })).body.task;
    expect((await head.post(`/api/work/${parent.id}/accept`)).status).toBe(200);
    expect((await dir.post(`/api/work/${parent.id}/comments`, { body: "faqat rahbarlar uchun" })).status).toBe(201);
    const sub = (await head.post("/api/work", { title: "Banner", parentId: parent.id, assigneeId: c.ids.mEmp })).body.task;
    const other = (await head.post("/api/work", { title: "Boshqa qism", parentId: parent.id, assigneeId: c.ids.mHead })).body.task;
    const emp = await c.login("m.emp");
    const detail = (await emp.get(`/api/work/${sub.id}`)).body;
    expect(detail.parent).toMatchObject({ id: parent.id, title: "Kampaniya", description: "Asosiy maqsad", contextOnly: true });
    expect((await emp.get(`/api/work/${parent.id}`)).status).toBe(404); // comments stay with the parent
    expect((await emp.get(`/api/work/${other.id}`)).status).toBe(404); // sibling subtasks too
  });
});

describe("W0.1 isolation: realtime events", () => {
  it("SSE delivers task events only to people who can see the task; agent status stays public", async () => {
    const c = await org();
    await c.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (c.app.server.address() as AddressInfo).port;
    try {
      const stream = async (username: string) => {
        const cookie = await loginCookie(c.app, username, PW);
        const ctrl = new AbortController();
        const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie }, signal: ctrl.signal });
        const reader = res.body!.getReader();
        let text = "";
        const until = async (marker: string) => {
          while (!text.includes(marker)) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
          }
        };
        return { until, text: () => text, close: () => ctrl.abort() };
      };
      const emp = await stream("m.emp");
      const dir = await stream("dir");
      await emp.until("event: ready");
      await dir.until("event: ready");
      c.deps.bus.emit("task.progress", { taskId: c.tasks.tF.id, agentId: "finance-nilufar", departmentId: "finance" }, { stage: "maxfiy bosqich" });
      c.deps.bus.emit("task.progress", { taskId: c.tasks.tM.id, agentId: "marketing-javohir", departmentId: "marketing" }, { stage: "ochiq bosqich" });
      c.deps.bus.emit("agent.status", { agentId: "finance-nilufar", departmentId: "finance" }, { status: "WORKING", marker: "end" });
      await emp.until('"marker":"end"');
      await dir.until('"marker":"end"');
      expect(emp.text()).toContain("ochiq bosqich");
      expect(emp.text()).not.toContain("maxfiy bosqich");
      expect(dir.text()).toContain("maxfiy bosqich");
      emp.close();
      dir.close();
    } finally {
      await c.app.close();
    }
  });
});

describe("W0.1 isolation: HQ routes never reach another business unit's work", () => {
  it("a unit's tasks are invisible through /api/tasks, /api/work and SSE even to HQ-wide readers", async () => {
    const c = await org();
    const region = c.db.get<{ id: string }>("SELECT id FROM org_nodes WHERE level = 'REGION' LIMIT 1")!.id;
    const { unitId } = provisionStoreUnit(c.deps, {
      provisionKey: "test-store", regionId: region, name: "Sinov do'koni", sourceLabel: "test", businessType: "INDEPENDENT_DEALER",
      ownershipModel: "FRANCHISE", sourceBrand: "HOME_DESIGN", sourceMarker: "F", importBatchId: null,
    });
    const at = T();
    c.db.run(
      "INSERT INTO tasks (id, business_unit_id, kind, title, status, created_at, updated_at) VALUES ('t_unit_ai', ?, 'single', 'Diler sotuvlari', 'BACKLOG', ?, ?)",
      unitId, at, at,
    );
    c.db.run(
      "INSERT INTO tasks (id, business_unit_id, kind, title, status, created_by, created_at, updated_at) VALUES ('t_unit_h', ?, 'human', 'Diler ishi', 'BACKLOG', ?, ?, ?)",
      unitId, c.ids.director, at, at,
    );
    const dir = await c.login("dir"); // tasks:read_all + tasks:assign_any at HQ
    expect((await dir.get("/api/tasks/t_unit_ai")).status).toBe(404);
    expect((await dir.get("/api/tasks")).body.tasks.map((t: { id: string }) => t.id)).not.toContain("t_unit_ai");
    expect((await dir.get("/api/work/t_unit_h")).status).toBe(404); // even though dir is its creator
    expect((await c.admin.get("/api/tasks/t_unit_ai")).status).toBe(404);
    // the access rules themselves refuse it too (defence in depth behind app.ts's by-id hook), so paths without an
    // id in the URL — subtasks, parents, approvals, connector log, SSE — cannot reach it either
    const u = loadUser(c.db, c.ids.director)!;
    expect(canSeeTask(c.deps, u, taskRef(c.deps, "t_unit_ai")!)).toBe(false);
    expect(canSeeTask(c.deps, u, taskRef(c.deps, "t_unit_h")!)).toBe(false);
    expect(canManageTask(c.deps, u, taskRef(c.deps, "t_unit_h")!)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// S0 security remediation (T0 audit S1–S5): regression tests. Each finding is checked for the attack being refused
// and for the legitimate use still working.

/** A franchise unit with an AI task (t_unit_ai); HQ routes must never reach it. */
function franchise(c: Awaited<ReturnType<typeof org>>) {
  const region = c.db.get<{ id: string }>("SELECT id FROM org_nodes WHERE level = 'REGION' LIMIT 1")!.id;
  const { unitId } = provisionStoreUnit(c.deps, {
    provisionKey: "s0-store", regionId: region, name: "S0 diler", sourceLabel: "test", businessType: "INDEPENDENT_DEALER",
    ownershipModel: "FRANCHISE", sourceBrand: "HOME_DESIGN", sourceMarker: "F", importBatchId: null,
  });
  c.db.run(
    "INSERT INTO tasks (id, business_unit_id, kind, title, status, created_at, updated_at) VALUES ('t_unit_ai', ?, 'single', 'Diler sotuvlari', 'BACKLOG', ?, ?)",
    unitId, T(), T(),
  );
  return unitId;
}

describe("S0/S1: a child task never lands under a task the caller may not use", () => {
  it("parentId of a franchise task or of hidden HQ work is 404 and writes nothing; own department's parent works", async () => {
    const c = await org();
    const unitId = franchise(c);
    const dir = await c.login("dir"); // tasks:read_all + ai_tasks:create at HQ
    // without an agent or department nothing else stops it: the old code created this task inside the franchise
    expect((await dir.post("/api/tasks", { title: "Josuslik", parentId: "t_unit_ai" })).status).toBe(404);
    expect((await dir.post("/api/tasks", { title: "Josuslik", agentId: "marketing-javohir", parentId: "t_unit_ai" })).status).toBe(404);
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE parent_id = 't_unit_ai' OR (business_unit_id = ? AND id <> 't_unit_ai')", unitId)!.n).toBe(0);
    // the same answer as for an id that does not exist: existence cannot be probed
    expect((await dir.post("/api/tasks", { title: "x", parentId: "t_yoq" })).status).toBe(404);

    const head = await c.login("m.head"); // marketing head: sees marketing work only
    expect((await head.post("/api/tasks", { title: "Moliyaga qo'shimcha", agentId: "marketing-javohir", parentId: c.tasks.tF.id })).status).toBe(404);
    const ok = await head.post("/api/tasks", { title: "Marketing qo'shimcha", agentId: "marketing-javohir", parentId: c.tasks.tM.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.task).toMatchObject({ parentId: c.tasks.tM.id, businessUnitId: "hq" });
  });

  it("the domain refuses a parent from another unit whoever calls it (backstop behind the route)", async () => {
    const c = await org();
    franchise(c);
    expect(() => createTask(c.deps, { title: "x", agentId: "marketing-javohir", parentId: "t_unit_ai", unitId: "hq" }, SYSTEM)).toThrow();
  });
});

describe("S0/S2: calendar, routines and agent cards follow task visibility", () => {
  it("the calendar shows each person only tasks and routines they may see", async () => {
    const c = await org();
    const fEmp = await c.login("f.emp");
    const own = await fEmp.post("/api/work", { title: "Shaxsiy moliya ishi" }); // a personal human task
    expect(own.status).toBe(201);
    expect((await c.admin.post("/api/routines", { name: "Moliya kunlik hisobot", departmentId: "finance", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })).status).toBe(201);
    const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const cal = async (u: string) =>
      (await (await c.login(u)).get(`/api/calendar?from=${from}&to=${to}`)).body.items as { kind: string; id: string; title: string }[];
    const emp = await cal("m.emp");
    expect(emp.filter((i) => i.kind === "task").map((i) => i.id)).toEqual([c.tasks.tM.id]);
    expect(emp.some((i) => i.title.includes("Moliya") || i.title.includes("moliya"))).toBe(false); // finance tasks, routine, personal task
    expect(await cal("f.view")).toEqual([]); // department membership alone grants nothing
    const dir = await cal("dir");
    expect(dir.map((i) => i.id)).toEqual(expect.arrayContaining([c.tasks.tM.id, c.tasks.tF.id, c.tasks.P.id, own.body.task.id]));
    expect(dir.some((i) => i.kind === "routine" && i.title === "Moliya kunlik hisobot")).toBe(true);
  });

  it("routines: hidden ones are absent from the list and 404 by id; their department and managers see them", async () => {
    const c = await org();
    const fin = (await c.admin.post("/api/routines", { name: "Moliya kunlik hisobot", departmentId: "finance", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })).body.routine;
    const mk = (await c.admin.post("/api/routines", { name: "Marketing haftalik", departmentId: "marketing", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9" })).body.routine;
    const head = await c.login("m.head");
    expect((await head.get("/api/routines")).body.routines.map((x: { id: string }) => x.id)).toEqual([mk.id]);
    expect((await head.get(`/api/routines/${fin.id}`)).status).toBe(404);
    expect((await head.get(`/api/routines/${mk.id}`)).status).toBe(200);
    expect((await (await c.login("f.view")).get("/api/routines")).body.routines).toEqual([]);
    expect((await (await c.login("dir")).get("/api/routines")).body.routines).toHaveLength(2);
  });

  it("an agent's card shows its current task only to people who may see that task", async () => {
    const c = await org();
    const card = async (u: string) =>
      ((await (await c.login(u)).get("/api/agents")).body.agents as { id: string; currentTask: { id: string } | null }[]).find((a) => a.id === "finance-nilufar")!;
    expect((await card("m.emp")).currentTask).toBeNull(); // tF is finance's
    expect((await card("dir")).currentTask?.id).toBe(c.tasks.tF.id);
    expect((await (await c.login("m.emp")).get("/api/agents/finance-nilufar")).body.agent.currentTask).toBeNull();
  });
});

describe("S0/S3: dependencies stay inside what the caller may see", () => {
  it("a franchise or hidden task cannot be a prerequisite; a visible one can", async () => {
    const c = await org();
    franchise(c);
    const dir = await c.login("dir");
    expect((await dir.post("/api/tasks", { title: "x", agentId: "marketing-javohir", dependsOn: ["t_unit_ai"] })).status).toBe(404);
    const head = await c.login("m.head");
    expect((await head.post("/api/tasks", { title: "x", agentId: "marketing-javohir", dependsOn: [c.tasks.tF.id] })).status).toBe(404);
    const ok = await head.post("/api/tasks", { title: "Keyingi bosqich", agentId: "marketing-javohir", dependsOn: [c.tasks.tM.id] });
    expect(ok.status).toBe(201);
    expect(ok.body.task.dependsOn).toEqual([c.tasks.tM.id]);
    // backstops: the domain and the database refuse a cross-unit link whoever writes it
    expect(() => createTask(c.deps, { title: "x", agentId: "marketing-javohir", dependsOn: ["t_unit_ai"] }, SYSTEM)).toThrow();
    expect(() => c.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, 't_unit_ai')", c.tasks.tM.id)).toThrow(/cross_unit/);
  });

  it("reads never name hidden prerequisites or dependents (AI tasks and people's work)", async () => {
    const c = await org();
    // links to work the viewer cannot see, written directly (as older data could be)
    const X = createTask(c.deps, { title: "Marketing X", agentId: "marketing-javohir", dependsOn: [c.tasks.tF.id] }, { type: "user", id: c.ids.mEmp });
    const Y = createTask(c.deps, { title: "Moliya Y", agentId: "finance-nilufar", dependsOn: [c.tasks.tM.id] }, SYSTEM);
    const emp = await c.login("m.emp");
    expect((await emp.get(`/api/tasks/${X.id}`)).body.task.dependsOn).toEqual([]);
    expect((await emp.get("/api/tasks")).body.tasks.find((t: { id: string }) => t.id === X.id).dependsOn).toEqual([]);
    expect((await emp.get(`/api/tasks/${c.tasks.tM.id}`)).body.dependents).toEqual([]);
    const dir = await c.login("dir");
    expect((await dir.get(`/api/tasks/${X.id}`)).body.task.dependsOn).toEqual([c.tasks.tF.id]);
    expect((await dir.get(`/api/tasks/${c.tasks.tM.id}`)).body.dependents).toEqual([Y.id]);

    const w = (await emp.post("/api/work", { title: "Mening ishim" })).body.task;
    c.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", w.id, c.tasks.tF.id);
    expect((await emp.get(`/api/work/${w.id}`)).body.task.dependsOn).toEqual([]);
    const listed = (await emp.get("/api/work?view=my")).body;
    expect((listed.items ?? listed.tasks).find((t: { id: string }) => t.id === w.id).dependsOn).toEqual([]);
    // people's work refuses hidden prerequisites outright
    expect((await emp.post("/api/work", { title: "y", dependsOn: [c.tasks.tF.id] })).status).toBe(404);
  });
});

describe("S0/S4: an agent brings in only knowledge its requester may read", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("chat with another department's agent opens company-wide documents only; own department and managers get more", async () => {
    const c = await org();
    await ingestDocument(c.deps, { filename: "kassa.md", data: enc("Kassa seyf kodi 7781 maxfiy moliya."), departmentId: "finance" }, SYSTEM);
    await ingestDocument(c.deps, { filename: "aksiya.md", data: enc("Kassa aksiyasi 42 foiz marketing."), departmentId: "marketing" }, SYSTEM);
    await ingestDocument(c.deps, { filename: "umumiy.md", data: enc("Kassa ish vaqti 9 dan 18 gacha."), departmentId: null }, SYSTEM);
    const seen: string[] = [];
    const llm = new MockLlm("Javob");
    const generate = llm.generate.bind(llm);
    llm.generate = async (req) => { seen.push(JSON.stringify(req)); return generate(req); };
    c.deps.llm = { client: llm, pricing: { inputPerM: 0.3, outputPerM: 2.5 } };
    const ask = async (u: string, agent: string) => {
      seen.length = 0;
      expect((await (await c.login(u)).post(`/api/agents/${agent}/chat`, { message: "kassa" })).status).toBe(200);
      return seen.join("\n");
    };
    const headToFinance = await ask("m.head", "finance-nilufar");
    expect(headToFinance).not.toContain("7781"); // finance's private document
    expect(headToFinance).toContain("9 dan 18"); // company-wide stays available
    expect(await ask("m.head", "marketing-javohir")).toContain("42 foiz"); // own department
    expect(await ask("dir", "finance-nilufar")).toContain("7781"); // brain:manage reads every department
  });

  it("task work: the requester is the human creator of the task or its ancestor; system work keeps the agent's scope", async () => {
    const c = await org();
    const { P, S, tM, tF } = c.tasks;
    expect(requesterOf(c.deps, S.id)).toBe(c.ids.fEmp); // a system-made subtask inherits P's creator
    expect(requesterOf(c.deps, P.id)).toBe(c.ids.fEmp);
    expect(requesterOf(c.deps, tF.id)).toBeNull();
    expect(agentKnowledgeDept(c.deps, "finance", c.ids.mHead)).toBeNull(); // a marketing head asking finance's agent
    expect(agentKnowledgeDept(c.deps, "marketing", requesterOf(c.deps, tM.id))).toBe("marketing"); // own department
    expect(agentKnowledgeDept(c.deps, "finance", c.ids.director)).toBe("finance");
    expect(agentKnowledgeDept(c.deps, "finance", null)).toBe("finance"); // system work (routines, Telegram)
  });
});

describe("S0/S5: delegation never creates rights the delegator lacks", () => {
  it("self-escalation, escalation to another user and cross-unit grants are refused; held rights pass on", async () => {
    const c = await org();
    const dir = await c.login("dir"); // director: permissions:delegate, no agents:manage / employees:manage_*
    const grant = (who: string, body: object) => dir.post(`/api/employees/${who}/grants`, body);
    expect((await grant(c.ids.director, { permission: "agents:manage" })).status).toBe(403); // self
    expect((await grant(c.ids.mEmp, { permission: "agents:manage" })).status).toBe(403);
    expect((await grant(c.ids.mEmp, { permission: "agent_chat:read_others" })).status).toBe(403);
    expect((await grant(c.ids.mEmp, { permission: "employees:manage_dept", departmentId: "marketing" })).status).toBe(403);
    expect((await grant(c.ids.mEmp, { permission: "users:manage" })).status).toBe(403); // admin-only
    expect((await grant(c.ids.mEmp, { permission: "budget:read" })).status).toBe(201); // held → may pass on
    expect((await grant(c.ids.mEmp, { permission: "tasks:assign_dept", departmentId: "marketing" })).status).toBe(201); // tasks:assign_any covers it
    expect(c.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM user_permissions WHERE user_id = ? AND permission_id IN ('agents:manage','agent_chat:read_others','employees:manage_dept','users:manage')", c.ids.mEmp,
    )!.n).toBe(0);

    // the platform administrator keeps every legitimate capability
    expect((await c.admin.post(`/api/employees/${c.ids.mEmp}/grants`, { permission: "agents:manage" })).status).toBe(201);

    // a store / franchise account is never granted HQ permissions (route and domain both refuse)
    const unitId = franchise(c);
    const store = uid("usr");
    c.db.run(
      "INSERT INTO users (id, username, display_name, password_hash, created_at, home_unit_id) VALUES (?, 's0.store', 'Diler', 'x', ?, ?)",
      store, T(), unitId,
    );
    expect((await c.admin.post(`/api/employees/${store}/grants`, { permission: "budget:read" })).status).toBe(404);
    expect(() => grantPermission(c.deps, loadUser(c.db, c.ids.director)!, store, { permission: "budget:read" })).toThrow();
  });

  it("appointing a department head (which hands over the head role) needs every right of that role", async () => {
    const c = await org();
    const dir = await c.login("dir");
    expect((await dir.put("/api/departments/finance/head", { userId: c.ids.fEmp })).status).toBe(403);
    expect(c.db.get<{ h: string | null }>("SELECT head_user_id h FROM departments WHERE id = 'finance'")!.h).toBeNull();
    expect((await c.admin.put("/api/departments/finance/head", { userId: c.ids.fEmp })).status).toBe(200);
  });
});
