import { describe, expect, it } from "vitest";
import type { UnitCardDto } from "@sag/shared";
import { DISTRICT_CONFIG, DISTRICT_KEEP_OUT, placementFor, planDistrict, slotAt, slotFootprint, slotRect, slotStatus } from "../src/scene/network/districtLayout";
import { buildWorldGraph } from "../src/scene/world/network";
import { buildLanePath } from "../src/scene/world/roads";
import { BUSINESS_PARK, RING, ROAD_W, WALK_W, perimeterPlan, ringRoads } from "../src/scene/perimeter/layout";
import { CAMPUS_BOUNDS, ROADS, WALKS, type Rect } from "../src/scene/campus/layout";

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

  // Everything the scene draws round the district land, straight from the scene layouts (not from DISTRICT_KEEP_OUT).
  const CROWN = 2.6; // street tree crown radius at the largest scale used
  const h = ROAD_W / 2, vIn = h + WALK_W + 3;
  const obstacles: (Rect & { id: string })[] = [
    ...ringRoads().map((r, i) => ({ id: `ring-road-${i}`, ...r })),
    // inner walks of the ring
    { id: "walk-w", x0: RING.x0 + h, x1: RING.x0 + h + WALK_W, z0: RING.z0, z1: RING.z1 },
    { id: "walk-e", x0: RING.x1 - h - WALK_W, x1: RING.x1 - h, z0: RING.z0, z1: RING.z1 },
    { id: "walk-s", x0: RING.x0, x1: RING.x1, z0: RING.z1 - h - WALK_W, z1: RING.z1 - h },
    // inner verge trees of the ring
    { id: "trees-w", x0: RING.x0 + vIn - CROWN, x1: RING.x0 + vIn + CROWN, z0: RING.z0, z1: RING.z1 },
    { id: "trees-e", x0: RING.x1 - vIn - CROWN, x1: RING.x1 - vIn + CROWN, z0: RING.z0, z1: RING.z1 },
    { id: "trees-s", x0: RING.x0, x1: RING.x1, z0: RING.z1 - vIn - CROWN, z1: RING.z1 - vIn + CROWN },
    // corporate towers and office buildings
    ...perimeterPlan().map((p) => ({ id: `${p.company}${p.main ? "-tower" : "-office"}`, x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 })),
    // business park and its path up to the M37 walk
    { id: "business-park", ...BUSINESS_PARK },
    { id: "park-path-m37", x0: (BUSINESS_PARK.x0 + BUSINESS_PARK.x1) / 2 - 1.6, x1: (BUSINESS_PARK.x0 + BUSINESS_PARK.x1) / 2 + 1.6, z0: 90, z1: BUSINESS_PARK.z0 + 10 },
    // campus, M37, its walks and street trees
    { id: "campus", ...CAMPUS_BOUNDS },
    ...ROADS.map((r) => ({ ...r })),
    ...WALKS.map((w, i) => ({ id: `walk-${i}`, ...w })),
    { id: "m37-trees-south", x0: -300, x1: 880, z0: 87 - CROWN, z1: 87 + CROWN },
  ];
  const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.z0 < b.z1 - 0.01 && b.z0 < a.z1 - 0.01;
  const freeSlots = (plan: ReturnType<typeof planDistrict>) => {
    const out: { gridX: number; gridZ: number }[] = [];
    for (let z = 0; z < 30; z++) for (let x = 0; x < 30; x++) if (slotStatus(plan, x, z) === "free") out.push({ gridX: x, gridZ: z });
    return out;
  };

  it("no free slot, with the streets round it, reaches a ring road, walk, tree, corporate building, the park or the M37", () => {
    for (const plan of [planDistrict([]), planDistrict(regions())]) {
      const free = freeSlots(plan);
      expect(free.length).toBeGreaterThan(0);
      for (const s of free) {
        const fp = slotFootprint(slotRect(s.gridX, s.gridZ));
        const hit = obstacles.filter((o) => overlaps(fp, o)).map((o) => o.id);
        expect(hit, `slot ${s.gridX},${s.gridZ}`).toEqual([]);
      }
    }
  });

  it("every perimeter building and ring surface lies inside the shared keep-out list (the server refuses those slots)", () => {
    const inside = (o: Rect) => DISTRICT_KEEP_OUT.some((k) => o.x0 >= k.x0 && o.x1 <= k.x1 && o.z0 >= k.z0 && o.z1 <= k.z1);
    for (const o of obstacles) expect(inside(o), o.id).toBe(true);
  });

  it("the east ring road, the business park and the south ring road are refused; the land west of them is free", () => {
    const plan = planDistrict([]);
    expect(slotStatus(plan, 5, 0)).toBe("free"); // last column west of the business park
    expect(slotStatus(plan, 6, 0)).toBe("outside"); // business park
    expect(slotStatus(plan, 10, 0)).toBe("outside"); // east ring road
    expect(slotStatus(plan, 11, 3)).toBe("outside"); // corporate towers east of the ring
    expect(slotStatus(plan, 0, 5)).toBe("free"); // last row north of the south ring road
    expect(slotStatus(plan, 0, 6)).toBe("outside"); // south ring road
    expect(slotStatus(plan, 2, 8)).toBe("outside"); // corporate buildings south of the ring
  });

  it("the two branches already placed in the dev data keep their slots and coordinates", () => {
    // SAG shohqadam (2,4) and sag ombor (5,4), stored at x 86 / 254, z 332
    for (const [gx, gz, x] of [[2, 4, 86], [5, 4, 254]]) {
      expect(placementFor(gx, gz)).toEqual({ x, z: 332, rotation: 0, gridX: gx, gridZ: gz });
      expect(slotStatus(planDistrict([]), gx, gz)).toBe("free");
    }
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
