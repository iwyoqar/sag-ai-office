// W2.1 Integration Hub core: registry, scoped instances, encrypted credentials, tool authorization in order,
// approval-gated writes, retries (reads only), idempotency, health and rate limits. No real provider is called:
// a fake HTTP layer stands in for Slack.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { Db } from "../src/db/db.js";
import { seed } from "../src/db/seed.js";
import { buildApp } from "../src/app.js";
import { ADMIN_PW, adminClient, client, loginCookie } from "./helpers.js";
import { importStores } from "../src/import/stores.js";
import { REGISTRY, registryProblems } from "../src/connectors/registry.js";
import { CredentialVault } from "../src/connectors/vault.js";
import { TOOLS } from "../src/connectors/tools.js";
import { createTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";
import { MockLlm } from "../src/llm/mock.js";

const PW = "Str0ng-pass-123";
const KEY = randomBytes(32).toString("base64");
const UNIT_TOKEN = "xoxb-unit-secret-token-123456";

function workbook(rows: string[][]): Uint8Array {
  const cols = "ABCDEF";
  const sheetRows = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v ? `<c r="${cols[j]}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>` : "")).join("")}</row>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
  });
}

/** Slack fake: scripted responses per endpoint, every call recorded (with its Authorization header). */
function fakeSlack() {
  const calls: { url: string; auth: string }[] = [];
  const script: Record<string, (() => Response)[]> = {};
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
  const http = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: String((init.headers as Record<string, string> | undefined)?.authorization ?? "") });
    const key = Object.keys(script).find((k) => u.includes(k));
    const next = key ? script[key].shift() : undefined;
    if (next) return next();
    if (u.includes("auth.test")) return ok({ ok: true, team: "SAG" });
    if (u.includes("conversations.list")) return ok({ ok: true, channels: [{ id: "C1", name: "savdo" }] });
    if (u.includes("chat.postMessage")) return ok({ ok: true, channel: "C1", ts: "1.2" });
    return ok({ ok: false, error: "unexpected" }, 404);
  }) as typeof fetch;
  return { http, calls, script, ok };
}

async function world(o: { callsPerMinute?: number } = {}) {
  const db = new Db(":memory:");
  db.migrate();
  await seed(db, { adminPassword: ADMIN_PW });
  const fake = fakeSlack();
  const { app, deps } = await buildApp({
    db, http: fake.http, llm: { client: new MockLlm("ok"), pricing: { inputPerM: 0, outputPerM: 0 } },
    connectors: { publicUrl: "http://localhost:5173", secretsKey: KEY, google: {}, slackToken: "xoxb-hq-env-token-0000" },
    connectorReliability: { readRetry: { attempts: 3, baseDelayMs: 1 }, toolTimeoutMs: 200, callsPerMinute: o.callsPerMinute ?? 60 },
  });
  await app.ready();
  importStores(deps, workbook([["Samarkand Sag Magazin"], ["Sag Filial", "", "hd"], ["Sag Franshiza", "", "f"], ["Sag Ikkinchi", "", "f"], [], ["Navoiy Sag Magazin"], ["Sag Navoiy", "", "hd"]]), "x.xlsx", true);
  const admin = await adminClient(app);
  const unit = (name: string) => db.get<{ id: string }>("SELECT id FROM org_nodes WHERE name = ?", name)!.id;
  const director = async (name: string, username: string) => {
    const id = unit(name);
    const r = await admin.post(`/api/units/${id}/director`, { displayName: name, username });
    await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: r.body.activationToken, password: PW } });
    return { unitId: id, api: client(app, await loginCookie(app, username, PW)), ai: db.get<{ id: string }>("SELECT id FROM agents WHERE business_unit_id = ? AND is_primary_director = 1", id)!.id };
  };
  const branch = await director("Sag Filial", "d.filial");
  const fran = await director("Sag Franshiza", "d.fran");
  const fran2 = await director("Sag Ikkinchi", "d.fran2");
  const navoiy = await director("Sag Navoiy", "d.navoiy");
  const hqDir = await (async () => {
    await admin.post("/api/employees", { username: "hq.dir", displayName: "hq.dir", password: PW, roles: ["director"], departmentId: "director", jobTitle: "d" });
    return client(app, await loginCookie(app, "hq.dir", PW));
  })();
  /** install Slack in a unit, store the unit's own token, grant its AI Director read (+write) */
  const slackFor = async (w: Awaited<ReturnType<typeof director>>, write = true) => {
    const inst = (await admin.post(`/api/units/${w.unitId}/connectors`, { connectorId: "slack" })).body.connector;
    const set = await w.api.put(`/api/integrations/instances/${inst.id}/credentials`, { method: "API_KEY", secret: UNIT_TOKEN });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await w.api.put(`/api/units/${w.unitId}/agents/${w.ai}/connectors`, { connectorIds: ["slack"], writeIds: write ? ["slack"] : [] })).status).toBe(200);
    return inst.id as string;
  };
  return { db, app, deps, hub: deps.connectors, fake, admin, unit, branch, fran, fran2, navoiy, hqDir, slackFor };
}

