// SAG campus layout — ESTIMATED from the satellite views and ground photos (not survey data).
// Same world frame as the office model (3d/build_sag_building.py): metres, +Y up, +Z = office front.
//
// Orientation (satellite): the office front faces south-east, toward its parking and the M37 road.
// The factory complex runs north-east along M37, which is +X here. Proportions of the complex
// (~2.2 : 1, long axis parallel to M37) come from the aerial image; absolute size is scaled from
// the office footprint (36 m), which is the only known dimension. See docs/CAMPUS_LAYOUT.md.

export type Cladding = "ribbed" | "stone";
export type WindowKind = "small" | "ribbon" | "office" | "tall";
export type Side = "+x" | "-x" | "+z" | "-z";

export interface WindowRun {
  side: Side;
  kind: WindowKind;
  /** height of the window sill above ground */
  y: number;
  /** start / end along the facade, metres from the facade's low end (x or z min) */
  from: number;
  to: number;
  /** centre spacing; ribbon windows are packed edge to edge when omitted */
  every?: number;
}

export interface DoorSpec {
  side: Side;
  kind: "roller" | "personnel" | "gate";
  at: number; // centre along the facade
  w: number;
  h: number;
}

export interface BuildingSpec {
  id: string;
  name: string;
  category: string;
  interaction: "office" | "inspect";
  info?: string;
  x0: number; x1: number; z0: number; z1: number;
  h: number;
  cladding: Cladding;
  /** blue metal roof edge, as in the photos */
  blueTrim?: boolean;
  /** blue roof tiles coping (gate wall, passage) */
  blueTiles?: boolean;
  solar?: boolean;
  /** raised centre parapet (end block in photo 4): width and extra height */
  parapetStep?: { w: number; h: number };
  windows?: WindowRun[];
  doors?: DoorSpec[];
  /** roof canopy along one side, depth in metres */
  canopy?: { side: Side; depth: number; y: number };
  acUnits?: { side: Side; from: number; to: number; every: number; y: number };
  roofVents?: number;
}

/** The existing office model (not rebuilt; footprint from the build script). */
export const HQ = {
  id: "hq",
  name: "SAG Headquarters",
  category: "Ofis binosi · 6 qavat + podval",
  interaction: "office" as const,
  info: "AI Office: barcha bo'limlar va agentlar shu binoda.",
  x0: -18.8, x1: 19.2, z0: -12.8, z1: 12.8, h: 24.8,
};

