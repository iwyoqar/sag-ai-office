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
  | "glassWall" | "bench"
  // department signature pieces (Phase 3 floors)
  | "serverRack" | "receptionDesk" | "brainCore" | "execDesk" | "whiteboard";

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
  /** department colour accent for the label */
  color?: string;
  x: number;
  z: number;
}

export interface FloorPlan {
  floorId: string;
  /** walkable interior (inside the facade walls) */
  bounds: Rect;
  /** desks: one workstation per seat; an agent takes the n-th seat of its department (agents.workstation = n) */
  workstations: Seat[];
  /** department of each workstation (parallel to `workstations`) */
  deskDept: string[];
  /** desk pods (for furniture): centre + number of desks per side */
  pods: { x: number; z: number; cols: number }[];
  meetingSeats: Seat[];
  props: Prop[];
  areas: Area[];
  /** extra solid obstacles not covered by props (rects already include clearance) */
  obstacles: Rect[];
  /** where people enter/leave the floor (by the front lift lobby) */
  entry: { x: number; z: number };
}

/** Lift lobby at the front of every floor (same core position in the building). */
export const FLOOR_ENTRY = { x: -5, z: 6 };

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
    deskDept: workstations.map(() => "marketing"),
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
    entry: FLOOR_ENTRY,
  };
}

export const FLOOR_PLANS: Record<string, FloorPlan> = { "5": marketingPlan() };

const BOUNDS: Rect = { x0: -17.25, x1: 17.25, z0: -11.25, z1: 7.4 };
const POD_PITCH = 2 * (DESK_W + 0.08) + 1.9; // pod width + aisle

export interface PlanDept { id: string; name: string; color: string; weight: number }

/**
 * Generated plan for floors without a hand-made layout: departments side by side (by weight, like the overview),
 * a row of desk pods per department, a shared meeting table, glass partitions between departments at the back,
 * and each department's signature furniture against the back wall.
 */
