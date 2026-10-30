import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAMPUS_BOUNDS, ROADS, type Rect } from "../src/scene/campus/layout";
import { DISTRICT_CONFIG } from "../src/scene/network/districtLayout";
import { COMPANIES, heightOf, perimeterPlan, ringRoads, PERIMETER_OUTER, RING, ROAD_W, WALK_W } from "../src/scene/perimeter/layout";

/**
 * Largest land the store district can take with today's 23 stores: rows of `maxRowCells` stores (districtLayout.ts),
 * plus two rows for regions that do not split across rows; widest when every store is its own block between streets.
 */
const STORES = 23;
const districtLand = (): Rect => {
  const c = DISTRICT_CONFIG, rows = Math.ceil(STORES / c.maxRowCells) + 2;
  const blockD = c.cellD + 2 * c.sidewalk;
  return {
    x0: c.left, x1: c.left + c.street + c.maxRowCells * (c.cellW + 2 * c.sidewalk + c.street),
    z0: c.top, z1: c.top + c.street + rows * (blockD + c.street),
  };
};

const overlap = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
const plan = perimeterPlan();

describe("corporate perimeter", () => {
  it("has the 11 companies in the owner's order, SAG first with the primary SAG logo", () => {
    expect(COMPANIES.map((c) => c.name)).toEqual([
      "SAG", "SAG Flooring", "SAG Home Design", "SAG Gardens", "Maroqand Klaster", "Turbo Plast", "SET",
      "Jarkurgan Plastic Recycling", "SEAL", "Bionur Med", "Casva",
    ]);
    expect(COMPANIES[0].logo).toBe("sag");
    expect(new Set(COMPANIES.map((c) => c.archetype)).size).toBe(11);
  });

  it("gives every company exactly one headquarters tower, SAG the tallest, all within 5–15 floors", () => {
    for (const c of COMPANIES) expect(plan.filter((p) => p.company === c.id && p.main)).toHaveLength(1);
    for (const p of plan) {
      expect(p.floors).toBeGreaterThanOrEqual(5);
      expect(p.floors).toBeLessThanOrEqual(15);
    }
    const tallest = Math.max(...plan.map((p) => heightOf(p.floors)));
    expect(plan.find((p) => p.main && p.company === "sag")!.floors).toBe(15);
    expect(plan.filter((p) => heightOf(p.floors) === tallest).map((p) => p.company)).toEqual(["sag"]);
  });

  it("surrounds the campus on all four sides", () => {
    for (const s of ["n", "e", "s", "w"]) expect(plan.filter((p) => p.side === s).length).toBeGreaterThan(8);
  });

  it("keeps buildings off each other, the campus, the store-district land and every road", () => {
    for (let i = 0; i < plan.length; i++)
      for (let j = i + 1; j < plan.length; j++) expect(overlap(plan[i], plan[j]), `${i}/${j}`).toBe(false);
    for (const p of plan) {
      expect(overlap(p, CAMPUS_BOUNDS)).toBe(false);
      expect(overlap(p, districtLand())).toBe(false);
      for (const r of [...ROADS, ...ringRoads()]) expect(overlap(p, r), `${p.company} on a road`).toBe(false);
      expect(p.x0 >= PERIMETER_OUTER.x0 && p.x1 <= PERIMETER_OUTER.x1 && p.z0 >= PERIMETER_OUTER.z0 && p.z1 <= PERIMETER_OUTER.z1).toBe(true);
    }
  });

  it("leaves the store district room inside the ring, however its regions pack into rows", () => {
    const inner = { x0: RING.x0 + ROAD_W / 2 + WALK_W, x1: RING.x1 - ROAD_W / 2 - WALK_W, z0: RING.z0 + ROAD_W / 2 + WALK_W, z1: RING.z1 - ROAD_W / 2 - WALK_W };
    const d = districtLand();
    expect(d.x0).toBeGreaterThan(inner.x0);
    expect(d.x1).toBeLessThan(inner.x1);
    expect(d.z1).toBeLessThan(inner.z1);
    expect(CAMPUS_BOUNDS.x1).toBeLessThan(inner.x1);
    expect(CAMPUS_BOUNDS.z0).toBeGreaterThan(inner.z0);
  });

  it("declares each logo with its file's real pixel size (aspect ratio preserved)", async () => {
    const { LOGOS } = await import("../src/scene/perimeter/brands");
    for (const c of COMPANIES) {
      const file = c.logo === "sag" ? "../src/assets/sag-logo.png" : `../src/assets/brands/${c.logo}.png`;
      const png = readFileSync(fileURLToPath(new URL(file, import.meta.url)));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], c.logo).toEqual([LOGOS[c.logo].w, LOGOS[c.logo].h]);
    }
  });
});
