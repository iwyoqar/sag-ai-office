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
import { canManageTask, canSeeTask, taskRef } from "../src/domain/access.js";
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
