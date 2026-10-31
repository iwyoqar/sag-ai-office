import { describe, expect, it } from "vitest";
import type { UnitCardDto } from "@sag/shared";
import { DISTRICT_CONFIG, placementFor, planDistrict, slotAt, slotRect, slotStatus } from "../src/scene/network/districtLayout";
import { buildWorldGraph } from "../src/scene/world/network";
import { buildLanePath } from "../src/scene/world/roads";
import { RING, ROAD_W, WALK_W } from "../src/scene/perimeter/layout";

const unit = (id: string, region: string, placement: UnitCardDto["placement"] = null): UnitCardDto => ({
  id, name: `Sag ${id}`, code: id, regionId: region, regionName: region, businessType: "SAG_BRANCH", ownershipModel: "SAG_OWNED",
  sourceBrand: "HOME_DESIGN", sourceMarker: null, status: "ACTIVE", geo: null, address: null, isHeadOffice: false, functions: ["RETAIL"], placement,
});
const sizes = [2, 4, 1, 6, 3, 2, 1, 3, 1];
const regions = () => sizes.map((n, r) => ({ name: `R${r}`, units: Array.from({ length: n }, (_, i) => unit(`u${r}-${i}`, `R${r}`)) }));
const firstFree = (plan: ReturnType<typeof planDistrict>) => {
  for (let z = 0; z < 8; z++) for (let x = 0; x < 12; x++) if (slotStatus(plan, x, z) === "free") return { gridX: x, gridZ: z };
  throw new Error("no free slot");
};

describe("map placement grid", () => {
  it("maps world points to slots and back (the hover tile sits on the slot under the cursor)", () => {
    for (const [gx, gz] of [[0, 0], [3, 2], [9, 5]]) {
      const r = slotRect(gx, gz);
      expect(slotAt(r.cx, r.cz)).toEqual({ gridX: gx, gridZ: gz });
      expect(slotAt(r.x0 + 0.5, r.z0 + 0.5)).toEqual({ gridX: gx, gridZ: gz });
      expect(r.x1 - r.x0).toBe(DISTRICT_CONFIG.cellW + 2 * DISTRICT_CONFIG.sidewalk); // a Home Design store lot + sidewalk
      expect(placementFor(gx, gz)).toEqual({ x: r.cx, z: r.cz, rotation: 0, gridX: gx, gridZ: gz });
    }
    expect(slotAt(-500, 200)).toBeNull();
    expect(slotAt(0, 0)).toBeNull(); // north of the district (campus side)
  });

  it("an existing store's slot is occupied, empty district land is free, far land is outside", () => {
    const plan = planDistrict(regions());
    expect(slotStatus(plan, 0, 0)).toBe("occupied");
    const free = firstFree(plan);
    expect(slotStatus(plan, free.gridX, free.gridZ)).toBe("free");
    // a free slot's block and its two cross streets clear every existing block
    const r = slotRect(free.gridX, free.gridZ);
    for (const b of plan.blocks) expect(r.x0 - 12 < b.x1 && b.x0 < r.x1 + 12 && r.z0 < b.z1 && b.z0 < r.z1).toBe(false);
    expect(slotStatus(plan, 2, 40)).toBe("outside");
    expect(slotStatus(plan, 40, 1)).toBe("outside");
    expect(slotStatus(plan, -1, 1)).toBe("outside");
    expect(slotStatus(plan, 1.5, 1)).toBe("outside");
  });

  it("no slot that may be built on reaches the perimeter ring road, its sidewalk or the buildings beyond", () => {
    const plan = planDistrict([]);
    const innerX = RING.x1 - ROAD_W / 2 - WALK_W, innerZ = RING.z1 - ROAD_W / 2 - WALK_W;
    let free = 0;
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 30; x++) {
        if (slotStatus(plan, x, z) !== "free") continue;
        free++;
        const r = slotRect(x, z);
        // the block and the cross street on its east side stay inside the ring
        expect(r.x1 + DISTRICT_CONFIG.street).toBeLessThanOrEqual(innerX);
        expect(r.z1 + DISTRICT_CONFIG.street).toBeLessThanOrEqual(innerZ);
      }
    expect(free).toBeGreaterThan(0);
    expect(slotStatus(plan, 9, 0)).toBe("free"); // the last column inside the ring
    expect(slotStatus(plan, 10, 0)).toBe("outside"); // would sit on the east ring road
  });

  it("a placed store keeps its slot, leaves every other store where it was, and is reached by the streets", () => {
    const before = planDistrict(regions());
    const slot = firstFree(before);
    const rs = regions();
    rs[0].units.push(unit("placed", "R0", placementFor(slot.gridX, slot.gridZ)));
    const after = planDistrict(rs);
    // existing stores did not move
    for (const s of before.stores) expect(after.stores.find((o) => o.unit.id === s.unit.id)).toMatchObject({ cx: s.cx, cz: s.cz });
    const placed = after.stores.find((s) => s.unit.id === "placed")!;
    expect(placed).toMatchObject({ cx: slotRect(slot.gridX, slot.gridZ).cx, cz: slotRect(slot.gridX, slot.gridZ).cz, row: slot.gridZ });
    expect(slotStatus(after, slot.gridX, slot.gridZ)).toBe("occupied");
    // the road graph reaches it: one network, no stray dead ends, its loading stop routable from the warehouse
    const g = buildWorldGraph(after);
    const v = g.validate();
    expect(v.components).toBe(1);
    expect(v.strayEnds).toEqual([]);
    const route = g.route(g.dests.get("warehouse")!, g.dests.get("store:placed")!, "medium");
    expect(route).not.toBeNull();
    expect(buildLanePath(g, route!).length).toBeGreaterThan(100);
    // no block overlaps another
    for (const a of after.blocks)
      for (const b of after.blocks)
        if (a !== b) expect(a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.z0 < b.z1 - 0.01 && b.z0 < a.z1 - 0.01).toBe(false);
  });

  it("stores placed in a new row below the district are connected too", () => {
    const base = planDistrict(regions());
    const rows = base.rearStreetZ.length;
    const rs = regions();
    rs[1].units.push(unit("below", "R1", placementFor(4, rows + 1)));
    const plan = planDistrict(rs);
    const g = buildWorldGraph(plan);
    expect(g.validate()).toMatchObject({ components: 1, strayEnds: [], unreachable: [] });
    expect(g.route(g.dests.get("hq")!, g.dests.get("store:below")!, "van")).not.toBeNull();
  });
});
