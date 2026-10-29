// Occupancy-grid navigation for office floors: A* (8-neighbour, no corner cutting) + line-of-sight smoothing.
import { insidePolygon, outline, type XZ } from "../buildingGeometry";
import type { Rect } from "./plan";

export interface NavGrid {
  x0: number;
  z0: number;
  cell: number;
  w: number;
  h: number;
  /** 1 = blocked */
  blocked: Uint8Array;
}

export const AGENT_RADIUS = 0.28;

/**
 * Rasterise walkable space: inside the facade outline (inset by wall thickness + agent radius)
 * and outside every obstacle inflated by the agent radius.
 */
export function buildNavGrid(bounds: Rect, obstacles: Rect[], cell = 0.2, wallInset = 0.3): NavGrid {
  const pad = 1;
  const x0 = bounds.x0 - pad, z0 = bounds.z0 - pad;
  const w = Math.ceil((bounds.x1 - bounds.x0 + 2 * pad + 3) / cell);
  const h = Math.ceil((bounds.z1 - bounds.z0 + 2 * pad + 3) / cell);
  const blocked = new Uint8Array(w * h);
  const poly = outline(-(wallInset + AGENT_RADIUS));
  const r = AGENT_RADIUS;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
      let b = !insidePolygon([x, z] as XZ, poly);
      if (!b)
        for (const o of obstacles)
          if (x > o.x0 - r && x < o.x1 + r && z > o.z0 - r && z < o.z1 + r) {
            b = true;
            break;
          }
      blocked[j * w + i] = b ? 1 : 0;
    }
  }
  return { x0, z0, cell, w, h, blocked };
}

const toCell = (g: NavGrid, x: number, z: number): [number, number] => [
  Math.floor((x - g.x0) / g.cell), Math.floor((z - g.z0) / g.cell),
];
const center = (g: NavGrid, i: number, j: number): XZ => [g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 0.5) * g.cell];

export function isFree(g: NavGrid, x: number, z: number): boolean {
  const [i, j] = toCell(g, x, z);
  return i >= 0 && j >= 0 && i < g.w && j < g.h && !g.blocked[j * g.w + i];
}

/** Nearest free cell to a point (start/goal may sit on an inflated edge, e.g. right behind a chair). */
function nearestFree(g: NavGrid, i: number, j: number): [number, number] | null {
  for (let r = 0; r < 12; r++)
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < g.w && b < g.h && !g.blocked[b * g.w + a]) return [a, b];
      }
  return null;
}

/** Bresenham-style walk along the segment; true if every cell is free. */
export function lineOfSight(g: NavGrid, a: XZ, b: XZ): boolean {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g.cell * 0.5));
  for (let k = 0; k <= steps; k++) {
    const t = steps ? k / steps : 0;
    if (!isFree(g, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
  }
  return true;
}

/**
 * A* from a to b. Returns world waypoints starting at `a` and ending at `b`, or null if unreachable.
 * Endpoints snap to the nearest free cell, so standing spots next to furniture still work.
 */
export function findPath(g: NavGrid, a: XZ, b: XZ): XZ[] | null {
  const s = nearestFree(g, ...toCell(g, a[0], a[1]));
  const t = nearestFree(g, ...toCell(g, b[0], b[1]));
  if (!s || !t) return null;
  const W = g.w;
  const start = s[1] * W + s[0], goal = t[1] * W + t[0];
  const gScore = new Float32Array(g.w * g.h).fill(Infinity);
  const came = new Int32Array(g.w * g.h).fill(-1);
  const closed = new Uint8Array(g.w * g.h);
  // binary heap of [f, idx]
  const heap: [number, number][] = [];
  const push = (f: number, idx: number) => {
    heap.push([f, idx]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  const hfn = (i: number, j: number) => {
    const dx = Math.abs(i - t[0]), dz = Math.abs(j - t[1]);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  gScore[start] = 0;
  push(hfn(s[0], s[1]), start);
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.length) {
    const [, cur] = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % W, cj = (cur / W) | 0;
    for (const [di, dj, cost] of dirs) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
      const n = nj * W + ni;
      if (g.blocked[n] || closed[n]) continue;
      // no squeezing diagonally between two blocked cells
      if (di && dj && (g.blocked[cj * W + ni] || g.blocked[nj * W + ci])) continue;
      const ng = gScore[cur] + cost;
      if (ng < gScore[n]) {
        gScore[n] = ng;
        came[n] = cur;
        push(ng + hfn(ni, nj), n);
      }
    }
  }
  if (start !== goal && came[goal] < 0) return null;
  const cells: XZ[] = [];
  for (let c = goal; c !== -1; c = c === start ? -1 : came[c]) cells.push(center(g, c % W, (c / W) | 0));
  cells.reverse();
  return smooth(g, [a, ...cells, b]);
}

/** Greedy string-pulling: keep a waypoint only when the straight line to the next one is blocked. */
export function smooth(g: NavGrid, pts: XZ[]): XZ[] {
  if (pts.length <= 2) return pts;
  const out: XZ[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    // endpoints may sit inside an inflated edge; only test the interior of the segment
    while (j > i + 1 && !lineOfSight(g, nudge(pts[i], pts[j]), nudge(pts[j], pts[i]))) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** Point moved 0.35 m from a toward b (so endpoint cells next to furniture don't fail the sight test). */
function nudge(a: XZ, b: XZ): XZ {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d < 0.8) return a;
  const k = 0.35 / d;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

export function pathLength(p: XZ[]): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) n += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return n;
}
