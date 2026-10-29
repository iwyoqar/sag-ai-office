import { describe, expect, it } from "vitest";
import { FLOOR_PLANS, planObstacles, propFootprint, podRect } from "../src/scene/office/plan";
import { buildNavGrid, findPath, isFree, lineOfSight, pathLength } from "../src/scene/office/nav";
import { insidePolygon, outline } from "../src/scene/buildingGeometry";
import { activityFor } from "../src/scene/office/behaviour";

const plan = FLOOR_PLANS["5"];
const grid = buildNavGrid(plan.bounds, planObstacles(plan));
const facade = outline(-0.25);

describe("marketing floor plan", () => {
  it("has enough workstations for the department and unique desks", () => {
    expect(plan.workstations.length).toBeGreaterThanOrEqual(11);
    const keys = new Set(plan.workstations.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`));
    expect(keys.size).toBe(plan.workstations.length);
  });

  it("keeps all furniture inside the facade walls", () => {
    for (const p of plan.props) {
      for (const r of propFootprint(p)) {
        for (const c of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]] as [number, number][])
          expect(insidePolygon(c, facade), `${p.kind} @ ${p.x},${p.z}`).toBe(true);
      }
    }
    for (const pod of plan.pods) {
      const r = podRect(pod);
      expect(insidePolygon([r.x0, r.z0], facade) && insidePolygon([r.x1, r.z1], facade)).toBe(true);
    }
  });

  it("every seat has a walkable approach point", () => {
    for (const s of [...plan.workstations, ...plan.meetingSeats]) {
      const ok = isFree(grid, s.ax, s.az) || [[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]].some(([dx, dz]) => isFree(grid, s.ax + dx, s.az + dz));
      expect(ok, `approach ${s.ax},${s.az}`).toBe(true);
    }
  });
});

describe("navigation", () => {
  it("connects every desk to every other desk and to every meeting seat", () => {
    const desks = plan.workstations;
    for (const a of desks) {
      for (const b of [...desks, ...plan.meetingSeats]) {
        const p = findPath(grid, [a.ax, a.az], [b.ax, b.az]);
        expect(p, `${a.ax},${a.az} → ${b.ax},${b.az}`).not.toBeNull();
      }
    }
  });

  it("paths never cross obstacles (segment-checked) and are not absurdly long", () => {
    const a = plan.workstations[0], b = plan.workstations[plan.workstations.length - 1];
    const p = findPath(grid, [a.ax, a.az], [b.ax, b.az])!;
    for (let i = 1; i < p.length - 2; i++) expect(lineOfSight(grid, p[i], p[i + 1]), `segment ${i}`).toBe(true);
    const straight = Math.hypot(b.ax - a.ax, b.az - a.az);
    expect(pathLength(p)).toBeLessThan(straight * 2.2);
  });

  it("goes around the meeting room glass through its door", () => {
    // from the open office straight into the room: must pass the door gap on the east wall (x = −8.8)
    const s = plan.meetingSeats[0];
    const p = findPath(grid, [-6, -3], [s.ax, s.az])!;
    const crossing = p.findIndex((q, i) => i > 0 && (p[i - 1][0] > -8.8) !== (q[0] > -8.8));
    expect(crossing).toBeGreaterThan(0);
    const [q0, q1] = [p[crossing - 1], p[crossing]];
    const zAtWall = q0[1] + ((q1[1] - q0[1]) * (-8.8 - q0[0])) / (q1[0] - q0[0]);
    expect(zAtWall).toBeGreaterThan(-6.8);
    expect(zAtWall).toBeLessThan(-5.6);
  });

  it("returns null for unreachable targets outside the building", () => {
    expect(findPath(grid, [0, 0], [40, 40])).toBeNull();
  });
});

describe("behaviour mapping (backend status → activity)", () => {
  it("maps every status deterministically", () => {
    expect(activityFor("WORKING", "ACTIVE")).toMatchObject({ place: "desk", pose: "sitType" });
    expect(activityFor("THINKING", "ACTIVE")).toMatchObject({ place: "desk", pose: "sitThink" });
    expect(activityFor("COMMUNICATING", "ACTIVE")).toMatchObject({ place: "meeting", pose: "sitTalk" });
    expect(activityFor("WAITING_APPROVAL", "ACTIVE")).toMatchObject({ place: "deskStand", pose: "standWait" });
    expect(activityFor("ERROR", "ACTIVE")).toMatchObject({ place: "deskStand", pose: "standError" });
    expect(activityFor("BLOCKED", "ACTIVE")).toMatchObject({ place: "desk", pose: "sitBlocked" });
    expect(activityFor("COMPLETED", "ACTIVE")).toMatchObject({ place: "deskStand", pose: "celebrate" });
    expect(activityFor("IDLE", "ACTIVE")).toMatchObject({ place: "desk", pose: "sitRelax" });
    // paused overrides work: back at the desk, relaxed
    expect(activityFor("WORKING", "PAUSED")).toMatchObject({ place: "desk", pose: "sitRelax" });
  });
});
