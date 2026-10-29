// Floor plans for the realistic interiors, in world X/Z (same frame as the building; Y is relative to the floor).
// Pure data so layout, navigation and seating can be unit-tested without WebGL.

export interface Rect { x0: number; x1: number; z0: number; z1: number }

/** A seat an agent can occupy. `face` = yaw the seated person looks toward (0 = +Z). */
export interface Seat {
  x: number;
  z: number;
  face: number;
  /** where the agent stands before sitting down / after standing up (must be walkable) */
  ax: number;
  az: number;
}

export type PropKind =
  | "meetingTable" | "wallScreen" | "analyticsWall" | "credenza" | "sofaL" | "armchair" | "coffeeTable" | "rug"
  | "moodboard" | "shelf" | "kanban" | "highTable" | "stool" | "displayStand" | "coffeePoint" | "plant" | "plantTall"
  | "glassWall" | "bench";

export interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  /** yaw in radians */
  rot?: number;
  /** size for wall-like / scalable props */
  w?: number;
  d?: number;
  /** glass walls: door gap [from, to] along the wall, metres from its start */
  gap?: [number, number];
}

export interface Area {
  label: string;
  x: number;
  z: number;
}

export interface FloorPlan {
  floorId: string;
  /** walkable interior (inside the facade walls) */
  bounds: Rect;
  /** desks: one workstation per seat, indexed by agents.workstation */
  workstations: Seat[];
  /** desk pods (for furniture): centre + number of desks per side */
  pods: { x: number; z: number; cols: number }[];
  meetingSeats: Seat[];
  props: Prop[];
  areas: Area[];
  /** extra solid obstacles not covered by props (rects already include clearance) */
  obstacles: Rect[];
}

const DESK_W = 1.5;
const DESK_D = 0.75;
const CHAIR_OFF = 0.62; // seat centre from desk edge
const APPROACH = 0.75; // standing spot behind the chair

/** Back-to-back pod of 2 × cols desks centred at (x, z); north row faces +Z, south row faces −Z. */
function podSeats(x: number, z: number, cols: number): Seat[] {
  const seats: Seat[] = [];
  for (const row of [-1, 1]) {
    for (let c = 0; c < cols; c++) {
      const sx = x + (c - (cols - 1) / 2) * (DESK_W + 0.08);
      const sz = z + row * (DESK_D + CHAIR_OFF);
      // row −1 sits on the north side looking south (+Z toward the desk) …
      const face = row === -1 ? 0 : Math.PI;
      seats.push({ x: sx, z: sz, face, ax: sx, az: sz + row * APPROACH });
    }
  }
  return seats;
}

export function podRect(p: { x: number; z: number; cols: number }): Rect {
  const w = p.cols * (DESK_W + 0.08);
  return { x0: p.x - w / 2, x1: p.x + w / 2, z0: p.z - DESK_D - 0.04, z1: p.z + DESK_D + 0.04 };
}

/** Marketing — 5th floor (pilot of the realistic interior system). */
function marketingPlan(): FloorPlan {
  const pods = [
    { x: -10.4, z: -0.4, cols: 2 },
    { x: -3.5, z: -0.4, cols: 2 },
    { x: 3.4, z: -0.4, cols: 2 },
    { x: 10.3, z: -0.4, cols: 2 },
  ];
  // Desk order: front rows first, west → east, so seeded agents fill the middle of the room.
  const workstations = pods.flatMap((p) => podSeats(p.x, p.z, p.cols));

  // Meeting room (glass) in the north-west corner: table 4.2 × 1.4 centred at (−13, −8.1).
  const mt = { x: -13, z: -8.1 };
  const meetingSeats: Seat[] = [];
  for (const sx of [-1.5, -0.5, 0.5, 1.5]) {
    for (const side of [-1, 1]) {
      const z = mt.z + side * 1.15;
      meetingSeats.push({ x: mt.x + sx, z, face: side === -1 ? 0 : Math.PI, ax: mt.x + sx, az: z + side * 0.65 });
    }
  }

  const props: Prop[] = [
    // meeting room: glass walls (east wall with door gap, south wall), table, TV
    { kind: "glassWall", x: -8.8, z: -11.2, w: 6.3, rot: Math.PI / 2, gap: [4.4, 5.6] }, // runs from z −11.2 southward
    { kind: "glassWall", x: -17.2, z: -4.9, w: 8.4, rot: 0 },
    { kind: "meetingTable", x: mt.x, z: mt.z },
    { kind: "wallScreen", x: -13, z: -11.05 },
    { kind: "plant", x: -16.6, z: -5.6 },

    // analytics wall + credenza on the back wall
    { kind: "analyticsWall", x: 0, z: -11.05 },
    { kind: "credenza", x: 0, z: -10.75, w: 6 },
    { kind: "plantTall", x: -4.2, z: -10.6 },
    { kind: "plantTall", x: 4.2, z: -10.6 },

    // creative lounge (north-east)
    { kind: "rug", x: 13.4, z: -8.2, w: 6.2, d: 4.4 },
    { kind: "sofaL", x: 14.2, z: -9.6 },
    { kind: "armchair", x: 11.0, z: -7.2, rot: Math.PI / 2 },
    { kind: "coffeeTable", x: 13.2, z: -7.6 },
    { kind: "moodboard", x: 13.6, z: -11.05, w: 4 },
    { kind: "shelf", x: 9.4, z: -8.4, w: 5, rot: Math.PI / 2 },
    { kind: "plant", x: 16.6, z: -5.8 },

    // content planning (south-west)
    { kind: "kanban", x: -16.3, z: 3.9, rot: Math.PI / 2, w: 3.2 },
    { kind: "highTable", x: -13.4, z: 3.9 },
    { kind: "stool", x: -13.4, z: 2.9 },
    { kind: "stool", x: -13.4, z: 4.9 },
    { kind: "stool", x: -12.4, z: 3.9 },
    { kind: "plantTall", x: -16.5, z: 6.6 },

    // campaign displays (south, by the curved glass)
    { kind: "displayStand", x: 0.5, z: 5.2, rot: Math.PI },
    { kind: "displayStand", x: 3.2, z: 5.2, rot: Math.PI },
    { kind: "bench", x: 1.85, z: 3.5 },

    // coffee point (east)
    { kind: "coffeePoint", x: 16.6, z: 1.2, rot: -Math.PI / 2 },
    { kind: "plant", x: 16.6, z: 4.0 },

    // greenery between zones and along the façade
    { kind: "plant", x: -7.0, z: -3.6 },
    { kind: "plant", x: 7.0, z: -3.6 },
    { kind: "plant", x: -7.0, z: 2.8 },
    { kind: "plant", x: 7.0, z: 2.8 },
    { kind: "plantTall", x: -9.0, z: 7.6 },
    { kind: "plantTall", x: 4.8, z: 7.3 },
    { kind: "plant", x: 11.6, z: 6.6 },
  ];

  return {
    floorId: "5",
    bounds: { x0: -17.25, x1: 17.25, z0: -11.25, z1: 7.4 },
    workstations,
    pods,
    meetingSeats,
    props,
    areas: [
      { label: "Meeting room", x: -13, z: -5.6 },
      { label: "Analytics", x: 0, z: -9.4 },
      { label: "Creative lounge", x: 13.6, z: -5.6 },
      { label: "Content planning", x: -13.6, z: 6.2 },
      { label: "Campaign displays", x: 1.8, z: 6.6 },
    ],
    obstacles: [],
  };
}