const runRow = (db: Db, agentId: string) => {
  db.run("INSERT OR IGNORE INTO agent_runs (id, agent_id, correlation_id, model, mode, status, started_at) VALUES ('run1', ?, 'c', 'm', 'mock', 'succeeded', ?)", agentId, new Date().toISOString());
  return "run1";
};

// ---------------------------------------------------------------------------------------------- registry
describe("connector registry", () => {
  it("is consistent: every executable tool belongs to an AVAILABLE definition; planned ones expose nothing", () => {
    expect(registryProblems()).toEqual([]);
    for (const t of TOOLS) expect(REGISTRY.find((d) => d.id === t.connector)?.status).toBe("AVAILABLE");
    for (const id of ["anthropic", "bitrix24", "sap"]) {
      const d = REGISTRY.find((x) => x.id === id)!;
      expect(d.status).not.toBe("AVAILABLE");
      expect(d).toMatchObject({ actions: [], implementedAuth: [], healthCheck: false });
    }
    expect(REGISTRY.find((d) => d.id === "sap")!.status).toBe("DISCOVERY");
    // a definition whose tool is missing from AVAILABLE is caught
    expect(registryProblems(REGISTRY.filter((d) => d.id !== "slack"))).toContain("tool slack_post_message has no AVAILABLE definition");
  });

  it("catalog API: definitions only — nothing claims to be connected", async () => {
    const w = await world();
    const cat = (await w.admin.get("/api/integrations/catalog")).body.connectors;
    expect(cat.find((c: { id: string }) => c.id === "bitrix24")).toMatchObject({ status: "PLANNED", actions: [], storableAuth: [] });
    expect(cat.find((c: { id: string }) => c.id === "slack")).toMatchObject({ status: "AVAILABLE", storableAuth: ["API_KEY"] });
    expect(JSON.stringify(cat)).not.toMatch(/"connected"/);
  });
});

