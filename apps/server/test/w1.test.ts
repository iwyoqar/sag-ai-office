// W1 Business Unit Foundation — acceptance: unit functions, budgets in UZS minor units, unit knowledge bases with
// RAG isolation, unit connectors, AI Director verification and franchise data-sharing agreements.
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { adminClient, client, loginCookie, makeApp } from "./helpers.js";
import { importStores } from "../src/import/stores.js";
import { ingestDocument } from "../src/knowledge/service.js";
import { retrieve } from "../src/knowledge/semantic.js";
import { convert, divRoundHalfEven, formatAmount, parseAmount, parseRate } from "../src/lib/money.js";
import { AgentRunner } from "../src/agents/runner.js";
import { MockLlm } from "../src/llm/mock.js";
import { createTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";

const PW = "Str0ng-pass-123";

function workbook(rows: string[][]): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cols = "ABCDEF";
  const sheetRows = rows.map((r, i) =>
    `<row r="${i + 1}">${r.map((v, j) => (v ? `<c r="${cols[j]}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>` : "")).join("")}</row>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
  });
}

const STORES = workbook([
  ["Samarkand Sag Magazin"],
  ["Sag Kattaqo'rg'on", "", "hd"], // SAG-owned branch
  ["Sag Rudakiy", "", "f"], // franchise
  ["Sag Jomboy", "", "", "", "f"], // another franchise
]);

async function world() {
  const env = await makeApp();
  importStores(env.deps, STORES, "Книга1.xlsx", true);
  const admin = await adminClient(env.app);
  const unit = (name: string) => env.db.get<{ id: string; human_director_user_id: string }>("SELECT id, human_director_user_id FROM org_nodes WHERE name = ?", name)!;
  const director = async (storeName: string, username: string) => {
    const u = unit(storeName);
    const r = await admin.post(`/api/units/${u.id}/director`, { displayName: `Director ${storeName}`, username });
    expect(r.status).toBe(201);
    expect((await env.app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: r.body.activationToken, password: PW } })).statusCode).toBe(200);
    return { unitId: u.id, userId: u.human_director_user_id, api: client(env.app, await loginCookie(env.app, username, PW)) };
  };
  const hqUser = async (username: string, roles: string[]) => {
    const r = await admin.post("/api/employees", { username, displayName: username, password: PW, roles, departmentId: "director", jobTitle: username });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.employee.id as string, api: client(env.app, await loginCookie(env.app, username, PW)) };
  };
  const branch = await director("Sag Kattaqo'rg'on", "dir.branch");
  const fran = await director("Sag Rudakiy", "dir.franchise");
  const fran2 = await director("Sag Jomboy", "dir.franchise2");
  const hqDir = await hqUser("hq.director", ["director"]);
  const hqDir2 = await hqUser("hq.director2", ["director"]);
  return { ...env, admin, unit, director, branch, fran, fran2, hqDir, hqDir2, hqUser };
}

const aiDirectorOf = (db: Awaited<ReturnType<typeof makeApp>>["db"], unitId: string) =>
  db.get<{ id: string }>("SELECT id FROM agents WHERE business_unit_id = ? AND is_primary_director = 1", unitId)!.id;