export const BUILDINGS: BuildingSpec[] = [
  {
    id: "annex", name: "Kirish bloki", category: "Ofis kirish qismi (2 qavat)", interaction: "inspect",
    info: "Bosh kirish: shisha eshiklar va soyabon (foto 2–3).",
    x0: 18.6, x1: 34, z0: -4, z1: 9, h: 8.4, cladding: "stone",
    windows: [{ side: "+z", kind: "office", y: 5.0, from: 2, to: 13, every: 4.6 }],
    doors: [{ side: "+z", kind: "personnel", at: 7.5, w: 4.2, h: 3.2 }],
  },
  {
    id: "gatewall", name: "Asosiy darvoza", category: "Darvoza va devor", interaction: "inspect",
    info: "Yashil sanoat darvozasi, SAG yozuvi (foto 2).",
    x0: 34, x1: 62, z0: -4, z1: 1, h: 6.2, cladding: "stone", blueTiles: true,
    doors: [{ side: "+z", kind: "gate", at: 12, w: 10, h: 5.2 }],
  },
  {
    id: "factory-a", name: "Factory Building A", category: "Ishlab chiqarish binosi", interaction: "inspect",
    x0: 62, x1: 444, z0: 6, z1: 56, h: 13, cladding: "ribbed", blueTrim: true, solar: true, roofVents: 30,
    windows: [
      { side: "-x", kind: "small", y: 6.4, from: 6, to: 46, every: 7.5 },
      { side: "+z", kind: "small", y: 6.4, from: 8, to: 374, every: 9 },
      { side: "-z", kind: "office", y: 2.6, from: 10, to: 372, every: 12 },
    ],
    doors: [
      { side: "-z", kind: "roller", at: 60, w: 5, h: 5.5 },
      { side: "-z", kind: "roller", at: 130, w: 5, h: 5.5 },
      { side: "-z", kind: "roller", at: 250, w: 5, h: 5.5 },
      { side: "-x", kind: "personnel", at: 40, w: 1.6, h: 2.6 },
    ],
    canopy: { side: "-z", depth: 6, y: 7.2 },
    acUnits: { side: "-z", from: 4, to: 376, every: 8, y: 3.8 },
  },
  {
    id: "admin", name: "Ma'muriy blok", category: "Ofis / ma'muriy bino (1 qavat)", interaction: "inspect",
    info: "Katta derazali bir qavatli bino (foto 7).",
    x0: 62, x1: 122, z0: -26, z1: -10, h: 5.6, cladding: "ribbed", blueTrim: true,
    windows: [{ side: "+z", kind: "office", y: 1.1, from: 4, to: 56, every: 6.5 }],
    doors: [{ side: "+z", kind: "personnel", at: 30, w: 1.4, h: 2.4 }],
    canopy: { side: "+z", depth: 2.2, y: 4.6 },
    acUnits: { side: "+z", from: 6, to: 54, every: 13, y: 3.4 },
  },
  {
    id: "factory-c", name: "Factory Building B", category: "Ishlab chiqarish binosi", interaction: "inspect",
    x0: 122, x1: 444, z0: -62, z1: -10, h: 12, cladding: "ribbed", blueTrim: true, solar: true,
    windows: [
      { side: "+z", kind: "tall", y: 2.2, from: 6, to: 316, every: 6 },
      { side: "-z", kind: "small", y: 6.0, from: 6, to: 316, every: 10 },
    ],
    doors: [
      { side: "+z", kind: "roller", at: 40, w: 4.4, h: 5 },
      { side: "+z", kind: "roller", at: 160, w: 4.4, h: 5 },
      { side: "+z", kind: "roller", at: 260, w: 4.4, h: 5 },
      { side: "+z", kind: "personnel", at: 48, w: 1.4, h: 2.4 },
    ],
  },
  {
    id: "endblock", name: "Warehouse", category: "Ombor · yuklash zonasi", interaction: "inspect",
    info: "Ichki yo'l oxiridagi ombor, markaziy yuklash eshigi (foto 4).",
    x0: 444, x1: 472, z0: -62, z1: 58, h: 17, cladding: "ribbed", solar: true, parapetStep: { w: 30, h: 3 },
    // A and B abut this block; only the road end and the band above their roofs (13 m) are exposed.
    windows: [
      { side: "-x", kind: "ribbon", y: 13.6, from: 44, to: 52.5 },
      { side: "-x", kind: "ribbon", y: 13.6, from: 54, to: 66 },
      { side: "-x", kind: "ribbon", y: 13.6, from: 67.5, to: 76 },
    ],
    doors: [{ side: "-x", kind: "roller", at: 60, w: 7, h: 6.5 }],
  },
  {
    id: "warehouse", name: "Factory Building C", category: "Ishlab chiqarish / ombor", interaction: "inspect",
    x0: 62, x1: 444, z0: -132, z1: -78, h: 11, cladding: "ribbed", blueTrim: true, solar: true,
    windows: [{ side: "+z", kind: "small", y: 5.4, from: 8, to: 376, every: 12 }],
    doors: [
      { side: "+z", kind: "roller", at: 70, w: 5, h: 5.5 },
      { side: "+z", kind: "roller", at: 200, w: 5, h: 5.5 },
      { side: "+z", kind: "roller", at: 320, w: 5, h: 5.5 },
    ],
  },
  {
    id: "passage", name: "O'tish darvozasi", category: "Devor va o'tish joyi", interaction: "inspect",
    info: "Hovlidan orqa yo'lga o'tish (foto 6).",
    x0: 61, x1: 63, z0: -78, z1: -62, h: 7, cladding: "ribbed", blueTiles: true,
    doors: [{ side: "-x", kind: "gate", at: 10, w: 8, h: 5.4 }],
  },
  {
    id: "booth", name: "Qo'riqlash posti", category: "Nazorat punkti", interaction: "inspect",
    x0: 54.8, x1: 57.6, z0: 3.6, z1: 6.4, h: 2.6, cladding: "stone",
  },
];