export const FLOOR_PLANS: Record<string, FloorPlan> = { "5": marketingPlan() };

export const planFor = (floorId: string): FloorPlan | undefined => FLOOR_PLANS[floorId];

/** Footprint rectangles of every solid prop (used for the navigation grid). */
export function propFootprint(p: Prop): Rect[] {
  const box = (w: number, d: number): Rect => {
    // rotation by ±90° swaps the footprint axes
    const swap = Math.abs(Math.sin(p.rot ?? 0)) > 0.7;
    const hw = (swap ? d : w) / 2, hd = (swap ? w : d) / 2;
    return { x0: p.x - hw, x1: p.x + hw, z0: p.z - hd, z1: p.z + hd };
  };
  switch (p.kind) {
    case "meetingTable": return [box(4.2, 1.4)];
    case "wallScreen": case "analyticsWall": case "moodboard": case "rug": return [];
    case "credenza": return [box(p.w ?? 4, 0.5)];
    case "sofaL": return [box(4.0, 1.0), { x0: p.x + 1.0, x1: p.x + 2.0, z0: p.z, z1: p.z + 2.2 }];
    case "armchair": return [box(0.9, 0.9)];
    case "coffeeTable": return [box(1.2, 1.2)];
    case "shelf": return [box(p.w ?? 4, 0.45)];
    case "kanban": return [box(p.w ?? 3, 0.5)];
    case "highTable": return [box(1.6, 0.8)];
    case "stool": return [box(0.45, 0.45)];
    case "displayStand": return [box(1.7, 0.6)];
    case "bench": return [box(2.0, 0.5)];
    case "coffeePoint": return [box(2.4, 0.65)];
    case "plant": return [box(0.6, 0.6)];
    case "plantTall": return [box(0.7, 0.7)];
    case "glassWall": {
      const len = p.w ?? 4;
      const along = Math.abs(Math.sin(p.rot ?? 0)) > 0.7 ? "z" : "x";
      const segs: [number, number][] = p.gap ? [[0, p.gap[0]], [p.gap[1], len]] : [[0, len]];
      return segs.map(([a, b]) =>
        along === "x"
          ? { x0: p.x + a, x1: p.x + b, z0: p.z - 0.06, z1: p.z + 0.06 }
          : { x0: p.x - 0.06, x1: p.x + 0.06, z0: p.z + a, z1: p.z + b },
      );
    }
  }
}

/** All solid obstacles for navigation: props, desk pods, chairs (except the agent's own approach line). */
export function planObstacles(plan: FloorPlan): Rect[] {
  const out: Rect[] = [...plan.obstacles];
  for (const p of plan.props) out.push(...propFootprint(p));
  for (const pod of plan.pods) out.push(podRect(pod));
  for (const s of [...plan.workstations, ...plan.meetingSeats])
    out.push({ x0: s.x - 0.28, x1: s.x + 0.28, z0: s.z - 0.28, z1: s.z + 0.28 });
  return out;
}
