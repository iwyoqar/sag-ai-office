import { describe, expect, it } from "vitest";
import { AREAS, BUILDINGS, CAMPUS_BOUNDS, HQ, PARKING, ROADS, WALKS, type Rect } from "../src/scene/campus/layout";

const overlap = (a: Rect, b: Rect, pad = 0) =>
  a.x0 < b.x1 - pad && b.x0 < a.x1 - pad && a.z0 < b.z1 - pad && b.z0 < a.z1 - pad;
const inRect = (x: number, z: number, r: Rect) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

const structures: (Rect & { id: string })[] = [HQ, ...BUILDINGS];

describe("campus layout (estimated from references)", () => {
  it("keeps the office model at its own origin and footprint", () => {
    expect(HQ).toMatchObject({ x0: -18.8, x1: 19.2, z0: -12.8, z1: 12.8 });
  });

  it("has unique ids and well-formed boxes inside the campus bounds", () => {
    expect(new Set(structures.map((b) => b.id)).size).toBe(structures.length);
    for (const b of BUILDINGS) {
      expect(b.x1, b.id).toBeGreaterThan(b.x0);
      expect(b.z1, b.id).toBeGreaterThan(b.z0);
      expect(b.h, b.id).toBeGreaterThan(0);
      expect(overlap(b, CAMPUS_BOUNDS), b.id).toBe(true);
    }
  });

  it("buildings do not intersect each other (shared walls allowed)", () => {
    for (let i = 0; i < structures.length; i++)
      for (let j = i + 1; j < structures.length; j++) {
        const a = structures[i], b = structures[j];
        // annex is deliberately attached to the office facade (0.6 m overlap)
        const pad = a.id === "hq" && b.id === "annex" ? 0.7 : 0.01;
        expect(overlap(a, b, pad), `${a.id} × ${b.id}`).toBe(false);
      }
  });

  it("roads and walks never run through a building", () => {
    for (const r of [...ROADS, ...WALKS])
      for (const b of structures) {
        // the passage wall is a gateway: road-2 ends at it and the yard begins behind it
        if (b.id === "passage") continue;
        expect(overlap(r, b, 0.01), `${"id" in r ? r.id : "walk"} × ${b.id}`).toBe(false);
      }
  });

  it("every parked bay lies on asphalt and outside buildings", () => {
    for (const row of PARKING) {
      for (let x = row.x0 + 1.3; x < row.x1; x += 2.6) {
        for (const dz of [-2.4, 2.4]) {
          const z = row.z + dz;
          expect(ROADS.some((r) => inRect(x, z, r)), `bay ${x},${z}`).toBe(true);
          expect(structures.some((b) => inRect(x, z, b)), `bay ${x},${z} in building`).toBe(false);
        }
      }
    }
  });

  it("loading doors face a road", () => {
    for (const b of BUILDINGS)
      for (const d of b.doors ?? []) {
        if (d.kind !== "roller") continue;
        const along = d.side === "+z" || d.side === "-z";
        const x = along ? b.x0 + d.at : d.side === "+x" ? b.x1 + 3 : b.x0 - 3;
        const z = along ? (d.side === "+z" ? b.z1 + 3 : b.z0 - 3) : b.z0 + d.at;
        expect(ROADS.some((r) => inRect(x, z, r)), `${b.id} door at ${x},${z}`).toBe(true);
      }
  });

  it("area labels sit inside the campus", () => {
    for (const a of AREAS) expect(inRect(a.x, a.z, CAMPUS_BOUNDS), a.id).toBe(true);
  });
});
