import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { addUser, adminClient, client, loginCookie, makeApp } from "./helpers.js";
import { importStores, parseStoreWorkbook } from "../src/import/stores.js";

// A workbook shaped like the owner's file: region header rows, store rows with an hd/f marker in varying columns.
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
  ["Sag Kattaqo'rg'on", "", "hd"],
  ["Sag Rudakiy", "", "f"],
  ["Sag Jomboy", "", "", "", "f"],
  [],
  ["Toshkent viloyat Sag Magazin"],
  ["Sag Bekobod", "", "", "hd"],
]);

async function setup() {
  const { app, db, deps } = await makeApp();
  const summary = importStores(deps, STORES, "Книга1.xlsx", true);
  const unit = (name: string) => db.get<{ id: string; human_director_user_id: string }>("SELECT id, human_director_user_id FROM org_nodes WHERE name = ?", name)!;
  const admin = await adminClient(app);
  /** HQ admin assigns the real director, the director activates with the one-time token and signs in */
  const director = async (storeName: string, username: string) => {
    const u = unit(storeName);
    const r = await admin.post(`/api/units/${u.id}/director`, { displayName: `Director ${storeName}`, username });
    expect(r.status).toBe(201);
    const act = await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: r.body.activationToken, password: "Store-pass-123" } });
    expect(act.statusCode).toBe(200);
    return { unitId: u.id, userId: u.human_director_user_id, api: client(app, await loginCookie(app, username, "Store-pass-123")), token: r.body.activationToken as string };
  };
  return { app, db, deps, summary, unit, admin, director };
}

