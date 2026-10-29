// Port of the dimensions in 3d/build_sag_building.py. Keep these in sync with that script:
// the GLB has no per-floor nodes, so floor zones are derived from the same numbers.
// Units: metres. +Y up, +Z = front facade (street side).

export const X0 = -18, X1 = 18, Z0 = -12, Z1 = 8;
export const PLINTH = 0.75;
export const FL = [5.0, 8.6, 12.2, 15.8, 19.4, 23.0] as const;
export const TOP = 23.0;
export const ATTIC = 24.8;

const ARC_X0 = -13, ARC_X1 = 7, SAG = 1.5;
const HALF = (ARC_X1 - ARC_X0) / 2;
export const R_BIG = (HALF ** 2 + SAG ** 2) / (2 * SAG);
export const CX_BIG = (ARC_X0 + ARC_X1) / 2;
export const CZ_BIG = Z1 + SAG - R_BIG;
export const A_BIG = Math.asin(HALF / R_BIG);

const CC_X = 13, CC_Z = 3, R_COR = 5;

// Entrance podium (ground floor only)
export const PODIUM = { x0: -14.3, x1: 8.3, z0: Z1, z1: 12.6, top: 5.0 };

// Basement is not in the GLB; it is drawn procedurally under the paving.
export const BASEMENT = { y0: -3.6, y1: 0 };

export type XZ = [number, number];

function linspace(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** Same polygon as outline(o) in the Python script: footprint offset outward by o. */
export function outline(o: number): XZ[] {
  const pts: XZ[] = [
    [X0 - o, Z0 - o],
    [X1 + o, Z0 - o],
    [X1 + o, CC_Z],
  ];
  for (const a of linspace(Math.PI / 2, 0, 13).slice(1)) {
    pts.push([CC_X + (R_COR + o) * Math.sin(a), CC_Z + (R_COR + o) * Math.cos(a)]);
  }
  for (const a of linspace(A_BIG, -A_BIG, 25)) {
    pts.push([CX_BIG + (R_BIG + o) * Math.sin(a), CZ_BIG + (R_BIG + o) * Math.cos(a)]);
  }
  pts.push([X0 - o, Z1 + o]);
  return pts;
}

export interface FloorRange {
  level: number; // -1 basement, 1..6 above ground
  y0: number;
  y1: number;
}

/** Vertical extent of every floor, read from FL/PLINTH. */
export const FLOOR_RANGES: FloorRange[] = [
  { level: -1, y0: BASEMENT.y0, y1: BASEMENT.y1 },
  { level: 1, y0: PLINTH, y1: FL[0] },
  { level: 2, y0: FL[0], y1: FL[1] },
  { level: 3, y0: FL[1], y1: FL[2] },
  { level: 4, y0: FL[2], y1: FL[3] },
  { level: 5, y0: FL[3], y1: FL[4] },
  { level: 6, y0: FL[4], y1: FL[5] },
];

export function floorRange(level: number): FloorRange {
  const r = FLOOR_RANGES.find((f) => f.level === level);
  if (!r) throw new Error(`Unknown floor level ${level}`);
  return r;
}

/** Usable rectangle inside the walls, used for laying out department zones. */
export const INTERIOR = { x0: -17.2, x1: 17.2, z0: -11.2, z1: 7.2 };

/** Even-odd point-in-polygon on the XZ plane. */
export function insidePolygon(p: XZ, poly: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
