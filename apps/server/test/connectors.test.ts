// Agent actions through connectors: permissions, read tools, approval-gated write tools, real request shapes
// (against a fake HTTP layer — no network, no real tokens), encrypted credential storage.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Db } from "../src/db/db.js";
import { seed } from "../src/db/seed.js";
import { buildApp } from "../src/app.js";
import { ADMIN_PW, adminClient, client, loginCookie } from "./helpers.js";
import { AgentRunner } from "../src/agents/runner.js";
import { MockLlm } from "../src/llm/mock.js";
import { createTask, getTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";
import { SecretStore, parseKey } from "../src/connectors/secrets.js";
import { ingestDocument } from "../src/knowledge/service.js";
import type { ConnectorConfig } from "../src/connectors/hub.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeHttp() {
  const calls: Call[] = [];
  const http = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    calls.push({ url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), body });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      if (body.includes("grant_type=authorization_code"))
        return ok({ refresh_token: "refresh-from-consent", access_token: "at-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.send", id_token: `x.${Buffer.from(JSON.stringify({ email: "office@sag.uz" })).toString("base64url")}.y` });
      return ok({ access_token: "access-token-xyz", expires_in: 3600 });
    }
    if (u.includes("/gmail/v1/users/me/messages/send")) return ok({ id: "m-1", threadId: "t-1" });
    if (u.includes("/gmail/v1/users/me/messages?")) return ok({ messages: [{ id: "m-9" }] });
    if (u.includes("/gmail/v1/users/me/messages/m-9")) return ok({ snippet: "Narxlar ro'yxati ilova qilindi", payload: { headers: [{ name: "Subject", value: "Narxlar" }, { name: "From", value: "diler@x.uz" }] } });
    if (u.includes("sheets.googleapis.com") && u.includes(":append")) return ok({ updates: { updatedRange: "Sotuv!A10:C11", updatedRows: 2 } });
    if (u.startsWith("https://slack.com/api/chat.postMessage")) return ok({ ok: true, channel: "C1", ts: "1.2" });
    return new Response(JSON.stringify({ error: { message: "unexpected " + u } }), { status: 404 });
  }) as typeof fetch;
  return { http, calls };
}

const KEY = randomBytes(32).toString("base64");

async function setup(o: { reply?: ConstructorParameters<typeof MockLlm>[0]; connectors?: Partial<ConnectorConfig> } = {}) {
  const db = new Db(":memory:");
  db.migrate();
  await seed(db, { adminPassword: ADMIN_PW });
  const fake = fakeHttp();
  const llm = new MockLlm(o.reply ?? "ok");
  const cfg: ConnectorConfig = { publicUrl: "http://localhost:5173", secretsKey: KEY, google: {}, ...o.connectors };
  const { app, deps } = await buildApp({ db, llm: { client: llm, pricing: { inputPerM: 0, outputPerM: 0 } }, connectors: cfg, http: fake.http });
  await app.ready();
  const posted: string[] = [];
  deps.telegram = { postToGroup: (t: string) => posted.push(t), active: true } as never;
  const runner = new AgentRunner(deps, llm, { inputPerM: 0, outputPerM: 0 }, { concurrency: 1, pollMs: 50, taskTimeoutMs: 5000, retryDelayMs: 1, settleMs: 1, tools: deps.connectors });
  const run = async () => {
    for (let i = 0; i < 10; i++) {
      const s = runner.tick();
      if (!s.length && runner.activeCount === 0) return;
      await Promise.all(s);
    }
  };
  const admin = await adminClient(app);
  return { app, db, deps, llm, runner, run, admin, posted, ...fake };
}

const agentOf = (db: Db, dep: string) => db.get<{ id: string }>("SELECT id FROM agents WHERE department_id = ? ORDER BY workstation LIMIT 1", dep)!.id;
const toolNames = (s: Awaited<ReturnType<typeof setup>>, agent: string) => s.deps.connectors.toolsFor(agent).map((t) => t.name);