describe("store import", () => {
  it("parses regions, markers and rejects what it cannot classify", () => {
    const wb = parseStoreWorkbook(STORES);
    expect(wb.stores.map((s) => [s.name, s.marker, s.regionCode])).toEqual([
      ["Sag Kattaqo'rg'on", "HD", "samarkand"], ["Sag Rudakiy", "F", "samarkand"], ["Sag Jomboy", "F", "samarkand"], ["Sag Bekobod", "HD", "toshkent-viloyat"],
    ]);
    expect(() => parseStoreWorkbook(workbook([["X Sag Magazin"], ["Sag Y", "", "xx"]]))).toThrow(/unknown marker/);
    expect(() => parseStoreWorkbook(workbook([["Sag Y", "", "hd"]]))).toThrow(/before any region/);
    expect(() => parseStoreWorkbook(workbook([["X Sag Magazin"], ["Sag Y", "hd"], ["sag  y", "f"]]))).toThrow(/twice/);
    expect(() => parseStoreWorkbook(workbook([["X Sag Magazin"], ["Sag Y"]]))).toThrow(/no HD\/F marker/);
  });

  it("imports every store as a unit with one pending director and one AI Director, and is idempotent", async () => {
    const { db, deps, summary } = await setup();
    expect(summary).toMatchObject({
      totals: { stores: 4, hd: 2, f: 2, regions: 2 }, regionsCreated: ["samarkand"], unitsCreated: 4, directorsCreated: 4, aiDirectorsCreated: 4,
    });
    const units = db.all<{ name: string; business_type: string; ownership_model: string; source_marker: string; source_brand: string; parent_id: string; geo: string | null }>(
      "SELECT name, business_type, ownership_model, source_marker, source_brand, parent_id, geo FROM org_nodes WHERE source_brand IS NOT NULL ORDER BY name",
    );
    expect(units).toEqual([
      { name: "Sag Bekobod", business_type: "SAG_BRANCH", ownership_model: "SAG_OWNED", source_marker: "HD", source_brand: "HOME_DESIGN", parent_id: "toshkent-viloyat", geo: null },
      { name: "Sag Jomboy", business_type: "INDEPENDENT_DEALER", ownership_model: "FRANCHISE", source_marker: "F", source_brand: "HOME_DESIGN", parent_id: "samarkand", geo: null },
      { name: "Sag Kattaqo'rg'on", business_type: "SAG_BRANCH", ownership_model: "SAG_OWNED", source_marker: "HD", source_brand: "HOME_DESIGN", parent_id: "samarkand", geo: null },
      { name: "Sag Rudakiy", business_type: "INDEPENDENT_DEALER", ownership_model: "FRANCHISE", source_marker: "F", source_brand: "HOME_DESIGN", parent_id: "samarkand", geo: null },
    ]);
    const dirs = db.all<{ activation_status: string; is_active: number; password_hash: string }>(
      "SELECT u.activation_status, u.is_active, u.password_hash FROM users u JOIN unit_memberships m ON m.user_id = u.id AND m.role_id = 'unit_director'",
    );
    expect(dirs).toHaveLength(4);
    for (const d of dirs) expect(d).toMatchObject({ activation_status: "PENDING_ACTIVATION", is_active: 0 });
    for (const d of dirs) expect(d.password_hash.startsWith("scrypt$")).toBe(false);
    const ai = db.all<{ business_unit_id: string }>("SELECT business_unit_id FROM agents WHERE is_primary_director = 1");
    expect(new Set(ai.map((a) => a.business_unit_id)).size).toBe(4);
    expect(db.get<{ hiring_policy: string; n: number }>("SELECT hiring_policy, COUNT(*) n FROM unit_policies WHERE business_unit_id <> 'hq'")).toEqual({ hiring_policy: "APPROVAL", n: 4 });

    const count = () => db.get<{ u: number; a: number; n: number; m: number }>(
      "SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM agents) a, (SELECT COUNT(*) FROM org_nodes) n, (SELECT COUNT(*) FROM unit_memberships) m",
    );
    const before = count();
    const again = importStores(deps, STORES, "Книга1.xlsx", true);
    expect(again).toMatchObject({ unitsCreated: 0, unitsUnchanged: 4, directorsCreated: 0, aiDirectorsCreated: 0, regionsCreated: [] });
    expect(count()).toEqual(before);
    const batches = db.all<{ source_file: string; source_sha256: string }>("SELECT source_file, source_sha256 FROM store_import_batches");
    expect(batches).toHaveLength(2);
    expect(batches[0].source_file).toBe("Книга1.xlsx");
    expect(batches[0].source_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dry run writes nothing", async () => {
    const { db, deps } = await makeApp();
    const n = () => db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM org_nodes) + (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM store_import_batches) n")!.n;
    const before = n();
    expect(importStores(deps, STORES, "x.xlsx", false)).toMatchObject({ unitsCreated: 4, regionsCreated: ["samarkand"] });
    expect(n()).toBe(before);
  });

  it("refuses a duplicate AI Director and a second human director at the database level", async () => {
    const { db, unit } = await setup();
    const u = unit("Sag Rudakiy");
    expect(() => db.run(
      "INSERT INTO agents (id, name, role, department_id, business_unit_id, is_primary_director, created_at, updated_at) VALUES ('x','x','x',?,?,1,'t','t')",
      `dep_${u.id}`, u.id,
    )).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO unit_memberships (user_id, node_id, role_id, granted_at) VALUES ((SELECT id FROM users WHERE username = 'admin'), ?, 'unit_director', 't')", u.id)).toThrow(/UNIQUE/);
  });
});

describe("director provisioning and activation", () => {
  it("pending directors cannot sign in; HQ assigns the person, the one-time token activates the account", async () => {
    const { app, admin, unit } = await setup();
    const u = unit("Sag Kattaqo'rg'on");
    const before = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "dir.sag-kattaqorgon", password: "!pending-activation" } });
    expect(before.statusCode).toBe(401);
    const r = await admin.post(`/api/units/${u.id}/director`, { displayName: "Aziz Karimov", username: "aziz.k" });
    expect(r.status).toBe(201);
    expect(r.body.activationToken).toBeTruthy();
    expect(await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: r.body.activationToken, password: "short" } }).then((x) => x.statusCode)).toBe(400);
    expect(await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: r.body.activationToken, password: "Kattaqorgon-2026" } }).then((x) => x.statusCode)).toBe(200);
    // used exactly once
    expect(await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: r.body.activationToken, password: "Another-pass-2026" } }).then((x) => x.statusCode)).toBe(400);
    const dir = client(app, await loginCookie(app, "aziz.k", "Kattaqorgon-2026"));
    const me = await dir.get("/api/auth/me");
    expect(me.body.user).toMatchObject({ homeUnitId: u.id, roles: [], permissions: [] });
    // an active director is not re-assigned silently
    expect((await admin.post(`/api/units/${u.id}/director`, { displayName: "Someone else" })).status).toBe(409);
  });

  it("only HQ platform admins assign directors", async () => {
    const { app, db, unit, director } = await setup();
    const ceo = await addUser(db, "ceo", "director");
    const ceoApi = client(app, await loginCookie(app, ceo.username, ceo.password));
    const u = unit("Sag Rudakiy");
    expect((await ceoApi.post(`/api/units/${u.id}/director`, { displayName: "X Y" })).status).toBe(403);
    const hd = await director("Sag Bekobod", "bekobod.dir");
    expect((await hd.api.post(`/api/units/${u.id}/director`, { displayName: "X Y" })).status).toBe(404);
    expect((await hd.api.post(`/api/units/${hd.unitId}/director`, { displayName: "X Y" })).status).toBe(403);
  });
});