// ------------------------------------------------------------------------------------------------ functions
describe("W1 unit functions", () => {
  it("HQ is HEADQUARTERS+OFFICE, imported stores RETAIL; functions never change ownership", async () => {
    const w = await world();
    const fn = (id: string) => JSON.parse(w.db.get<{ functions: string }>("SELECT functions FROM org_nodes WHERE id = ?", id)!.functions);
    expect(fn("hq")).toEqual(["HEADQUARTERS", "OFFICE"]);
    expect(fn(w.fran.unitId)).toEqual(["RETAIL"]);
    const r = await w.admin.put(`/api/units/${w.fran.unitId}/functions`, { functions: ["RETAIL", "DEALER"] });
    expect(r.status).toBe(200);
    expect(r.body.unit).toMatchObject({ functions: ["RETAIL", "DEALER"], businessType: "INDEPENDENT_DEALER", ownershipModel: "FRANCHISE" });
    expect(w.db.get("SELECT 1 FROM audit_logs WHERE action = 'unit.functions' AND business_unit_id = ?", w.fran.unitId)).toBeTruthy();
  });

  it("validates functions in the API and in the database", async () => {
    const w = await world();
    expect((await w.admin.put(`/api/units/${w.branch.unitId}/functions`, { functions: ["HEADQUARTERS"] })).status).toBe(400);
    expect((await w.admin.put(`/api/units/${w.branch.unitId}/functions`, { functions: ["SHOP"] })).status).toBe(400);
    expect((await w.admin.put(`/api/units/${w.branch.unitId}/functions`, { functions: [] })).status).toBe(400);
    expect((await w.branch.api.put(`/api/units/${w.branch.unitId}/functions`, { functions: ["WAREHOUSE"] })).status).toBe(403); // structure is HQ's
    const bad = (json: string) => () => w.db.run("UPDATE org_nodes SET functions = ? WHERE id = ?", json, w.branch.unitId);
    expect(bad('["RETAIL","RETAIL"]')).toThrow(/org_functions/);
    expect(bad('["HEADQUARTERS"]')).toThrow(/org_functions/);
    expect(bad('"RETAIL"')).toThrow(/org_functions/);
    expect(bad("[]")).toThrow(/org_functions/);
    expect(() => w.db.run("UPDATE org_nodes SET functions = '[\"OFFICE\"]' WHERE id = 'hq'")).toThrow(/org_functions/);
    w.db.run("UPDATE org_nodes SET functions = '[\"WAREHOUSE\",\"LOGISTICS\"]' WHERE id = ?", w.branch.unitId); // valid
  });
});