export function zonePlan(floorId: string, deps: PlanDept[]): FloorPlan {
  const total = deps.reduce((n, d) => n + d.weight, 0) || 1;
  const inner = { x0: BOUNDS.x0 + 0.3, x1: BOUNDS.x1 - 0.3 };
  let x = inner.x0;
  const zones = deps.map((d) => {
    const w = ((inner.x1 - inner.x0) * d.weight) / total;
    const z = { dep: d, x0: x, x1: x + w };
    x += w;
    return z;
  });
  // meeting table goes to the widest zone's back half; the others get their signature props there
  // …preferring a zone whose department has no centrepiece of its own (Brain core, director desk, racks, reception)
  const widest = (zs: typeof zones) => zs.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
  const plain = zones.filter((z) => !["brain", "director", "it", "reception"].includes(z.dep.id));
  const meetZone = widest(plain.length ? plain : zones);
  const pods: FloorPlan["pods"] = [];
  const workstations: Seat[] = [];
  const deskDept: string[] = [];
  const props: Prop[] = [];
  const areas: Area[] = [];
  const meetingSeats: Seat[] = [];
  const single = zones.length === 1;

  zones.forEach((z, zi) => {
    const w = z.x1 - z.x0;
    const cx = (z.x0 + z.x1) / 2;
    const n = Math.max(1, Math.floor((w - 1.2) / POD_PITCH));
    // single-department floors get a second, rear row of pods
    const rows = single && z.dep.id !== "reception" ? [-0.4, -6.0] : [-0.4];
    for (const pz of rows) {
      for (let i = 0; i < (pz === -0.4 ? n : Math.max(1, n - 2)); i++) {
        const cnt = pz === -0.4 ? n : Math.max(1, n - 2);
        const px = cx + (i - (cnt - 1) / 2) * POD_PITCH;
        pods.push({ x: px, z: pz, cols: 2 });
        for (const s of podSeats(px, pz, 2)) {
          workstations.push(s);
          deskDept.push(z.dep.id);
        }
      }
    }
    areas.push({ label: z.dep.name, color: z.dep.color, x: cx, z: 5.6 });
    if (zi > 0) props.push({ kind: "glassWall", x: z.x0, z: -11.2, w: 7.2, rot: Math.PI / 2 });
    props.push({ kind: "plant", x: z.x0 + 0.8, z: 3.4 });

    const back = -10.6;
    if (z === meetZone && !single) return; // meeting table takes this zone's back
    switch (z.dep.id) {
      case "it":
        for (let k = 0; k < Math.min(8, Math.floor((w - 2) / 1.1)); k++) props.push({ kind: "serverRack", x: z.x0 + 1.6 + k * 1.1, z: back });
        break;
      case "reception":
        props.push({ kind: "receptionDesk", x: cx, z: -7.6 });
        props.push({ kind: "sofaL", x: cx + 7.5, z: -9.6 });
        props.push({ kind: "coffeeTable", x: cx + 6.6, z: -7.7 });
        props.push({ kind: "wallScreen", x: cx, z: -11.05 });
        break;
      case "brain":
        props.push({ kind: "brainCore", x: cx, z: -8.2 });
        props.push({ kind: "shelf", x: cx, z: -10.85, w: Math.min(5, w - 2) });
        break;
      case "director":
        props.push({ kind: "execDesk", x: cx, z: -8.4 });
        props.push({ kind: "credenza", x: cx, z: -10.85, w: Math.min(3.6, w - 2) });
        break;
      case "finance":
        props.push({ kind: "analyticsWall", x: cx, z: -11.05 });
        props.push({ kind: "credenza", x: cx, z: -10.75, w: Math.min(5, w - 2) });
        break;
      case "design":
      case "home":
        props.push({ kind: "moodboard", x: cx, z: -11.05, w: Math.min(4, w - 2) });
        props.push({ kind: "highTable", x: cx, z: -8.0 });
        props.push({ kind: "stool", x: cx - 1.1, z: -8.0 });
        props.push({ kind: "stool", x: cx + 1.1, z: -8.0 });
        break;
      case "sales":
        props.push({ kind: "displayStand", x: cx - 1.4, z: -9.8 });
        props.push({ kind: "displayStand", x: cx + 1.4, z: -9.8 });
        props.push({ kind: "whiteboard", x: cx, z: -11.0, w: Math.min(3, w - 2) });
        break;
      default: // procurement, hr, digital, …
        props.push({ kind: "kanban", x: cx, z: -10.6, w: Math.min(3.2, w - 2) });
        props.push({ kind: "whiteboard", x: cx + Math.min(3, w / 2 - 1.2), z: -11.0, w: 1.8 });
    }
    props.push({ kind: "plantTall", x: z.x1 - 0.8, z: -10.4 });
  });

  // shared meeting table (back half of the widest zone; on single-department floors, the east end)
  const mt = single ? { x: 12.6, z: -8.4 } : { x: (meetZone.x0 + meetZone.x1) / 2, z: -8.4 };
  props.push({ kind: "meetingTable", x: mt.x, z: mt.z }, { kind: "wallScreen", x: mt.x, z: -11.05 });
  for (const sx of [-1.5, -0.5, 0.5, 1.5])
    for (const side of [-1, 1]) {
      const z = mt.z + side * 1.15;
      meetingSeats.push({ x: mt.x + sx, z, face: side === -1 ? 0 : Math.PI, ax: mt.x + sx, az: z + side * 0.65 });
    }
  areas.push({ label: "Meeting", x: mt.x, z: -6.2 });
  props.push({ kind: "coffeePoint", x: 16.6, z: 1.6, rot: -Math.PI / 2 });

  return { floorId, bounds: BOUNDS, workstations, deskDept, pods, meetingSeats, props, areas, obstacles: [], entry: FLOOR_ENTRY };
}

export function planFor(floorId: string, deps?: PlanDept[]): FloorPlan | undefined {
  return FLOOR_PLANS[floorId] ?? (deps?.length ? zonePlan(floorId, deps) : undefined);
}

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
    case "serverRack": return [box(0.9, 0.9)];
    case "receptionDesk": return [box(5.4, 1.6)];
    case "brainCore": return [box(2.4, 2.4)];
    case "execDesk": return [box(2.4, 1.0)];
    case "whiteboard": return [box(p.w ?? 2, 0.3)];
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