describe("unit isolation", () => {
  it("SAG-owned director: own store yes, another store no, company-wide HQ routes no", async () => {
    const { director, unit } = await setup();
    const hd = await director("Sag Kattaqo'rg'on", "katta.dir");
    const own = await hd.api.get(`/api/units/${hd.unitId}`);
    expect(own.status).toBe(200);
    expect(own.body.overview.access).toMatchObject({ memberRole: "unit_director", canManageEmployees: true });
    expect(own.body.overview.employees).toBeDefined();
    expect((await hd.api.get(`/api/units/${unit("Sag Bekobod").id}`)).status).toBe(404);
    expect((await hd.api.get(`/api/units/${unit("Sag Rudakiy").id}`)).status).toBe(404);
    expect((await hd.api.get("/api/units/hq")).status).toBe(404);
    for (const url of ["/api/tasks", "/api/agents", "/api/employees", "/api/work", "/api/stats", "/api/knowledge", "/api/audit", "/api/events"])
      expect((await hd.api.get(url)).status, url).toBe(403);
    const net = await hd.api.get("/api/units");
    expect(net.body.network.regions.flatMap((r: { units: { id: string }[] }) => r.units.map((x) => x.id))).toEqual([hd.unitId]);
  });

  it("franchise director: own franchise yes; SAG-owned stores, HQ and other franchises no", async () => {
    const { director, unit } = await setup();
    const f = await director("Sag Rudakiy", "rudakiy.dir");
    expect((await f.api.get(`/api/units/${f.unitId}`)).status).toBe(200);
    expect((await f.api.get(`/api/units/${unit("Sag Jomboy").id}`)).status).toBe(404);
    expect((await f.api.get(`/api/units/${unit("Sag Kattaqo'rg'on").id}/tasks`)).status).toBe(404);
    expect((await f.api.get(`/api/units/${unit("Sag Jomboy").id}/employees`)).status).toBe(404);
    expect((await f.api.get("/api/agents")).status).toBe(403);
    expect((await f.api.get("/api/employees")).status).toBe(403);
  });

  it("HQ sees SAG-owned stores in detail but not franchise confidential data", async () => {
    const { admin, director, unit } = await setup();
    const f = await director("Sag Rudakiy", "rudakiy.dir");
    await f.api.post(`/api/units/${f.unitId}/employees`, { displayName: "Kassir One", role: "unit_staff" });
    await f.api.post(`/api/units/${f.unitId}/tasks`, { title: "Franchise secret plan", toAiDirector: true });

    const fr = (await admin.get(`/api/units/${f.unitId}`)).body.overview;
    expect(fr.unit).toMatchObject({ ownershipModel: "FRANCHISE", sourceMarker: "F" });
    expect(fr.employees).toBeUndefined();
    expect(fr.employeeCount).toBeUndefined();
    expect(fr.tasks).toBeUndefined();
    expect(fr.kpis).toBeUndefined();
    expect(fr.director.displayName).toBe("Director Sag Rudakiy"); // structure: HQ assigned this person itself
    expect(fr.restricted).toEqual(expect.arrayContaining(["employees", "tasks", "kpi"]));
    expect((await admin.get(`/api/units/${f.unitId}/tasks`)).status).toBe(403);
    expect((await admin.get(`/api/units/${f.unitId}/employees`)).status).toBe(403);
    expect(JSON.stringify((await admin.get("/api/tasks")).body)).not.toContain("Franchise secret plan");
    expect(JSON.stringify((await admin.get("/api/audit?limit=500")).body)).not.toContain(f.unitId);

    const hd = (await admin.get(`/api/units/${unit("Sag Kattaqo'rg'on").id}`)).body.overview;
    expect(hd.unit.ownershipModel).toBe("SAG_OWNED");
    expect(hd.employees).toBeDefined();
    expect(hd.tasks).toBeDefined();
    expect(hd.kpis).toBeDefined();
  });

  it("data-sharing agreements grant exactly their scope, only while approved and valid", async () => {
    const { app, db, admin, director } = await setup();
    const f = await director("Sag Rudakiy", "rudakiy.dir");
    const view = async () => (await admin.get(`/api/units/${f.unitId}`)).body.overview;

    const p = await f.api.post(`/api/units/${f.unitId}/agreements`, { granteeNodeId: "sag-group", dataClasses: ["kpi"], level: "AGGREGATE", contractRef: "FR-2026-01" });
    expect(p.status).toBe(201);
    expect((await view()).kpis).toBeUndefined(); // proposed, not approved
    // the owner cannot approve its own proposal; another franchise cannot either
    expect((await f.api.post(`/api/agreements/${p.body.agreement.id}/approve`)).status).toBe(403);
    expect((await admin.post(`/api/agreements/${p.body.agreement.id}/approve`)).status).toBe(200);
    const shared = await view();
    expect(shared.kpis).toMatchObject({ openTasks: expect.any(Number) });
    expect(shared.kpis.aiCostUsd30d).toBeUndefined(); // ai_usage not in scope
    expect(shared.employees).toBeUndefined();
    expect(shared.tasks).toBeUndefined();
    expect((await admin.get(`/api/units/${f.unitId}/tasks`)).status).toBe(403);

    // a non-group HQ account gains nothing from a group agreement
    const emp = await addUser(db, "hq.emp", "employee");
    const empApi = client(app, await loginCookie(app, emp.username, emp.password));
    expect((await empApi.get(`/api/units/${f.unitId}`)).body.overview.kpis).toBeUndefined();

    expect((await f.api.post(`/api/agreements/${p.body.agreement.id}/revoke`)).status).toBe(200);
    expect((await view()).kpis).toBeUndefined();

    // expired agreement grants nothing
    const old = await f.api.post(`/api/units/${f.unitId}/agreements`, {
      granteeNodeId: "sag-group", dataClasses: ["tasks"], level: "DETAIL", contractRef: "FR-OLD",
      validFrom: "2020-01-01T00:00:00.000Z", validTo: "2021-01-01T00:00:00.000Z",
    });
    await admin.post(`/api/agreements/${old.body.agreement.id}/approve`);
    expect((await view()).tasks).toBeUndefined();
  });

  it("regional grouping alone grants no access to franchise data", async () => {
    const { app, db, unit } = await setup();
    const rm = await addUser(db, "regional", "employee");
    db.run("INSERT INTO unit_memberships (user_id, node_id, role_id, include_descendants, granted_at) VALUES (?, 'samarkand', 'department_head', 1, 't')", rm.id);
    const api = client(app, await loginCookie(app, rm.username, rm.password));
    const hd = (await api.get(`/api/units/${unit("Sag Kattaqo'rg'on").id}`)).body.overview;
    expect(hd.tasks).toBeDefined(); // SAG-owned store in their region
    const fr = (await api.get(`/api/units/${unit("Sag Rudakiy").id}`)).body.overview;
    expect(fr.tasks).toBeUndefined();
    expect(fr.employees).toBeUndefined();
    expect(fr.kpis).toBeUndefined();
    // a region membership elsewhere grants nothing here
    expect((await api.get(`/api/units/${unit("Sag Bekobod").id}`)).body.overview.tasks).toBeUndefined();
  });

  it("employees work inside their unit only and cannot raise their own rights", async () => {
    const { app, director, unit } = await setup();
    const f = await director("Sag Rudakiy", "rudakiy.dir");
    const add = await f.api.post(`/api/units/${f.unitId}/employees`, { displayName: "Sotuvchi Ali", role: "unit_staff", username: "ali.rud" });
    expect(add.status).toBe(201);
    await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: add.body.activationToken, password: "Ali-store-2026" } });
    const ali = client(app, await loginCookie(app, "ali.rud", "Ali-store-2026"));

    // director cannot create directors, cannot change self, cannot touch other units
    expect((await f.api.post(`/api/units/${f.unitId}/employees`, { displayName: "Boss Two", role: "unit_director" })).status).toBe(400);
    expect((await f.api.patch(`/api/units/${f.unitId}/employees/${f.userId}`, { role: "unit_manager" })).status).toBe(403);
    expect((await f.api.post(`/api/units/${unit("Sag Jomboy").id}/employees`, { displayName: "Intruder", role: "unit_staff" })).status).toBe(404);
    expect((await f.api.put(`/api/employees/${f.userId}/roles`, { roles: ["admin"] })).status).toBe(403);

    // staff: no employee list, only own tasks, no other units, no HQ routes
    expect((await ali.get(`/api/units/${f.unitId}/employees`)).status).toBe(403);
    expect((await ali.post(`/api/units/${f.unitId}/employees`, { displayName: "X Y", role: "unit_staff" })).status).toBe(403);
    await f.api.post(`/api/units/${f.unitId}/tasks`, { title: "For Ali", assigneeUserId: add.body.userId });
    await f.api.post(`/api/units/${f.unitId}/tasks`, { title: "Director only", toAiDirector: true });
    const mine = await ali.get(`/api/units/${f.unitId}/tasks`);
    expect(mine.body.tasks.map((t: { title: string }) => t.title)).toEqual(["For Ali"]);
    expect((await ali.get(`/api/units/${unit("Sag Kattaqo'rg'on").id}`)).status).toBe(404);
    expect((await ali.get("/api/work")).status).toBe(403);

    // workflow: assignee moves it, only the director closes it
    const tid = mine.body.tasks[0].id;
    for (const to of ["ACCEPTED", "IN_PROGRESS", "IN_REVIEW"]) expect((await ali.post(`/api/units/${f.unitId}/tasks/${tid}/transition`, { to })).status).toBe(200);
    expect((await ali.post(`/api/units/${f.unitId}/tasks/${tid}/transition`, { to: "DONE" })).status).toBe(403);
    expect((await f.api.post(`/api/units/${f.unitId}/tasks/${tid}/transition`, { to: "DONE" })).status).toBe(200);

    // deactivation ends access
    expect((await f.api.patch(`/api/units/${f.unitId}/employees/${add.body.userId}`, { status: "inactive" })).status).toBe(200);
    expect((await ali.get(`/api/units/${f.unitId}`)).status).toBe(401);
  });

  it("AI agents cannot cross unit boundaries", async () => {
    const { db, deps, admin, director, unit } = await setup();
    const f = await director("Sag Rudakiy", "rudakiy.dir");
    const ai = db.get<{ id: string }>("SELECT id FROM agents WHERE business_unit_id = ? AND is_primary_director = 1", f.unitId)!;
    // the AI Director gets no HQ tools (documents, people, memory, connectors)
    expect(deps.connectors.toolsFor(ai.id)).toEqual([]);
    // HQ cannot hand work to a franchise AI Director through company routes
    const t = await admin.post("/api/tasks", { title: "Read their books", agentId: ai.id });
    expect(t.status).toBe(400);
    expect((await admin.get(`/api/agents/${ai.id}`)).status).toBe(404);
    expect((await admin.get("/api/agents")).body.agents.some((a: { id: string }) => a.id === ai.id)).toBe(false);
    // the database refuses a task that mixes units, whoever writes it
    expect(() => db.run(
      "INSERT INTO tasks (id, business_unit_id, title, agent_id, department_id, created_at, updated_at) VALUES ('x', 'hq', 'x', ?, ?, 't', 't')",
      ai.id, `dep_${f.unitId}`,
    )).toThrow(/cross_unit/);
    const other = unit("Sag Jomboy");
    expect(() => db.run(
      "INSERT INTO tasks (id, business_unit_id, title, agent_id, created_at, updated_at) VALUES ('y', ?, 'y', ?, 't', 't')", other.id, ai.id,
    )).toThrow(/cross_unit/);
    // a store task for its own AI Director is queued for the existing runtime, inside the unit
    const own = await f.api.post(`/api/units/${f.unitId}/tasks`, { title: "Kunlik hisobot", toAiDirector: true });
    expect(own.status).toBe(201);
    expect(db.get("SELECT business_unit_id u, status FROM tasks WHERE id = ?", own.body.task.id)).toEqual({ u: f.unitId, status: "QUEUED" });
    // its activity events are tagged with the unit, so the HQ stream drops them
    expect(deps.bus.forTask(own.body.task.id).every((e) => e.unitId === f.unitId)).toBe(true);
  });
});
