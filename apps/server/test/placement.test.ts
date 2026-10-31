import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { type NetworkDto, type UnitCardDto, planDistrict, slotRect, slotStatus } from "@sag/shared";
import { Db } from "../src/db/db.js";
import { addUser, adminClient, client, loginCookie, makeApp } from "./helpers.js";
import { importStores } from "../src/import/stores.js";
import { network } from "../src/domain/units.js";

function workbook(rows: string[][]): Uint8Array {
  const cols = "ABCDEF";
  const sheetRows = rows.map((r, i) =>
    `<row r="${i + 1}">${r.map((v, j) => (v ? `<c r="${cols[j]}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>` : "")).join("")}</row>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="L1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
  });
}
const STORES = workbook([
  ["Samarkand Sag Magazin"], ["Sag Kattaqorgon", "", "hd"], ["Sag Rudakiy", "", "f"], [],
  ["Toshkent viloyat Sag Magazin"], ["Sag Bekobod", "", "", "hd"],
]);

async function setup(path?: string) {
  const ctx = await makeApp(path);
  importStores(ctx.deps, STORES, "stores.xlsx", true);
  const admin = await adminClient(ctx.app);
  const net = async () => (await admin.get("/api/units")).body.network as NetworkDto;
  /** the district plan exactly as the 3D world builds it from the HQ network view */
  const plan = async () => planDistrict((await net()).regions.filter((r) => r.units.length));
  /** first free slot, scanning rows then columns */
  const freeSlot = async (skip = 0) => {
    const p = await plan();
    for (let z = 0; z < 8; z++) for (let x = 0; x < 12; x++) if (slotStatus(p, x, z) === "free" && skip-- <= 0) return { gridX: x, gridZ: z };
    throw new Error("no free slot");
  };
  const body = (placement: { gridX: number; gridZ: number }, over: Record<string, unknown> = {}) => ({
    name: "Sag Yangi Filial", regionId: "samarkand", businessType: "SAG_BRANCH", address: "Samarqand, Registon ko'chasi 1",
    functions: ["RETAIL"], description: "Xaritadan yaratilgan filial", placement, ...over,
  });
  return { ...ctx, admin, net, plan, freeSlot, body };
}

const allUnits = (n: NetworkDto) => n.regions.flatMap((r) => r.units);