describe("connectors: permissions and state", () => {
  it("agents get internal read tools by default; everything else only by grant, read vs write separately, and only when connected", async () => {
    const s = await setup({ connectors: { google: { clientId: "cid", clientSecret: "sec", refreshToken: "env-refresh" } } });
    const recep = agentOf(s.db, "reception"); // department may use telegram, gmail, calendar
    expect(toolNames(s, recep)).toEqual(["search_company_knowledge", "list_company_people", "propose_company_memory"]);
    expect((await s.admin.put(`/api/agents/${recep}/connectors`, { connectorIds: ["gmail", "telegram"] })).status).toBe(200);
    expect(toolNames(s, recep)).toContain("gmail_search");
    expect(toolNames(s, recep)).not.toContain("gmail_send"); // read only
    await s.admin.put(`/api/agents/${recep}/connectors`, { connectorIds: ["gmail", "telegram"], writeIds: ["gmail"] });
    expect(toolNames(s, recep)).toEqual(expect.arrayContaining(["gmail_search", "gmail_send"]));
    expect(toolNames(s, recep)).not.toContain("telegram_post_group");
    // a connector the department is not allowed to use cannot be granted
    expect((await s.admin.put(`/api/agents/${recep}/connectors`, { connectorIds: ["slack"] })).status).toBe(400);
    const st = (await s.admin.get("/api/connectors/status")).body;
    const by = (id: string) => st.connectors.find((c: { id: string }) => c.id === id);
    expect(by("gmail")).toMatchObject({ implemented: true, connected: true });
    expect(by("slack")).toMatchObject({ implemented: true, connected: false, setup: ["SLACK_BOT_TOKEN"] });
    expect(by("crm")).toMatchObject({ implemented: false });
    expect(by("crm").reason).toMatch(/Bitrix24|amoCRM/);
    expect(JSON.stringify(st)).not.toContain("env-refresh"); // tokens never leave the server
  });

  it("without Google OAuth config Gmail is not connected and its tools are not offered", async () => {
    const s = await setup();
    const recep = agentOf(s.db, "reception");
    await s.admin.put(`/api/agents/${recep}/connectors`, { connectorIds: ["gmail"], writeIds: ["gmail"] });
    expect(toolNames(s, recep)).not.toContain("gmail_send");
    const gm = (await s.admin.get("/api/connectors/status")).body.connectors.find((c: { id: string }) => c.id === "gmail");
    expect(gm.setup).toContain("GOOGLE_CLIENT_ID");
  });
});

