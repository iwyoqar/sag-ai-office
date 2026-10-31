import { describe, expect, it } from "vitest";
import type { UnitCardDto } from "@sag/shared";
import { planDistrict } from "../src/scene/network/districtLayout";
import { buildWorldGraph, ROUNDABOUT } from "../src/scene/world/network";
import { buildLanePath, type RoadGraph, type VehicleKind } from "../src/scene/world/roads";
import { PARKING_ISLANDS } from "../src/scene/campus/landscape";
import { BUILDINGS, PARKING, type BuildingSpec } from "../src/scene/campus/layout";

const unit = (id: string, region: string, i: number): UnitCardDto => ({
  id, name: `Sag Test ${id}`, code: id, regionId: region, regionName: region, businessType: "SAG_BRANCH" as UnitCardDto["businessType"],
  ownershipModel: i % 2 ? "FRANCHISE" : "SAG_OWNED", sourceBrand: null, sourceMarker: null, status: "ACTIVE",
  geo: null, address: null, isHeadOffice: false, functions: [], placement: null,
});
// region sizes like the real network (1–6 stores per region, 23 in all)
const sizes = [2, 4, 1, 6, 3, 2, 1, 3, 1];
const regions = sizes.map((n, r) => ({ name: `R${r}`, units: Array.from({ length: n }, (_, i) => unit(`u${r}-${i}`, `R${r}`, i)) }));
const plan = planDistrict(regions);
const g = buildWorldGraph(plan);

/** distance from a point to the nearest road surface (0 when on it) */
function offRoad(gr: RoadGraph, x: number, z: number) {
  if (Math.hypot(x - ROUNDABOUT.x, z - ROUNDABOUT.z) <= ROUNDABOUT.outer) return 0;
  let best = Infinity;
  for (const e of gr.edges) {
    const a = gr.nodes[e.a], b = gr.nodes[e.b];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z) - e.width / 2;
    best = Math.min(best, Math.max(0, d));
  }
  return best;
}

describe("compact store district", () => {
  it("places every store once, in rows, without overlapping lots", () => {
    expect(plan.stores).toHaveLength(23);
    expect(new Set(plan.stores.map((s) => s.unit.id)).size).toBe(23);
    const { cellW, cellD } = plan.cfg;
    for (const a of plan.stores)
      for (const b of plan.stores)
        if (a !== b) expect(Math.abs(a.cx - b.cx) >= cellW - 0.01 || Math.abs(a.cz - b.cz) >= cellD - 0.01).toBe(true);
  });

  it("keeps a region's stores together and never mixes regions inside a block", () => {
    for (const blk of plan.blocks) {
      const inside = plan.stores.filter((s) => s.cx > blk.x0 && s.cx < blk.x1 && s.cz > blk.z0 && s.cz < blk.z1);
      expect(inside.length).toBeGreaterThan(0);
      expect(new Set(inside.map((s) => s.unit.regionName))).toEqual(new Set([blk.region]));
    }
  });

  it("needs at least a quarter less land per store than the old region grid", () => {
    // old grid, measured in the running app: x −40…562, z 140…338 for the same 23 stores ≈ 5 180 m² per store
    const old = (602 * 198) / 23;
    const area = (plan.bounds.x1 - plan.bounds.x0) * (plan.bounds.z1 - plan.bounds.z0);
    expect(area / plan.stores.length).toBeLessThan(old * 0.75);
  });
});

describe("road network", () => {
  it("is one connected network with no stray dead ends", () => {
    const v = g.validate();
    expect(v.components).toBe(1);
    expect(v.strayEnds).toEqual([]);
    expect(v.unreachable).toEqual([]);
  });

  it("gives every store a loading stop and connects every business location", () => {
    for (const s of plan.stores) expect(g.dests.has(`store:${s.unit.id}`)).toBe(true);
    for (const d of ["hq", "warehouse", "factory-a:1", "factory-b:1", "factory-c:1", "m37-west", "m37-east"]) expect(g.dests.has(d)).toBe(true);
    const names = [...g.dests.keys()];
    for (const a of names) for (const b of names) if (a !== b) expect(g.route(g.dests.get(a)!, g.dests.get(b)!, "van")).not.toBeNull();
  });

  it("keeps every lane path on the road surface, for every kind of vehicle", () => {
    const names = [...g.dests.keys()];
    const kinds: VehicleKind[] = ["van", "medium", "large", "semi"];
    let checked = 0;
    for (const kind of kinds)
      for (let i = 0; i < names.length; i += 3)
        for (let j = 1; j < names.length; j += 5) {
          if (i === j) continue;
          const r = g.route(g.dests.get(names[i])!, g.dests.get(names[j])!, kind)!;
          const p = buildLanePath(g, r);
          for (let k = 0; k < p.xs.length; k++) {
            expect(offRoad(g, p.xs[k], p.zs[k])).toBeLessThan(0.6);
            // and never through a building, a planted island or a parked row (half a truck width of clearance)
            const x = p.xs[k], z = p.zs[k], c = 1.2;
            for (const b of [...BUILDINGS, ...PARKING_ISLANDS]) {
              // true distance from the lane centre to the footprint (rounded corners), against half a truck width
              const inside = Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1)) < c;
              // drive-through gates (the green gate, the passage) are openings in their walls
              const gate = (b as Partial<BuildingSpec>).doors?.find((d) => d.kind === "gate");
              const through = gate && (gate.side === "+z" || gate.side === "-z"
                ? x > b.x0 + gate.at - gate.w / 2 + c && x < b.x0 + gate.at + gate.w / 2 - c
                : z > b.z0 + gate.at - gate.w / 2 + c && z < b.z0 + gate.at + gate.w / 2 - c);
              expect(inside && !through, `${kind} ${names[i]}→${names[j]} at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(false);
            }
            for (const row of PARKING)
              expect(x > row.x0 - c && x < row.x1 + c && Math.abs(z - row.z) < 2.5 + c, `${kind} through parking row z=${row.z} at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(false);
          }
          checked++;
        }
    expect(checked).toBeGreaterThan(100);
  }, 30_000); // ~10 s: every point of ~150 lane paths against every road, building and island

  it("sends heavy trucks round the industrial ring rather than through the store streets", () => {
    const from = g.dests.get("factory-c:2")!, to = g.dests.get("m37-east")!;
    const semi = g.route(from, to, "semi")!;
    const xs = semi.map((n) => g.nodes[n]);
    expect(xs.some((n) => Math.abs(n.x - 484) < 1)).toBe(true); // the east service road
    expect(xs.every((n) => n.z < plan.bounds.z0)).toBe(true); // never enters the district
  });
});
