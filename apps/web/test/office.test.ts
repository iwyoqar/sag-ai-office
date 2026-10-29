import { describe, expect, it } from "vitest";
import { FLOOR_PLANS, planFor, planObstacles, propFootprint, podRect, type FloorPlan, type PlanDept } from "../src/scene/office/plan";
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

// Same departments/weights as the server seed (apps/server/src/db/seedData.ts).
const D = (id: string, weight = 1): PlanDept => ({ id, name: id, color: "#888888", weight });
const FLOORS: Record<string, PlanDept[]> = {
  B: [D("it")], "1": [D("reception")], "2": [D("sales", 1.1), D("design", 0.9)], "3": [D("procurement")],
  "4": [D("director", 0.8), D("brain", 1.1), D("finance")], "6": [D("hr"), D("home", 0.9), D("digital")],
};

describe("generated floor plans (Phase 3: every floor)", () => {
  for (const [floorId, deps] of Object.entries(FLOORS)) {
    it(`floor ${floorId}: furniture inside, no overlaps, every seat reachable`, () => {
      const p: FloorPlan = planFor(floorId, deps)!;
      expect(p.deskDept).toHaveLength(p.workstations.length);
      for (const d of deps) expect(p.deskDept.filter((x) => x === d.id).length, d.id).toBeGreaterThanOrEqual(4);
      const solids = [...p.props.flatMap(propFootprint), ...p.pods.map(podRect)];
      for (const r of solids)
        for (const c of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]] as [number, number][])
          expect(insidePolygon(c, facade), `floor ${floorId} rect ${JSON.stringify(r)}`).toBe(true);
      // seats never sit inside another solid
      for (const s of [...p.workstations, ...p.meetingSeats])
        for (const r of p.props.flatMap(propFootprint))
          expect(s.x > r.x0 && s.x < r.x1 && s.z > r.z0 && s.z < r.z1, `seat ${s.x},${s.z} in ${JSON.stringify(r)}`).toBe(false);
      const hit = (a: { x0: number; x1: number; z0: number; z1: number }, b: typeof a) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
      for (const pod of p.pods.map(podRect))
        for (const r of p.props.flatMap(propFootprint)) expect(hit(pod, r), `pod ${JSON.stringify(pod)} × ${JSON.stringify(r)}`).toBe(false);
      const g = buildNavGrid(p.bounds, planObstacles(p));
      const seats = [...p.workstations, ...p.meetingSeats];
      const hub = seats[0];
      for (const s of seats) expect(findPath(g, [hub.ax, hub.az], [s.ax, s.az]), `floor ${floorId} → ${s.ax},${s.az}`).not.toBeNull();
    });
  }
});

import { ActorMotion, seatSpot } from "../src/scene/office/actor";

describe("agent movement (stand up → walk → sit down)", () => {
  it("walks from a desk to a meeting seat without crossing walls or furniture, then sits", () => {
    const desk = plan.workstations[5];
    const seat = plan.meetingSeats[3];
    const m = new ActorMotion(seatSpot("d5", desk, true));
    expect(m.seated).toBe(true);
    m.goTo(seatSpot("m3", seat, true), grid);
    expect(m.state).toBe("rising");
    const states = new Set<string>();
    let blocked = 0;
    for (let i = 0; i < 2000 && !m.seated; i++) {
      m.step(0.05);
      states.add(m.state);
      if (m.state === "walking" && !isFree(grid, m.x, m.z)) blocked++;
    }
    expect([...states]).toEqual(expect.arrayContaining(["rising", "walking", "sitting", "still"]));
    expect(m.seated).toBe(true);
    expect([m.x, m.z]).toEqual([seat.x, seat.z]);
    expect(m.yaw).toBeCloseTo(seat.face);
    // the start/end of a walk sit on inflated chair edges; the open-floor part must be free
    expect(blocked).toBeLessThan(6);
  });

  it("re-targets mid-walk and stands (not sits) at the desk for waiting states", () => {
    const desk = plan.workstations[0];
    const m = new ActorMotion(seatSpot("d0", desk, true));
    m.goTo(seatSpot("m0", plan.meetingSeats[0], true), grid);
    for (let i = 0; i < 30; i++) m.step(0.05);
    m.goTo(seatSpot("d0", desk, false), grid); // e.g. WAITING_APPROVAL arrives while walking
    for (let i = 0; i < 2000 && m.state !== "still"; i++) m.step(0.05);
    expect(m.state).toBe("still");
    expect(m.seated).toBe(false);
    expect(Math.hypot(m.x - desk.ax, m.z - desk.az)).toBeLessThan(0.01);
  });
});

import { activityForPresence } from "../src/scene/office/behaviour";

describe("human employees in the office (presence from real data)", () => {
  it("maps presence to desk activity and never invents a meeting", () => {
    expect(activityForPresence("working")).toEqual({ place: "desk", pose: "sitType" });
    expect(activityForPresence("reviewing")).toEqual({ place: "desk", pose: "sitThink" });
    expect(activityForPresence("blocked")).toEqual({ place: "desk", pose: "sitBlocked" });
    expect(activityForPresence("available")).toEqual({ place: "desk", pose: "sitRelax" });
    expect(activityForPresence("away")).toBeNull(); // empty desk
    for (const s of ["working", "reviewing", "blocked", "available"] as const) expect(activityForPresence(s)?.place).toBe("desk");
  });
});
