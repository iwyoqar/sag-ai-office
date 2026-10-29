import { describe, expect, it } from "vitest";
import type { DeptStats } from "@sag/shared";
import { FLOOR_RANGES, FL, PLINTH, insidePolygon, outline, INTERIOR, floorRange } from "../src/scene/buildingGeometry";
import { layoutDesks, layoutZones } from "../src/scene/layout";
import { Tweens, ease } from "../src/scene/tween";
import { initialView, viewReducer } from "../src/viewState";
import { sumStats } from "../src/api/stats";

describe("building geometry (ported from 3d/build_sag_building.py)", () => {
  it("floor ranges follow FL and PLINTH, contiguous and ordered", () => {
    expect(floorRange(1)).toEqual({ level: 1, y0: PLINTH, y1: FL[0] });
    expect(floorRange(6).y1).toBe(23);
    const above = FLOOR_RANGES.filter((f) => f.level > 0);
    for (let i = 1; i < above.length; i++) expect(above[i].y0).toBe(above[i - 1].y1);
    expect(floorRange(-1).y1).toBe(0);
  });

  it("outline matches the model footprint", () => {
    const pts = outline(0);
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-18);
    expect(Math.max(...xs)).toBeCloseTo(18);
    expect(Math.min(...zs)).toBeCloseTo(-12);
    expect(Math.max(...zs)).toBeCloseTo(9.5, 1); // front glass bulge peaks 1.5 m in front of z = 8
  });

  it("interior rectangle sits inside the footprint", () => {
    const poly = outline(0);
    for (const p of [[INTERIOR.x0, INTERIOR.z0], [INTERIOR.x1, INTERIOR.z0], [INTERIOR.x0, INTERIOR.z1], [INTERIOR.x1, INTERIOR.z1 - 2]] as [number, number][]) {
      expect(insidePolygon(p, poly)).toBe(true);
    }
    expect(insidePolygon([0, 20], poly)).toBe(false);
  });
});

describe("layout", () => {
  const deps = [{ id: "director", weight: 0.8 }, { id: "brain", weight: 1.1 }, { id: "finance", weight: 1 }];

  it("zones cover the interior without gaps", () => {
    const zones = layoutZones(deps);
    expect(zones[0].x0).toBe(INTERIOR.x0);
    expect(zones.at(-1)!.x1).toBeCloseTo(INTERIOR.x1);
    for (let i = 1; i < zones.length; i++) expect(zones[i].x0).toBeCloseTo(zones[i - 1].x1);
  });

  it("desks stay inside their zone and do not overlap, up to crowded zones", () => {
    for (const z of [...layoutZones(deps), ...layoutZones([{ id: "marketing", weight: 1 }])]) {
      for (const n of [1, 2, 7, 11, 24]) {
        const desks = layoutDesks(z, n);
        expect(desks).toHaveLength(n);
        for (const d of desks) {
          expect(d.x).toBeGreaterThan(z.x0);
          expect(d.x).toBeLessThan(z.x1);
          expect(d.z).toBeGreaterThan(z.z0);
          expect(d.z).toBeLessThan(z.z1);
        }
        for (let i = 0; i < desks.length; i++)
          for (let j = i + 1; j < desks.length; j++)
            expect(Math.hypot(desks[i].x - desks[j].x, desks[i].z - desks[j].z)).toBeGreaterThan(1.2);
      }
    }
  });
});

describe("tweens", () => {
  it("runs to completion and resolves", async () => {
    const t = new Tweens();
    const seen: number[] = [];
    const done = t.run(100, (k) => seen.push(k), ease.linear, 0);
    t.tick(50);
    t.tick(100);
    await done;
    expect(seen[0]).toBe(0);
    expect(seen).toContain(0.5);
    expect(seen.at(-1)).toBe(1);
    expect(t.active).toBe(false);
  });

  it("finishAll jumps to the end state", async () => {
    const t = new Tweens();
    let v = 0;
    const done = t.run(1000, (k) => (v = k), ease.linear, 0);
    t.finishAll();
    await done;
    expect(v).toBe(1);
  });
});

describe("view state (floor select / back)", () => {
  const reduce = viewReducer(["B", "1", "2", "3", "4", "5", "6"]);

  it("intro → campus → HQ → floor → agent → back ×4", () => {
    let s = reduce(initialView, { type: "introDone" });
    expect(s.mode).toBe("campus");
    s = reduce(s, { type: "hover", floorId: "3" });
    expect(s.hoveredFloorId).toBeNull(); // floors are not hoverable from the campus
    s = reduce(s, { type: "selectBuilding", buildingId: "hq" });
    expect(s.mode).toBe("overview");
    s = reduce(s, { type: "hover", floorId: "3" });
    expect(s.hoveredFloorId).toBe("3");
    s = reduce(s, { type: "selectFloor", floorId: "4" });
    expect(s).toMatchObject({ mode: "floor", floorId: "4", hoveredFloorId: null });
    s = reduce(s, { type: "hover", floorId: "2" });
    expect(s.hoveredFloorId).toBeNull();
    s = reduce(s, { type: "selectAgent", agentId: "brain-archivist" });
    expect(s.agentId).toBe("brain-archivist");
    s = reduce(s, { type: "back" });
    expect(s).toMatchObject({ mode: "floor", agentId: null });
    s = reduce(s, { type: "back" });
    expect(s).toMatchObject({ mode: "overview", floorId: null });
    s = reduce(s, { type: "back" });
    expect(s.mode).toBe("campus");
  });

  it("factory buildings open the inspect view and go back to the campus", () => {
    const r = viewReducer(["5"], ["factory-a", "annex"]);
    let s = r(r(initialView, { type: "introDone" }), { type: "selectBuilding", buildingId: "factory-a" });
    expect(s).toMatchObject({ mode: "building", buildingId: "factory-a" });
    expect(r(s, { type: "selectBuilding", buildingId: "nope" })).toBe(s);
    s = r(s, { type: "selectFloor", floorId: "5" }); // floor rail works from anywhere
    expect(s).toMatchObject({ mode: "floor", buildingId: null });
    expect(r(r(s, { type: "back" }), { type: "back" }).mode).toBe("campus");
  });

  it("ignores unknown floors and agent selection outside a floor", () => {
    const s = reduce({ ...initialView, mode: "overview" }, { type: "selectFloor", floorId: "9" });
    expect(s.mode).toBe("overview");
    expect(reduce(s, { type: "selectAgent", agentId: "x" }).agentId).toBeNull();
  });
});

describe("stats aggregation", () => {
  const base: DeptStats = {
    departmentId: "a", agents: 2, active: 1, idle: 1, inProgress: 1, queued: 0, waitingApproval: 0,
    completed: 2, errors: 0, avgMinutes: 10, tokens: 100, costUsd: 0.01,
  };

  it("sums counts and weights average time by completed tasks", () => {
    const s = sumStats([base, { ...base, departmentId: "b", completed: 6, avgMinutes: 2, costUsd: 0.02 }, { ...base, departmentId: "c", completed: 0, avgMinutes: null }]);
    expect(s.agents).toBe(6);
    expect(s.completed).toBe(8);
    expect(s.avgMinutes).toBe(4); // (2*10 + 6*2) / 8
    expect(s.costUsd).toBe(0.04);
  });

  it("has no average when nothing finished", () => {
    expect(sumStats([{ ...base, completed: 0, avgMinutes: null }]).avgMinutes).toBeNull();
  });
});