// ---------------------------------------------------------------------------------------------- credentials
describe("credential vault", () => {
  const setup = async () => {
    const db = new Db(":memory:");
    db.migrate();
    await seed(db, { adminPassword: ADMIN_PW });
    const key = randomBytes(32);
    const by = db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
    return { db, key, by, vault: new CredentialVault(db, key) };
  };

  it("encrypts at rest, binds each secret to its instance, rotates, revokes and expires", async () => {
    const { db, key, by, vault } = await setup();
    const m = vault.store("ci_hq_slack", "API_KEY", "xoxb-secret-AAA", { by });
    const row = db.get<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM connector_credentials WHERE id = ?", m.id)!;
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain("secret-AAA");
    expect(vault.resolve("ci_hq_slack", "API_KEY")).toBe("xoxb-secret-AAA");
    expect(new CredentialVault(db, randomBytes(32)).resolve("ci_hq_slack", "API_KEY")).toBeNull(); // other key
    // the same ciphertext moved to another instance does not decrypt (AAD)
    db.run("UPDATE connector_credentials SET instance_id = 'ci_hq_notion' WHERE id = ?", m.id);
    expect(new CredentialVault(db, key).resolve("ci_hq_notion", "API_KEY")).toBeNull();
    db.run("UPDATE connector_credentials SET instance_id = 'ci_hq_slack' WHERE id = ?", m.id);
    // rotation keeps one ACTIVE
    const m2 = vault.store("ci_hq_slack", "API_KEY", "xoxb-secret-BBB", { by });
    expect(vault.meta("ci_hq_slack").map((x) => [x.id === m2.id, x.status])).toEqual([[true, "ACTIVE"], [false, "ROTATED"]]);
    expect(m2.rotatedFrom).toBe(m.id);
    expect(vault.resolve("ci_hq_slack", "API_KEY")).toBe("xoxb-secret-BBB");
    vault.revoke(m2.id, by);
    expect(vault.resolve("ci_hq_slack", "API_KEY")).toBeNull();
    vault.store("ci_hq_slack", "API_KEY", "xoxb-secret-CCC", { by, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(vault.resolve("ci_hq_slack", "API_KEY")).toBeNull();
    expect(vault.meta("ci_hq_slack")[0].status).toBe("EXPIRED");
    expect(() => new CredentialVault(db, null).store("ci_hq_slack", "API_KEY", "x-secret-value", { by })).toThrow(/SECRETS_KEY/);
  });

  it("secrets never come back: API responses, instance lists and the audit trail carry only a fingerprint", async () => {
    const w = await world();
    const inst = await w.slackFor(w.fran);
    const all = JSON.stringify([
      (await w.fran.api.get("/api/integrations/instances")).body,
      (await w.fran.api.get("/api/integrations/audit")).body,
      w.db.all("SELECT metadata FROM audit_logs"),
    ]);
    expect(all).not.toContain(UNIT_TOKEN);
    const mine = (await w.fran.api.get("/api/integrations/instances")).body.instances.find((i: { id: string }) => i.id === inst);
    expect(mine.credentials[0]).toMatchObject({ method: "API_KEY", status: "ACTIVE" });
    expect(mine.credentials[0].fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // methods the code cannot use are refused, never stored
    expect((await w.fran.api.put(`/api/integrations/instances/${inst}/credentials`, { method: "OAUTH2", secret: "something-long" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------- scopes & isolation
describe("instances: scope ownership and franchise isolation", () => {
  it("a franchise's connector and keys are its own: nobody else sees or manages them", async () => {
    const w = await world();
    const inst = await w.slackFor(w.fran);
    const ids = async (api: typeof w.admin) => ((await api.get("/api/integrations/instances")).body.instances ?? []).map((i: { id: string }) => i.id);
    expect(await ids(w.fran2.api)).not.toContain(inst);
    expect(await ids(w.branch.api)).not.toContain(inst);
    expect(await ids(w.hqDir)).not.toContain(inst); // HQ group level sees branches, not franchises
    expect(await ids(w.admin)).toContain(inst); // platform admin: structure metadata
    for (const api of [w.admin, w.hqDir, w.fran2.api, w.branch.api])
      expect([403, 404]).toContain((await api.put(`/api/integrations/instances/${inst}/credentials`, { method: "API_KEY", secret: "xoxb-hijack-000000" })).status);
    expect([403, 404]).toContain((await w.fran2.api.post(`/api/integrations/instances/${inst}/health`)).status);
  });

  it("region/group instances reach a unit only by explicit assignment, and never a franchise or a unit outside the scope", async () => {
    const w = await world();
    const region = w.db.get<{ parent_id: string }>("SELECT parent_id FROM org_nodes WHERE id = ?", w.branch.unitId)!.parent_id;
    expect((await w.branch.api.post("/api/integrations/instances", { scopeNodeId: region, connectorId: "slack" })).status).toBe(403);
    expect((await w.admin.post("/api/integrations/instances", { scopeNodeId: w.branch.unitId, connectorId: "slack" })).status).toBe(400);
    expect((await w.admin.post("/api/integrations/instances", { scopeNodeId: region, connectorId: "bitrix24" })).status).toBe(400); // planned
    const shared = (await w.admin.post("/api/integrations/instances", { scopeNodeId: region, connectorId: "slack" })).body.instance;
    expect(shared).toMatchObject({ scopeLevel: "REGION", unitId: null, credentialScope: "SECRET_STORE" });
    await w.admin.put(`/api/integrations/instances/${shared.id}/credentials`, { method: "API_KEY", secret: "xoxb-region-token-000" });

    // region membership alone: the branch's agent has no Slack
    expect(w.hub.instanceFor(w.branch.unitId, "slack")).toBeUndefined();
    expect((await w.admin.put(`/api/integrations/instances/${shared.id}/assignments/${w.fran.unitId}`, {})).status).toBe(400); // franchise
    expect((await w.admin.put(`/api/integrations/instances/${shared.id}/assignments/${w.navoiy.unitId}`, {})).status).toBe(400); // other region
    expect((await w.admin.put(`/api/integrations/instances/${shared.id}/assignments/${w.branch.unitId}`, {})).status).toBe(200);
    expect(w.hub.instanceFor(w.branch.unitId, "slack")?.id).toBe(shared.id);
    expect(() => w.db.run("INSERT INTO connector_instance_assignments VALUES (?, ?, 'x', 't')", shared.id, w.fran.unitId)).toThrow(/cross_unit/);
    // the assigned branch's leads see it read-only
    const seen = (await w.branch.api.get("/api/integrations/instances")).body.instances.find((i: { id: string }) => i.id === shared.id);
    expect(seen.can).toEqual({ manageCredentials: false, checkHealth: false, assign: false });
    expect(JSON.stringify(seen)).not.toContain("xoxb-region-token");
  });
});

// ---------------------------------------------------------------------------------------------- authorization
describe("agent tool authorization", () => {
  it("checks identity, unit, assignment, permission, scopes, read/write and connection — in that order, with a reason", async () => {
    const w = await world();
    const ai = w.fran.ai;
    const t = createTask(w.deps, { title: "Slack", agentId: ai, unitId: w.fran.unitId }, SYSTEM);
    const other = createTask(w.deps, { title: "Boshqa", agentId: w.fran2.ai, unitId: w.fran2.unitId }, SYSTEM);
    const auth = (tool: string, taskId: string | null = t.id, agent = ai) => w.hub.authorizeTool(agent, taskId, tool);
    expect(auth("slack_list_channels")).toEqual({ ok: false, reason: "not_assigned" });
    const inst = (await w.admin.post(`/api/units/${w.fran.unitId}/connectors`, { connectorId: "slack" })).body.connector.id;
    expect(auth("slack_list_channels")).toEqual({ ok: false, reason: "tool_not_permitted" });
    await w.fran.api.put(`/api/units/${w.fran.unitId}/agents/${ai}/connectors`, { connectorIds: ["slack"] }); // read only
    expect(auth("slack_list_channels")).toEqual({ ok: false, reason: "not_connected" }); // no key yet
    await w.fran.api.put(`/api/integrations/instances/${inst}/credentials`, { method: "API_KEY", secret: UNIT_TOKEN });
    expect(auth("slack_list_channels")).toEqual({ ok: true, instanceId: inst, mode: "auto" });
    expect(auth("slack_post_message")).toEqual({ ok: false, reason: "write_not_permitted" });
    await w.fran.api.put(`/api/units/${w.fran.unitId}/agents/${ai}/connectors`, { connectorIds: ["slack"], writeIds: ["slack"] });
    expect(auth("slack_post_message")).toEqual({ ok: true, instanceId: inst, mode: "approval" });
    expect(auth("slack_list_channels", other.id)).toEqual({ ok: false, reason: "unit_mismatch" });
    expect(auth("gmail_search")).toEqual({ ok: false, reason: "not_assigned" });
    expect(auth("list_company_people")).toEqual({ ok: false, reason: "tool_not_permitted" }); // HQ internal tool
    expect(auth("http_get")).toEqual({ ok: false, reason: "unknown_tool" }); // no generic HTTP tool exists
    w.db.run("UPDATE agents SET lifecycle = 'PAUSED' WHERE id = ?", ai);
    expect(auth("slack_list_channels")).toEqual({ ok: false, reason: "agent_inactive" });
  });

  it("Google tools need the scopes the account actually granted", async () => {
    const w = await world();
    w.hub.secrets.put("google", "refresh-token-value", { account: "office@sag.uz", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
    const hqAgent = w.db.get<{ id: string }>("SELECT id FROM agents WHERE department_id = 'reception' ORDER BY workstation LIMIT 1")!.id;
    await w.admin.put(`/api/agents/${hqAgent}/connectors`, { connectorIds: ["gmail"], writeIds: ["gmail"] });
    expect(w.hub.authorizeTool(hqAgent, null, "gmail_send")).toEqual({ ok: false, reason: "missing_scope" });
  });

  it("a write waits for a person, runs once with the unit's own key, and is re-authorised at approval time", async () => {
    const w = await world();
    await w.slackFor(w.fran);
    const t = createTask(w.deps, { title: "E'lon", agentId: w.fran.ai, unitId: w.fran.unitId }, SYSTEM);
    const call = () => w.hub.invoke({ taskId: t.id, agentId: w.fran.ai, runId: runRow(w.db, w.fran.ai), correlationId: "c" }, { name: "slack_post_message", args: { channel: "C1", text: "Yangi aksiya" } });
    const r = await call();
    expect(r).toMatchObject({ status: "pending_approval" });
    expect((await call()).approvalId).toBe(r.approvalId); // idempotent: the same action joins the waiting request
    expect(w.fake.calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(0);
    const approver = (await import("../src/lib/auth.js")).loadUser(w.db, w.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id)!;
    const ex = await w.hub.decide(r.approvalId as string, "approve", undefined, approver);
    expect(ex).toMatchObject({ status: "succeeded" });
    const posts = w.fake.calls.filter((c) => c.url.includes("chat.postMessage"));
    expect(posts).toHaveLength(1);
    expect(posts[0].auth).toBe(`Bearer ${UNIT_TOKEN}`); // the franchise's key — not HQ's environment token

    // permissions withdrawn while a request waits: approval refuses to run it
    const r2 = await w.hub.invoke({ taskId: t.id, agentId: w.fran.ai, runId: "run1", correlationId: "c" }, { name: "slack_post_message", args: { channel: "C1", text: "Ikkinchi" } });
    await w.admin.patch(`/api/units/${w.fran.unitId}/connectors/slack`, { enabled: false });
    await expect(w.hub.decide(r2.approvalId as string, "approve", undefined, approver)).rejects.toThrow(/endi bajarib bo'lmaydi/);
    expect(w.fake.calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------- reliability
describe("connector reliability", () => {
  it("reads retry transient failures, never auth failures; writes never retry and an unknowable outcome is 'unknown'", async () => {
    const w = await world();
    await w.slackFor(w.fran);
    const t = createTask(w.deps, { title: "x", agentId: w.fran.ai, unitId: w.fran.unitId }, SYSTEM);
    const ctx = { taskId: t.id, agentId: w.fran.ai, runId: runRow(w.db, w.fran.ai), correlationId: "c" };
    const last = () => w.db.get<{ status: string; attempts: number; error_class: string | null }>("SELECT status, attempts, error_class FROM tool_executions ORDER BY rowid DESC LIMIT 1")!;
    w.fake.script["conversations.list"] = [() => w.fake.ok({ ok: false, error: "busy" }, 503), () => w.fake.ok({ ok: false, error: "busy" }, 503)];
    expect(await w.hub.invoke(ctx, { name: "slack_list_channels", args: {} })).not.toHaveProperty("error");
    expect(last()).toEqual({ status: "succeeded", attempts: 3, error_class: null });
    w.fake.script["conversations.list"] = [() => w.fake.ok({ ok: false, error: "invalid_auth" }, 401)];
    expect(await w.hub.invoke(ctx, { name: "slack_list_channels", args: {} })).toMatchObject({ reason: "auth" });
    expect(last()).toEqual({ status: "failed", attempts: 1, error_class: "auth" });

    const approver = (await import("../src/lib/auth.js")).loadUser(w.db, w.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id)!;
    const posts = () => w.fake.calls.filter((c) => c.url.includes("chat.postMessage")).length;
    const p1 = await w.hub.invoke(ctx, { name: "slack_post_message", args: { channel: "C1", text: "A" } });
    w.fake.script["chat.postMessage"] = [() => w.fake.ok({ ok: false, error: "busy" }, 503)];
    expect(await w.hub.decide(p1.approvalId as string, "approve", undefined, approver)).toMatchObject({ status: "failed" });
    expect(posts()).toBe(1); // no blind retry of a write
    const p2 = await w.hub.invoke(ctx, { name: "slack_post_message", args: { channel: "C1", text: "B" } });
    w.fake.script["chat.postMessage"] = [() => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }];
    expect(await w.hub.decide(p2.approvalId as string, "approve", undefined, approver)).toMatchObject({ status: "unknown" });
  });

  it("health checks are recorded runs; repeated connection failures take an instance DOWN; success restores it", async () => {
    const w = await world();
    const inst = await w.slackFor(w.fran);
    expect((await w.fran.api.post(`/api/integrations/instances/${inst}/health`)).body.result).toMatchObject({ ok: true });
    for (let i = 0; i < 3; i++) {
      w.fake.script["auth.test"] = [() => w.fake.ok({ ok: false, error: "invalid_auth" }, 200)];
      await w.fran.api.post(`/api/integrations/instances/${inst}/health`);
    }
    let me = (await w.fran.api.get("/api/integrations/instances")).body.instances.find((i: { id: string }) => i.id === inst);
    expect(me).toMatchObject({ healthStatus: "DOWN", consecutiveFailures: 3, lastErrorClass: "auth", status: "error" });
    const runs = (await w.fran.api.get(`/api/integrations/instances/${inst}/runs`)).body.runs;
    expect(runs.map((r: { status: string }) => r.status)).toEqual(["FAILED", "FAILED", "FAILED", "SUCCEEDED"]);
    await w.fran.api.post(`/api/integrations/instances/${inst}/health`);
    me = (await w.fran.api.get("/api/integrations/instances")).body.instances.find((i: { id: string }) => i.id === inst);
    expect(me).toMatchObject({ healthStatus: "HEALTHY", consecutiveFailures: 0 });
    const trail = (await w.fran.api.get("/api/integrations/audit")).body.items.map((a: { action: string }) => a.action);
    expect(trail).toContain("credential.set");
    expect(trail).toContain("connector.health");
    // planned connectors have no health check to run
    expect((await w.admin.post("/api/integrations/instances/ci_hq_bitrix24/health")).status).toBe(400);
  });

  it("rate limit per instance: calls beyond the window are refused before reaching the provider", async () => {
    const w = await world({ callsPerMinute: 2 });
    await w.slackFor(w.fran);
    const ctx = { taskId: null, agentId: w.fran.ai, runId: runRow(w.db, w.fran.ai), correlationId: "c" };
    for (let i = 0; i < 2; i++) await w.hub.invoke(ctx, { name: "slack_list_channels", args: {} });
    const before = w.fake.calls.length;
    expect(await w.hub.invoke(ctx, { name: "slack_list_channels", args: {} })).toMatchObject({ reason: "rate_limited" });
    expect(w.fake.calls.length).toBe(before);
  });
});
