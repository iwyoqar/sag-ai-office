// Pure layout math for floor interiors: department zones and desk positions.
import { INTERIOR } from "./buildingGeometry";

export interface Zone {
  dep: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Split the interior along X proportionally to each department's weight. */
export function layoutZones(deps: { id: string; weight: number }[], bounds = INTERIOR): Zone[] {
  const total = deps.reduce((n, d) => n + d.weight, 0) || 1;
  let x = bounds.x0;
  return deps.map((d) => {
    const w = ((bounds.x1 - bounds.x0) * d.weight) / total;
    const z: Zone = { dep: d.id, x0: x, x1: x + w, z0: bounds.z0, z1: bounds.z1 };
    x += w;
    return z;
  });
}

export interface Desk {
  x: number;
  z: number;
}

const PITCH_X = 3.0;
const PITCH_Z = 3.2;
const MARGIN = 1.4;

/** Grid of desk positions centred in a zone. Front strip (z near z1) is left free for labels/walkway. */
export function layoutDesks(zone: Zone, n: number): Desk[] {
  if (n <= 0) return [];
  const w = zone.x1 - zone.x0 - 2 * MARGIN;
  const d = zone.z1 - zone.z0 - 2 * MARGIN - 2.0;
  const maxCols = Math.max(1, Math.floor(w / PITCH_X) + 1);
  const maxRows = Math.max(1, Math.floor(d / PITCH_Z) + 1);
  let cols = Math.min(maxCols, Math.ceil(Math.sqrt((n * w) / Math.max(d, 1))));
  cols = Math.max(1, cols);
  let rows = Math.ceil(n / cols);
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.ceil(n / rows);
  }
  // Compress pitch if a crowded zone needs more columns than fit.
  const px = cols > 1 ? Math.min(PITCH_X, w / (cols - 1)) : 0;
  const pz = rows > 1 ? Math.min(PITCH_Z, d / (rows - 1)) : 0;
  const cx = (zone.x0 + zone.x1) / 2;
  const cz = zone.z0 + MARGIN + d / 2;
  const desks: Desk[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = r === rows - 1 ? n - r * cols : cols;
    desks.push({
      x: cx + (c - (inRow - 1) / 2) * px,
      z: cz + (r - (rows - 1) / 2) * pz,
    });
  }
  return desks;
}