// ------------------------------------------------------------------------------------------------ money
describe("W1 money (integer minor units, no floating point)", () => {
  it("parses, formats and converts exactly; rejects ambiguous input", () => {
    expect(parseAmount("1250000.5", 2)).toBe(125000050n);
    expect(parseAmount("-0.01", 2)).toBe(-1n);
    expect(formatAmount(125000050n, 2)).toBe("1250000.50");
    expect(formatAmount(-5n, 2)).toBe("-0.05");
    for (const bad of ["1e5", "1.234", " ", "12,5", "0x10", "1.2.3"]) expect(() => parseAmount(bad, 2)).toThrow();
    expect(() => parseRate("0")).toThrow();
    // 0.1 + 0.2 style errors cannot happen: 10.00 USD at 12650.12345678 UZS
    expect(convert(1000n, 2, parseRate("12650.12345678"), 2)).toBe(12650123n); // 126501.2345678 → 126501.23
    expect(divRoundHalfEven(5n, 2n)).toBe(2n); // 2.5 → 2
    expect(divRoundHalfEven(7n, 2n)).toBe(4n); // 3.5 → 4
    expect(divRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(divRoundHalfEven(-7n, 2n)).toBe(-4n);
  });
});

// ------------------------------------------------------------------------------------------------ budgets
describe("W1 unit budgets", () => {
  it("branch: director drafts and submits, an HQ director (not the submitter) approves; spending in USD keeps the original", async () => {
    const w = await world();
    const b = w.branch;
    const base = `/api/units/${b.unitId}/budgets`;
    const created = await b.api.post(base, { period: "2026-11", category: "MARKETING", allocated: "15000000.00", note: "Kuz aksiyasi" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.budget.id;
    expect(created.body.budget).toMatchObject({ status: "DRAFT", currency: "UZS", allocated: "15000000.00", spent: "0.00", remaining: "15000000.00" });
    expect((await b.api.post(base, { period: "2026-11", category: "MARKETING", allocated: "1.00" })).status).toBe(409);
    expect((await b.api.post(base, { period: "2026-13", category: "AI", allocated: "1.00" })).status).toBe(400);
    expect((await b.api.post(base, { period: "2026-12", category: "AI", allocated: 1.5 })).status).toBe(400); // numbers are refused: strings only
    expect((await b.api.post(`${base}/${id}/submit`)).body.budget.status).toBe("SUBMITTED");
    expect((await b.api.post(`${base}/${id}/decide`, { decision: "APPROVED" })).status).toBe(403); // a branch does not approve itself
    expect((await w.admin.post(`${base}/${id}/decide`, { decision: "APPROVED" })).status).toBe(403); // platform admin = structure only
    expect((await w.hqDir.api.post(`${base}/${id}/decide`, { decision: "APPROVED" })).body.budget.status).toBe("APPROVED");

    expect((await b.api.post(`${base}/${id}/entries`, { amount: "100.00", currency: "USD", description: "Reklama", occurredOn: "2026-11-03" })).status).toBe(400); // rate required
    const e = await b.api.post(`${base}/${id}/entries`, {
      amount: "100.00", currency: "USD", description: "Instagram reklama", occurredOn: "2026-11-03", fxRate: "12650.5", fxRateDate: "2026-11-03", fxSource: "CBU",
    });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect(e.body.entry).toMatchObject({ amount: "1265050.00", originalAmount: "100.00", originalCurrency: "USD", fxRate: "12650.50000000", fxSource: "CBU" });
    await b.api.post(`${base}/${id}/entries`, { amount: "234950.00", currency: "UZS", description: "Bannerlar", occurredOn: "2026-11-04" });
    const list = (await b.api.get(base)).body.budgets;
    expect(list[0]).toMatchObject({ spent: "1500000.00", remaining: "13500000.00" });
    const actions = w.db.all<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'budget.%' AND business_unit_id = ? ORDER BY id", b.unitId).map((x) => x.action);
    expect(actions).toEqual(["budget.create", "budget.submit", "budget.approve", "budget.entry", "budget.entry"]);
    // HQ group level sees branch budgets; the database keeps integers only
    expect((await w.hqDir.api.get(base)).body.budgets[0].allocated).toBe("15000000.00");
    expect(w.db.get<{ t: string }>("SELECT typeof(allocated_minor) t FROM unit_budgets WHERE id = ?", id)!.t).toBe("integer");
  });

  it("an HQ director cannot approve a budget they submitted (HQ's own budgets)", async () => {
    const w = await world();
    const base = "/api/units/hq/budgets";
    const id = (await w.hqDir.api.post(base, { period: "2026-11", category: "AI", allocated: "5000000.00" })).body.budget.id;
    await w.hqDir.api.post(`${base}/${id}/submit`);
    expect((await w.hqDir.api.post(`${base}/${id}/decide`, { decision: "APPROVED" })).status).toBe(403);
    expect((await w.hqDir2.api.post(`${base}/${id}/decide`, { decision: "REJECTED" })).status).toBe(400); // needs a reason
    expect((await w.hqDir2.api.post(`${base}/${id}/decide`, { decision: "REJECTED", reason: "Kamaytiring" })).body.budget.status).toBe("REJECTED");
    expect((await w.hqDir.api.patch(`${base}/${id}`, { allocated: "3000000.00" })).body.budget).toMatchObject({ status: "DRAFT", allocated: "3000000.00" });
  });

  it("franchise budgets are private and self-governed; HQ sees them only through a budget agreement, and never changes them", async () => {
    const w = await world();
    const f = w.fran;
    const base = `/api/units/${f.unitId}/budgets`;
    const id = (await f.api.post(base, { period: "2026-11", category: "OPERATIONS", allocated: "8000000.00", note: "ichki" })).body.budget.id;
    await f.api.post(`${base}/${id}/submit`);
    expect((await f.api.post(`${base}/${id}/decide`, { decision: "APPROVED" })).body.budget.status).toBe("APPROVED");
    expect(JSON.parse(w.db.get<{ metadata: string }>("SELECT metadata FROM audit_logs WHERE action = 'budget.approve'")!.metadata).selfApproved).toBe(true);

    for (const api of [w.hqDir.api, w.admin, w.branch.api, w.fran2.api]) expect([403, 404]).toContain((await api.get(base)).status);
    expect((await w.hqDir.api.post(`${base}/${id}/decide`, { decision: "REJECTED", reason: "x" })).status).toBe(403);

    // AGGREGATE agreement on "budget": totals only
    const p = await f.api.post(`/api/units/${f.unitId}/agreements`, { granteeNodeId: "sag-group", dataClasses: ["budget"], level: "AGGREGATE", contractRef: "FR-B-1" });
    await w.admin.post(`/api/agreements/${p.body.agreement.id}/approve`);
    const agg = (await w.hqDir.api.get(base)).body.budgets;
    expect(agg).toEqual([{ period: "2026-11", category: "OPERATIONS", status: "APPROVED", allocated: "8000000.00", spent: "0.00", remaining: "8000000.00" }]);
    expect((await w.hqDir.api.get(`${base}/${id}/entries`)).status).toBe(403);
    // even with DETAIL + READ_WRITE nobody outside writes a franchise budget
    expect((await f.api.post(`/api/units/${f.unitId}/agreements`, { granteeNodeId: "sag-group", dataClasses: ["budget"], level: "DETAIL", access: "READ_WRITE", contractRef: "FR-B-2" })).status).toBe(400);
    expect((await w.hqDir.api.post(`${base}/${id}/entries`, { amount: "1.00", currency: "UZS", description: "x", occurredOn: "2026-11-01" })).status).toBe(403);
  });

  it("region membership alone opens neither franchise budgets nor employees; staff see no budget", async () => {
    const w = await world();
    const reg = await w.hqUser("region.mgr", ["employee"]);
    const region = w.db.get<{ parent_id: string }>("SELECT parent_id FROM org_nodes WHERE id = ?", w.fran.unitId)!.parent_id;
    w.db.run("INSERT INTO unit_memberships (user_id, node_id, role_id, include_descendants, granted_by, granted_at) VALUES (?, ?, 'unit_manager', 1, NULL, ?)", reg.id, region, new Date().toISOString());
    expect([403, 404]).toContain((await reg.api.get(`/api/units/${w.fran.unitId}/budgets`)).status);
    expect([403, 404]).toContain((await reg.api.get(`/api/units/${w.fran.unitId}/employees`)).status);
    const staff = await w.fran.api.post(`/api/units/${w.fran.unitId}/employees`, { displayName: "Kassir Ali", role: "unit_staff" });
    await w.app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: staff.body.activationToken, password: PW } });
    const s = client(w.app, await loginCookie(w.app, staff.body.username, PW));
    expect((await s.get(`/api/units/${w.fran.unitId}/budgets`)).status).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------ knowledge
describe("W1 unit knowledge bases", () => {
  const txt = (s: string) => new TextEncoder().encode(s);
  async function docs(w: Awaited<ReturnType<typeof world>>) {
    const by = (id: string) => ({ type: "user" as const, id });
    await ingestDocument(w.deps, { title: "Franshiza narxlari", filename: "f.txt", data: txt("Rudakiy franshiza maxfiy narxlari ZETA-ochiq"), departmentId: null, unitId: w.fran.unitId }, by(w.fran.userId));
    await ingestDocument(w.deps, { title: "Filial rejasi", filename: "b.txt", data: txt("Kattaqorgon filial rejasi ZETA-filial"), departmentId: null, unitId: w.branch.unitId }, by(w.branch.userId));
    const shared = await ingestDocument(w.deps, { title: "Brend qoidalari", filename: "s.txt", data: txt("SAG brend qoidalari ZETA-umumiy"), departmentId: null }, SYSTEM);
    await ingestDocument(w.deps, { title: "HQ ichki", filename: "h.txt", data: txt("Bosh ofis ichki strategiyasi ZETA-hq"), departmentId: null }, SYSTEM);
    expect((await w.admin.patch(`/api/knowledge/${shared.id}/visibility`, { visibility: "BRANCHES" })).status).toBe(200);
  }
  const titles = (hits: { title: string }[]) => [...new Set(hits.map((h) => h.title))].sort();

  it("retrieval stays inside the unit namespace: franchise own only, branch own + HQ shared, HQ never sees units", async () => {
    const w = await world();
    await docs(w);
    const q = "ZETA";
    expect(titles((await retrieve(w.deps, null, q, { unitId: w.fran.unitId })).hits)).toEqual(["Franshiza narxlari"]);
    expect(titles((await retrieve(w.deps, null, q, { unitId: w.branch.unitId })).hits)).toEqual(["Brend qoidalari", "Filial rejasi"]);
    expect(titles((await retrieve(w.deps, null, q, { unitId: w.fran2.unitId })).hits)).toEqual([]);
    expect(titles((await retrieve(w.deps, null, q, { unitId: "hq" })).hits)).toEqual(["Brend qoidalari", "HQ ichki"]);
    expect(titles((await retrieve(w.deps, null, q, { unitId: "no-such-unit" })).hits)).toEqual([]);
    // the HQ library lists HQ documents only
    expect((await w.admin.get("/api/knowledge")).body.documents.map((d: { title: string }) => d.title).sort()).toEqual(["Brend qoidalari", "HQ ichki"]);
  });

  it("API: members read their unit's documents with source metadata; others cannot list, search or delete them", async () => {
    const w = await world();
    await docs(w);
    const list = (await w.fran.api.get(`/api/units/${w.fran.unitId}/knowledge`)).body.documents;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ unitId: w.fran.unitId, visibility: "UNIT", createdBy: w.fran.userId });
    expect((await w.fran.api.get(`/api/units/${w.fran.unitId}/knowledge/search?q=ZETA`)).body.hits.map((h: { title: string }) => h.title)).toEqual(["Franshiza narxlari"]);
    for (const api of [w.hqDir.api, w.admin, w.branch.api, w.fran2.api]) {
      expect([403, 404]).toContain((await api.get(`/api/units/${w.fran.unitId}/knowledge`)).status);
      expect([403, 404]).toContain((await api.get(`/api/units/${w.fran.unitId}/knowledge/search?q=ZETA`)).status);
    }
    // deleting by id from the wrong namespace: not found
    expect((await w.fran2.api.delete(`/api/units/${w.fran2.unitId}/knowledge/${list[0].id}`)).status).toBe(404);
    expect((await w.admin.delete(`/api/knowledge/${list[0].id}`)).status).toBe(404);
    // HQ group level reads a SAG-owned branch's knowledge; a branch never receives HQ-private documents
    expect((await w.hqDir.api.get(`/api/units/${w.branch.unitId}/knowledge`)).body.documents.map((d: { title: string }) => d.title).sort()).toEqual(["Brend qoidalari", "Filial rejasi"]);
  });

  it("an AI Director's run is grounded only in its own unit's documents", async () => {
    const w = await world();
    await docs(w);
    const llm = new MockLlm("## Javob");
    const runner = new AgentRunner(w.deps, llm, { inputPerM: 0, outputPerM: 0 }, { concurrency: 1, pollMs: 3_600_000, taskTimeoutMs: 5000, retryDelayMs: 1, settleMs: 1, tools: w.deps.connectors });
    createTask(w.deps, { title: "ZETA bo'yicha tahlil", agentId: aiDirectorOf(w.db, w.fran.unitId), unitId: w.fran.unitId }, SYSTEM);
    for (let i = 0; i < 5; i++) await Promise.all(runner.tick());
    const prompt = llm.calls.map((c) => `${c.system}\n${c.messages.map((m) => m.text).join("\n")}`).join("\n");
    expect(prompt).toContain("ZETA-ochiq");
    for (const foreign of ["ZETA-filial", "ZETA-umumiy", "ZETA-hq"]) expect(prompt).not.toContain(foreign);
    // its knowledge tool is scoped the same way
    w.db.run("INSERT INTO agent_runs (id, agent_id, correlation_id, model, mode, status, started_at) VALUES ('r', ?, 'c', 'm', 'mock', 'succeeded', ?)",
      aiDirectorOf(w.db, w.fran.unitId), new Date().toISOString());
    const out = await w.deps.connectors.invoke({ taskId: null, agentId: aiDirectorOf(w.db, w.fran.unitId), runId: "r", correlationId: "c" },
      { name: "search_company_knowledge", args: { query: "ZETA" } });
    expect(JSON.stringify(out)).toContain("ZETA-ochiq");
    expect(JSON.stringify(out)).not.toMatch(/ZETA-(filial|umumiy|hq)/);
  });
});

// ------------------------------------------------------------------------------------------------ connectors
describe("W1 unit connectors", () => {
  it("unit agents get only their unit's tools; installation, grants and visibility follow unit boundaries", async () => {
    const w = await world();
    const hub = w.deps.connectors;
    const bAgent = aiDirectorOf(w.db, w.branch.unitId);
    expect(hub.toolsFor(bAgent).map((t) => t.name)).toEqual(["search_company_knowledge"]);
    expect(hub.toolsFor("marketing-javohir").map((t) => t.name)).toEqual(["search_company_knowledge", "list_company_people", "propose_company_memory"]);

    expect((await w.branch.api.post(`/api/units/${w.branch.unitId}/connectors`, { connectorId: "web-search" })).status).toBe(403); // HQ installs
    expect((await w.admin.post(`/api/units/${w.branch.unitId}/connectors`, { connectorId: "gmail" })).status).toBe(400); // no per-unit credentials yet
    const inst = await w.admin.post(`/api/units/${w.branch.unitId}/connectors`, { connectorId: "web-search" });
    expect(inst.status).toBe(201);
    expect(inst.body.connector).toMatchObject({ connectorId: "web-search", credentialScope: "NONE", enabled: true });
    expect(JSON.stringify(inst.body)).not.toMatch(/token|secret|password|key/i);
    expect(w.db.get("SELECT 1 FROM audit_logs WHERE action = 'connector.install' AND business_unit_id = ?", w.branch.unitId)).toBeTruthy();

    // the unit's director grants its own AI Director; nobody else, and only installed connectors
    expect((await w.branch.api.put(`/api/units/${w.branch.unitId}/agents/${bAgent}/connectors`, { connectorIds: ["gmail"] })).status).toBe(400);
    expect((await w.fran.api.put(`/api/units/${w.branch.unitId}/agents/${bAgent}/connectors`, { connectorIds: ["web-search"] })).status).toBe(404);
    expect((await w.branch.api.put(`/api/units/${w.branch.unitId}/agents/${bAgent}/connectors`, { connectorIds: ["web-search"] })).status).toBe(200);
    expect(w.db.get("SELECT 1 FROM agent_connector_permissions WHERE agent_id = ? AND connector_id = 'web-search'", bAgent)).toBeTruthy();
    // the database refuses a grant for a connector the agent's unit does not have
    expect(() => w.db.run("INSERT INTO agent_connector_permissions (agent_id, connector_id, allowed_actions) VALUES (?, 'gmail', '[\"read\"]')", bAgent)).toThrow(/cross_unit/);
    expect(() => w.db.run("INSERT INTO agent_connector_permissions (agent_id, connector_id, allowed_actions) VALUES (?, 'web-search', '[\"read\"]')", aiDirectorOf(w.db, w.fran.unitId))).toThrow(/cross_unit/);

    // visibility: own unit leads, HQ group level for branches; never another unit
    expect((await w.branch.api.get(`/api/units/${w.branch.unitId}/connectors`)).body.connectors).toHaveLength(1);
    expect((await w.hqDir.api.get(`/api/units/${w.branch.unitId}/connectors`)).status).toBe(200);
    expect([403, 404]).toContain((await w.hqDir.api.get(`/api/units/${w.fran.unitId}/connectors`)).status);
    expect([403, 404]).toContain((await w.branch.api.get(`/api/units/${w.fran.unitId}/connectors`)).status);

    // disabling withdraws the grants
    expect((await w.admin.patch(`/api/units/${w.branch.unitId}/connectors/web-search`, { enabled: false })).body.connector.enabled).toBe(false);
    expect(w.db.get("SELECT 1 FROM agent_connector_permissions WHERE agent_id = ?", bAgent)).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ AI Directors
describe("W1 AI Director verification", () => {
  it("every unit has exactly one AI Director, in its own unit and department, hiring policy APPROVAL", async () => {
    const w = await world();
    const units = w.db.all<{ id: string }>("SELECT id FROM org_nodes WHERE level = 'UNIT' AND id <> 'hq'");
    expect(units).toHaveLength(3);
    for (const { id } of units) {
      const ai = w.db.all<{ id: string; business_unit_id: string; dept_unit: string; lifecycle: string }>(
        `SELECT a.id, a.business_unit_id, d.business_unit_id dept_unit, a.lifecycle FROM agents a JOIN departments d ON d.id = a.department_id
         WHERE a.business_unit_id = ? AND a.is_primary_director = 1`, id,
      );
      expect(ai).toHaveLength(1);
      expect(ai[0]).toMatchObject({ business_unit_id: id, dept_unit: id, lifecycle: "ACTIVE" });
      expect(w.db.get<{ p: string }>("SELECT hiring_policy p FROM unit_policies WHERE business_unit_id = ?", id)!.p).toBe("APPROVAL");
    }
    // an AI Director cannot be pointed at another unit's department or given another unit's task
    const ai = aiDirectorOf(w.db, w.fran.unitId);
    expect(() => w.db.run("UPDATE agents SET department_id = ? WHERE id = ?", `dep_${w.branch.unitId}`, ai)).toThrow(/cross_unit/);
    expect(() => createTask(w.deps, { title: "x", agentId: ai, unitId: w.branch.unitId }, SYSTEM)).toThrow();
    // and it is invisible to HQ's agent routes
    expect((await w.admin.get(`/api/agents/${ai}`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------ agreements
describe("W1 franchise data-sharing agreements", () => {
  it("parties, classes, access, validity and status; READ_WRITE only for tasks; denied by default", async () => {
    const w = await world();
    const f = w.fran;
    const propose = (body: object) => f.api.post(`/api/units/${f.unitId}/agreements`, { granteeNodeId: "sag-group", contractRef: "FR-T-1", ...body });
    expect((await propose({ dataClasses: ["employees"], level: "DETAIL", access: "READ_WRITE" })).status).toBe(400);
    expect((await propose({ dataClasses: ["tasks"], level: "AGGREGATE", access: "READ_WRITE" })).status).toBe(400);
    expect((await propose({ dataClasses: ["tasks"], level: "DETAIL", validFrom: "2026-01-02T00:00:00Z", validTo: "2026-01-01T00:00:00Z" })).status).toBe(400);

    // default: HQ cannot assign work into the franchise
    const task = (api: typeof w.hqDir.api) => api.post(`/api/units/${f.unitId}/tasks`, { title: "Inventarizatsiya", toAiDirector: true });
    expect([403, 404]).toContain((await task(w.hqDir.api)).status);

    const readOnly = (await propose({ dataClasses: ["tasks"], level: "DETAIL" })).body.agreement;
    expect(readOnly).toMatchObject({ status: "PENDING", access: "READ", active: false });
    await w.admin.post(`/api/agreements/${readOnly.id}/approve`);
    expect((await task(w.hqDir.api)).status).toBe(403); // can read tasks, cannot write
    expect((await w.hqDir.api.get(`/api/units/${f.unitId}/tasks`)).status).toBe(200);

    const rw = (await propose({ dataClasses: ["tasks"], level: "DETAIL", access: "READ_WRITE", contractRef: "FR-T-2" })).body.agreement;
    await w.admin.post(`/api/agreements/${rw.id}/approve`);
    const created = await task(w.hqDir.api);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(w.db.get<{ u: string }>("SELECT business_unit_id u FROM tasks WHERE id = ?", created.body.task.id)!.u).toBe(f.unitId); // owned by the franchise

    expect((await f.api.post(`/api/agreements/${rw.id}/revoke`)).body.agreement.status).toBe("REVOKED");
    expect((await task(w.hqDir.api)).status).toBe(403);
    // expiry ends it as well
    w.db.run("UPDATE data_sharing_agreements SET valid_to = '2000-01-01T00:00:00.000Z' WHERE id = ?", readOnly.id);
    const all = (await f.api.get(`/api/units/${f.unitId}/agreements`)).body.agreements;
    expect(all.find((a: { id: string }) => a.id === readOnly.id).status).toBe("EXPIRED");
    expect([403, 404]).toContain((await w.hqDir.api.get(`/api/units/${f.unitId}/tasks`)).status);
    const trail = w.db.all<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'agreement.%' ORDER BY id").map((a) => a.action);
    expect(trail).toEqual(["agreement.propose", "agreement.approve", "agreement.propose", "agreement.approve", "agreement.revoke"]);
  });
});