describe("connectors: agent tool loop", () => {
  it("read tool: the agent searches the knowledge base, then answers; the call is logged and listed under the result", async () => {
    let n = 0;
    const s = await setup({
      reply: (req) => {
        n++;
        if (n === 1) {
          expect(req.tools?.map((t) => t.name)).toContain("search_company_knowledge");
          return { toolCalls: [{ name: "search_company_knowledge", args: { query: "Vandewiele dastgohlari" } }] };
        }
        const results = req.messages.at(-1)?.toolResults?.[0]?.response as { results: { source: string; text: string }[] };
        return `Javob: ${results.results[0].source}`;
      },
    });
    await ingestDocument(s.deps, { filename: "uskunalar.md", title: "Uskunalar", data: new TextEncoder().encode("To'quv sexida 30 ta Vandewiele va 7 ta Schönherr dastgohi bor."), departmentId: null }, SYSTEM);
    const t = createTask(s.deps, { title: "Nechta dastgoh bor?", departmentId: "marketing" }, SYSTEM);
    await s.run();
    const done = getTask(s.deps, t.id);
    expect(done.status).toBe("DONE");
    const d = s.db.get<{ content: string }>("SELECT content FROM deliverables WHERE task_id = ?", t.id)!.content;
    expect(d).toContain("Javob: Uskunalar");
    expect(d).toContain("## Amallar");
    expect(d).toContain("bajarildi");
    expect(s.db.get("SELECT tool, status FROM tool_executions WHERE task_id = ?", t.id)).toEqual({ tool: "search_company_knowledge", status: "succeeded" });
  });

  it("write tool: becomes an approval; nothing is sent until a person approves; runs exactly once", async () => {
    let n = 0;
    const s = await setup({
      reply: () => (n++ === 0 ? { toolCalls: [{ name: "telegram_post_group", args: { text: "Yangi kolleksiya: Movarounnahr" } }] } : "Xabar tasdiqqa yuborildi."),
    });
    const recep = agentOf(s.db, "reception");
    await s.admin.put(`/api/agents/${recep}/connectors`, { connectorIds: ["telegram"], writeIds: ["telegram"] });
    const t = createTask(s.deps, { title: "Guruhga e'lon", agentId: recep }, SYSTEM);
    await s.run();
    expect(getTask(s.deps, t.id).status).toBe("DONE");
    expect(s.posted).toEqual([]); // not sent yet
    const d = s.db.get<{ content: string }>("SELECT content FROM deliverables WHERE task_id = ?", t.id)!.content;
    expect(d).toContain("tasdiqqa yuborildi");
    const ap = (await s.admin.get("/api/approvals")).body.approvals.find((a: { action: string }) => a.action === "tool:telegram_post_group");
    expect(ap.payload.summary).toContain("Movarounnahr");
    // reject needs a reason
    expect((await s.admin.post(`/api/approvals/${ap.id}/decide`, { decision: "reject" })).status).toBe(400);
    const r = await s.admin.post(`/api/approvals/${ap.id}/decide`, { decision: "approve" });
    expect(r.status).toBe(200);
    expect(r.body.execution).toMatchObject({ status: "succeeded", tool: "telegram_post_group" });
    expect(s.posted).toEqual(["Yangi kolleksiya: Movarounnahr"]);
    expect((await s.admin.post(`/api/approvals/${ap.id}/decide`, { decision: "approve" })).status).toBe(409);
    expect(s.posted).toHaveLength(1);
    const audit = s.db.all<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'tool.%'").map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["tool.propose", "tool.decide", "tool.execute"]));
  });

  it("gmail: search runs at once, send waits for approval and then sends a proper message with the refreshed token", async () => {
    let n = 0;
    const s = await setup({
      connectors: { google: { clientId: "cid", clientSecret: "sec", refreshToken: "env-refresh" } },
      reply: () =>
        n++ === 0
          ? { toolCalls: [{ name: "gmail_search", args: { query: "from:diler@x.uz" } }, { name: "gmail_send", args: { to: "diler@x.uz", subject: "Javob: narxlar", body: "Assalomu alaykum! Narxlar ilova qilindi." } }] }
          : "Tayyor.",
    });
    const recep = agentOf(s.db, "reception");
    await s.admin.put(`/api/agents/${recep}/connectors`, { connectorIds: ["gmail"], writeIds: ["gmail"] });
    const t = createTask(s.deps, { title: "Dilerga javob", agentId: recep }, SYSTEM);
    await s.run();
    expect(s.calls.some((c) => c.url.includes("messages/send"))).toBe(false);
    const ex = s.db.all<{ tool: string; status: string; output: string | null }>("SELECT tool, status, output FROM tool_executions WHERE task_id = ? ORDER BY tool", t.id);
    expect(ex.map((e) => [e.tool, e.status])).toEqual([["gmail_search", "succeeded"], ["gmail_send", "pending_approval"]]);
    expect(ex[0].output).toContain("Narxlar");
    const ap = s.db.get<{ id: string }>("SELECT id FROM approvals WHERE action = 'tool:gmail_send'")!;
    const r = await s.admin.post(`/api/approvals/${ap.id}/decide`, { decision: "approve" });
    expect(r.body.execution.status).toBe("succeeded");
    const send = s.calls.find((c) => c.url.includes("messages/send"))!;
    expect(send.headers.authorization).toBe("Bearer access-token-xyz");
    const raw = Buffer.from(JSON.parse(send.body).raw, "base64url").toString();
    expect(raw).toContain("To: diler@x.uz");
    expect(raw).toContain(`Subject: Javob: narxlar`);
    expect(Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString()).toContain("Narxlar ilova qilindi");
    const token = s.calls.find((c) => c.url.includes("oauth2.googleapis.com/token"))!;
    expect(token.body).toContain("grant_type=refresh_token");
  });

  it("invalid or not-permitted calls never reach the outside world", async () => {
    let n = 0;
    const s = await setup({
      connectors: { google: { clientId: "cid", clientSecret: "sec", refreshToken: "r" }, slackToken: "xoxb-test" },
      reply: () =>
        n++ === 0
          ? { toolCalls: [{ name: "gmail_send", args: { to: "not-an-email", subject: "x", body: "y" } }, { name: "slack_post_message", args: { channel: "#x", text: "hi" } }] }
          : "Bajarilmadi.",
    });
    const recep = agentOf(s.db, "reception");
    await s.admin.put(`/api/agents/${recep}/connectors`, { connectorIds: ["gmail"], writeIds: ["gmail"] });
    const t = createTask(s.deps, { title: "x", agentId: recep }, SYSTEM);
    await s.run();
    const ex = s.db.all<{ tool: string; status: string; error: string }>("SELECT tool, status, error FROM tool_executions WHERE task_id = ? ORDER BY tool", t.id);
    expect(ex[0]).toMatchObject({ tool: "gmail_send", status: "failed" });
    expect(ex[0].error).toMatch(/validation/);
    expect(ex.find((e) => e.tool === "slack_post_message")).toMatchObject({ status: "denied" }); // not granted: refused and logged
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) n FROM approvals WHERE action LIKE 'tool:%'")!.n).toBe(0);
    expect(s.calls.filter((c) => !c.url.includes("oauth2"))).toHaveLength(0);
  });

  it("create_employee_task runs with the approver's rights", async () => {
    let n = 0;
    const s = await setup({ reply: () => (n++ === 0 ? { toolCalls: [{ name: "create_employee_task", args: { title: "Diler bilan uchrashuv", assignee_name: "Aziza Yusupova" } }] } : "OK") });
    const emp = (await s.admin.post("/api/employees", { username: "aziza", displayName: "Aziza Yusupova", password: "Str0ng-pass-123", departmentId: "marketing", roles: ["employee"] })).body.employee.id;
    const mk = agentOf(s.db, "marketing");
    await s.admin.put(`/api/agents/${mk}/connectors`, { connectorIds: ["internal-api"], writeIds: ["internal-api"] }).catch(() => null);
    // internal-api is not a marketing connector → grant via a department that has it is required; give marketing access
    await s.admin.put("/api/connectors/internal-api/departments", { departmentIds: ["it", "digital", "marketing"] });
    await s.admin.put(`/api/agents/${mk}/connectors`, { connectorIds: ["internal-api"], writeIds: ["internal-api"] });
    const t = createTask(s.deps, { title: "Uchrashuv tashkil qil", agentId: mk }, SYSTEM);
    await s.run();
    const ap = s.db.get<{ id: string }>("SELECT id FROM approvals WHERE action = 'tool:create_employee_task'")!;
    // an employee without assign rights cannot even decide (tasks:manage)
    const e = client(s.app, await loginCookie(s.app, "aziza", "Str0ng-pass-123"));
    expect((await e.post(`/api/approvals/${ap.id}/decide`, { decision: "approve" })).status).toBe(403);
    const r = await s.admin.post(`/api/approvals/${ap.id}/decide`, { decision: "approve" });
    expect(r.body.execution.status).toBe("succeeded");
    const w = s.db.get<{ assignee_user_id: string; created_by: string; kind: string }>("SELECT assignee_user_id, created_by, kind FROM tasks WHERE title = 'Diler bilan uchrashuv'")!;
    expect(w).toMatchObject({ assignee_user_id: emp, kind: "human" });
    expect(t).toBeTruthy();
  });
});