export interface Area {
  id: string;
  label: string;
  x: number;
  z: number;
}

/** Labelled outdoor areas (labels only; surfaces are in ROADS / PARKING). */
export const AREAS: Area[] = [
  { id: "parking", label: "Parking", x: -4, z: 37 },
  { id: "entrance", label: "Main Entrance", x: 26, z: 13 },
  { id: "yard", label: "Service Yard", x: 42, z: -38 },
  { id: "courtyard", label: "Courtyard", x: 250, z: -2 },
  { id: "loading", label: "Loading Area", x: 432, z: -2 },
];

export interface Rect { x0: number; x1: number; z0: number; z1: number }

/** Asphalt surfaces. Internal roads end at buildings' loading doors or yards, never inside a building. */
export const ROADS: (Rect & { id: string; centerLine?: "x" | "z" })[] = [
  { id: "m37", x0: -220, x1: 640, z0: 66, z1: 84, centerLine: "x" },
  { id: "access", x0: 48, x1: 60, z0: 31.5, z1: 66, centerLine: "z" }, // parking ↔ M37
  { id: "front-lot", x0: -40, x1: 62, z0: 12.8, z1: 58 }, // parking courtyard (office front)
  { id: "gate-lane", x0: 40, x1: 54, z0: 1, z1: 12.8 }, // parking → main gate
  { id: "yard", x0: 19.4, x1: 62, z0: -80, z1: -4 }, // service yard behind the gate
  { id: "yard-2", x0: 62, x1: 122, z0: -62, z1: -26 }, // behind the admin block
  { id: "road-1", x0: 62, x1: 444, z0: -10, z1: 6, centerLine: "x" }, // courtyard road (photos 4, 5, 7)
  { id: "road-2", x0: 63, x1: 444, z0: -78, z1: -62, centerLine: "x" }, // back road, reached through the passage (photo 6)
  { id: "loading", x0: 420, x1: 444, z0: -10, z1: 6 },
];

/** Pedestrian walkways (paving). */
export const WALKS: Rect[] = [
  { x0: -220, x1: 640, z0: 60, z1: 66 }, // M37 sidewalk
  { x0: -220, x1: 640, z0: 84, z1: 90 },
  { x0: -24, x1: 34, z0: 12.85, z1: 14.6 }, // in front of the office podium (its steps sit on this walk)
  { x0: 19.4, x1: 34, z0: 9, z1: 12.85 }, // annex entrance forecourt
];

export interface ParkingRow {
  /** row start / end along X, centre Z, facing ±Z */
  x0: number; x1: number; z: number; facing: 1 | -1;
  /** fraction of bays occupied (deterministic pattern) */
  fill: number;
}

/** 2.6 m bays, 5 m deep. Rows in the front lot; the GLB's centre dashes at z = 27 mark the drive aisle. */
export const PARKING: ParkingRow[] = [
  { x0: -38, x1: 8, z: 17.5, facing: -1, fill: 0.8 },
  { x0: 24, x1: 46, z: 17.5, facing: -1, fill: 0.85 },
  { x0: -38, x1: 46, z: 36.5, facing: 1, fill: 0.75 },
  { x0: -38, x1: 46, z: 41.5, facing: -1, fill: 0.6 },
  { x0: -30, x1: 46, z: 54, facing: 1, fill: 0.5 },
  { x0: 22, x1: 60, z: -60, facing: 1, fill: 0.5 }, // yard
];

/** Campus footprint used for camera framing and pan limits. */
export const CAMPUS_BOUNDS: Rect = { x0: -45, x1: 475, z0: -135, z1: 90 };