describe("stores placed on the 3D world map", () => {
  it("creates a branch on a free slot: database row, provisioning, card with its placement", async () => {
    const { admin, db, freeSlot, body, net } = await setup();
    const slot = await freeSlot();
    const r = await admin.post("/api/units", body(slot));
    expect(r.status).toBe(201);
    const card = r.body.unit as UnitCardDto;
    const rect = slotRect(slot.gridX, slot.gridZ);
    expect(card).toMatchObject({
      name: "Sag Yangi Filial", regionId: "samarkand", businessType: "SAG_BRANCH", ownershipModel: "SAG_OWNED", status: "ACTIVE",
      address: "Samarqand, Registon ko'chasi 1", functions: ["RETAIL"], sourceMarker: null, sourceBrand: "HOME_DESIGN",
      placement: { x: rect.cx, z: rect.cz, rotation: 0, gridX: slot.gridX, gridZ: slot.gridZ },
    });
    const row = db.get<Record<string, unknown>>("SELECT * FROM org_nodes WHERE id = ?", card.id)!;
    expect(row).toMatchObject({ world_grid_x: slot.gridX, world_grid_z: slot.gridZ, world_x: rect.cx, world_z: rect.cz, world_rotation: 0,
      description: "Xaritadan yaratilgan filial", level: "UNIT", parent_id: "samarkand" });
    // provisioned like an imported store: policy, team, one pending human director, one AI Director
    expect(db.get("SELECT 1 FROM unit_policies WHERE business_unit_id = ?", card.id)).toBeTruthy();
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE business_unit_id = ? AND is_primary_director = 1", card.id)!.n).toBe(1);
    expect(db.get<{ activation_status: string }>("SELECT u.activation_status FROM users u JOIN org_nodes n ON n.human_director_user_id = u.id WHERE n.id = ?", card.id))
      .toEqual({ activation_status: "PENDING_ACTIVATION" });
    expect(db.get("SELECT 1 FROM audit_logs WHERE action = 'unit.world.place' AND target_id = ?", card.id)).toBeTruthy();
    // the network (what the 3D world loads) carries the placement
    expect(allUnits(await net()).find((u) => u.id === card.id)?.placement).toEqual(card.placement);
  });

  it("franchise type is stored as an independent dealer with franchise ownership", async () => {
    const { admin, freeSlot, body } = await setup();
    const r = await admin.post("/api/units", body(await freeSlot(), { name: "Sag Dealer", businessType: "INDEPENDENT_DEALER", functions: ["RETAIL", "DEALER"] }));
    expect(r.status).toBe(201);
    expect(r.body.unit).toMatchObject({ businessType: "INDEPENDENT_DEALER", ownershipModel: "FRANCHISE", functions: ["RETAIL", "DEALER"] });
  });

  it("refuses an occupied slot and land outside the district", async () => {
    const { admin, body, plan, freeSlot } = await setup();
    const p = await plan();
    expect(slotStatus(p, 0, 0)).toBe("occupied"); // the first row of imported stores starts there
    const taken = await admin.post("/api/units", body({ gridX: 0, gridZ: 0 }));
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("slot_taken");
    expect((await admin.post("/api/units", body({ gridX: 3, gridZ: 40 }))).status).toBe(400);
    expect((await admin.post("/api/units", body({ gridX: 400, gridZ: 0 }))).status).toBe(400);
    // the business park, the east ring road with the corporate towers beyond it, and the south ring road
    for (const s of [{ gridX: 6, gridZ: 1 }, { gridX: 10, gridZ: 1 }, { gridX: 11, gridZ: 3 }, { gridX: 1, gridZ: 6 }]) {
      const r = await admin.post("/api/units", body(s));
      expect(r.status, `${s.gridX},${s.gridZ}`).toBe(400);
    }
    // a slot that becomes taken: the second request for it fails, nothing is written twice
    const slot = await freeSlot();
    expect((await admin.post("/api/units", body(slot))).status).toBe(201);
    const again = await admin.post("/api/units", body(slot, { name: "Sag Ikkinchi" }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("slot_taken");
  });

  it("validates input: coordinates, region, type, functions, name", async () => {
    const { admin, freeSlot, body } = await setup();
    const slot = await freeSlot();
    for (const bad of [
      body({ gridX: -1, gridZ: 0 }), body({ gridX: 1.5, gridZ: 0 }), body({ gridX: "2", gridZ: 0 } as never),
      body(slot, { regionId: "no-such-region" }), body(slot, { regionId: "sag-group" }), body(slot, { regionId: "hq" }),
      body(slot, { businessType: "SUBSIDIARY" }), body(slot, { functions: [] }), body(slot, { functions: ["HEADQUARTERS"] }),
      body(slot, { functions: ["SPACESHIP"] }), body(slot, { name: " " }), body(slot, { extra: 1 }),
    ]) {
      const r = await admin.post("/api/units", bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // an existing store's name is not reused
    const dup = await admin.post("/api/units", body(slot, { name: "sag rudakiy" }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("name_taken");
  });

  it("only HQ platform admins may create (checked on the server)", async () => {
    const { app, db, freeSlot, body } = await setup();
    const slot = await freeSlot();
    const anon = await app.inject({ method: "POST", url: "/api/units", payload: body(slot) });
    expect(anon.statusCode).toBe(401);
    for (const role of ["director", "department_head", "employee", "hr", "viewer"] as const) {
      const u = await addUser(db, `u-${role}`, role);
      const r = await client(app, await loginCookie(app, u.username, u.password)).post("/api/units", body(slot));
      expect(r.status, role).toBe(403);
    }
    expect(db.get("SELECT 1 FROM org_nodes WHERE name = 'Sag Yangi Filial'")).toBeUndefined();
  });

  it("a store director cannot create and does not see other units, the new one included (isolation)", async () => {
    const { app, admin, db, freeSlot, body } = await setup();
    const rud = db.get<{ id: string }>("SELECT id FROM org_nodes WHERE name = 'Sag Rudakiy'")!;
    const assign = await admin.post(`/api/units/${rud.id}/director`, { displayName: "Rudakiy Director", username: "rud.dir" });
    await app.inject({ method: "POST", url: "/api/auth/activate", payload: { token: assign.body.activationToken, password: "Store-pass-123" } });
    const store = client(app, await loginCookie(app, "rud.dir", "Store-pass-123"));
    const slot = await freeSlot();
    expect((await store.post("/api/units", body(slot))).status).toBe(403);
    const created = await admin.post("/api/units", body(slot, { name: "Sag Franchise New", businessType: "INDEPENDENT_DEALER" }));
    expect(created.status).toBe(201);
    const seen = allUnits((await store.get("/api/units")).body.network as NetworkDto).map((u) => u.id);
    expect(seen).toEqual([rud.id]);
    expect((await store.get(`/api/units/${created.body.unit.id}`)).status).toBe(404);
  });

  it("parallel requests for one slot create exactly one store", async () => {
    const { app, admin, db, freeSlot, body } = await setup();
    const slot = await freeSlot();
    const cookie = await loginCookie(app, "admin", "test-admin-pass");
    const fire = (name: string) => app.inject({ method: "POST", url: "/api/units", headers: { cookie }, payload: body(slot, { name }) });
    const results = await Promise.all([fire("Sag Parallel A"), fire("Sag Parallel B"), fire("Sag Parallel C")]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM org_nodes WHERE world_grid_x = ? AND world_grid_z = ?", slot.gridX, slot.gridZ)!.n).toBe(1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM org_nodes WHERE name LIKE 'Sag Parallel %'")!.n).toBe(1);
    void admin;
  });

  it("the database refuses a second live store in a slot and a half placement", async () => {
    const { admin, db, freeSlot, body } = await setup();
    const slot = await freeSlot();
    const id = (await admin.post("/api/units", body(slot))).body.unit.id as string;
    const other = db.get<{ id: string }>("SELECT id FROM org_nodes WHERE name = 'Sag Bekobod'")!.id;
    expect(() => db.run("UPDATE org_nodes SET world_x = 1, world_z = 1, world_grid_x = ?, world_grid_z = ? WHERE id = ?", slot.gridX, slot.gridZ, other)).toThrow(/UNIQUE/);
    expect(() => db.run("UPDATE org_nodes SET world_grid_x = 7 WHERE id = ?", other)).toThrow(/org_world_placement/);
    // archiving frees the slot (the unique index covers live units only)
    db.run("UPDATE org_nodes SET status = 'ARCHIVED' WHERE id = ?", id);
    expect((await admin.post("/api/units", body(slot, { name: "Sag Yangi Filial 2" }))).status).toBe(201);
  });

  it("survives a restart: the placement is read back from the database file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sag-place-")), "world.db");
    const first = await setup(file);
    const slot = await first.freeSlot();
    const created = (await first.admin.post("/api/units", first.body(slot))).body.unit as UnitCardDto;
    await first.app.close();
    first.db.close();
    // a fresh process on the same file: no duplicate, same place
    const db = new Db(file);
    db.migrate();
    const admin = { id: "x", username: "admin", displayName: "admin", roles: ["admin"], permissions: [], homeUnitId: "hq" } as never;
    const units = allUnits(network({ db } as never, admin)).filter((u) => u.name === "Sag Yangi Filial");
    expect(units).toHaveLength(1);
    expect(units[0].placement).toEqual(created.placement);
    // and the district plan puts it exactly there
    const p = planDistrict(network({ db } as never, admin).regions.filter((r) => r.units.length));
    expect(p.stores.find((s) => s.unit.id === created.id)).toMatchObject({ cx: created.placement!.x, cz: created.placement!.z });
    db.close();
  });
});