describe("connectors: credentials", () => {
  it("stores OAuth refresh tokens encrypted; a wrong key cannot read them; state must match", async () => {
    const s = await setup({ connectors: { google: { clientId: "cid", clientSecret: "sec" } } });
    const start = await s.app.inject({ method: "GET", url: "/api/connectors/google/start", headers: { cookie: await loginCookie(s.app, "admin", ADMIN_PW) } });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/connectors/google/callback");
    const bad = await s.app.inject({ method: "GET", url: "/api/connectors/google/callback?code=c&state=forged" });
    expect(bad.headers.location).toContain("google_error");
    const ok = await s.app.inject({ method: "GET", url: `/api/connectors/google/callback?code=c&state=${loc.searchParams.get("state")}` });
    expect(ok.headers.location).toContain("google_connected");
    const row = s.db.get<{ ciphertext: Uint8Array; account: string }>("SELECT ciphertext, account FROM connector_secrets WHERE provider = 'google'")!;
    expect(row.account).toBe("office@sag.uz");
    expect(Buffer.from(row.ciphertext).toString()).not.toContain("refresh-from-consent");
    expect(new SecretStore(s.db, parseKey(KEY)).get("google")).toBe("refresh-from-consent");
    expect(new SecretStore(s.db, parseKey(randomBytes(32).toString("base64"))).get("google")).toBeNull();
    // state is single use
    const again = await s.app.inject({ method: "GET", url: `/api/connectors/google/callback?code=c&state=${loc.searchParams.get("state")}` });
    expect(again.headers.location).toContain("google_error");
    expect((await s.admin.get("/api/connectors/status")).body.google).toMatchObject({ connected: true, account: "office@sag.uz" });
  });

  it("refuses to start OAuth without a SECRETS_KEY to protect the token", async () => {
    const s = await setup({ connectors: { secretsKey: undefined, google: { clientId: "cid", clientSecret: "sec" } } });
    const r = await s.app.inject({ method: "GET", url: "/api/connectors/google/start", headers: { cookie: await loginCookie(s.app, "admin", ADMIN_PW) } });
    expect(r.statusCode).toBe(400);
  });
});
