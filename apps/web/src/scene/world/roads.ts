// Road network: one graph for the whole world (campus roads, the M37, links, the store district streets).
// The same graph drives the road surfaces that are drawn from it (roadRender.ts) and the traffic (traffic.ts):
// vehicles only ever move along lane paths built from its edges, so they cannot leave the road or cross buildings.
//
// Conventions: metres, y up, right-hand traffic. Nodes are junctions, bends, dead ends (docks) or roundabouts;
// named destinations (docks, the HQ car park, store loading gates) are nodes too.
import * as THREE from "three";

export type RoadClass = "highway" | "main" | "street" | "service" | "industrial";

/** speed limit per road class, m/s */
export const SPEED: Record<RoadClass, number> = { highway: 15, main: 12, street: 9, service: 6, industrial: 8 };

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  /** roundabout: ring radius of the lane centre */
  ring?: number;
  dest?: string;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  /** lane centre offset from the road centre line (right-hand side of travel) */
  lane: number;
  /** paved width, for drawing and junction sizing */
  width: number;
  /** drawn by roadRender (false: the surface already exists, e.g. the campus roads in site.ts) */
  draw: boolean;
  len: number;
}

export type VehicleKind = "van" | "medium" | "large" | "semi";

/** route cost multipliers: heavy trucks keep to industrial / main roads, vans prefer streets */
const CLASS_COST: Record<VehicleKind, Record<RoadClass, number>> = {
  van: { highway: 1, main: 1, street: 1, service: 1.3, industrial: 1.6 },
  medium: { highway: 1, main: 1, street: 1.2, service: 1.4, industrial: 1.2 },
  large: { highway: 1, main: 1, street: 1.6, service: 1.6, industrial: 0.9 },
  semi: { highway: 0.9, main: 1, street: 3, service: 2, industrial: 0.8 },
};

export class RoadGraph {
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];
  readonly adj: number[][] = [];
  readonly dests = new Map<string, number>();
  private routeCache = new Map<string, number[] | null>();

  /** Node at (x, z); an existing node within 0.5 m is reused, so segments sharing an end point connect. */
  node(x: number, z: number, opts: { ring?: number; dest?: string } = {}): number {
    let n = this.nodes.find((o) => Math.abs(o.x - x) < 0.5 && Math.abs(o.z - z) < 0.5);
    if (!n) {
      n = { id: this.nodes.length, x, z };
      this.nodes.push(n);
      this.adj.push([]);
    }
    if (opts.ring) n.ring = opts.ring;
    if (opts.dest) {
      n.dest = opts.dest;
      this.dests.set(opts.dest, n.id);
    }
    return n.id;
  }

  edge(a: number, b: number, cls: RoadClass, width: number, lane = width / 4, draw = false): number {
    const na = this.nodes[a], nb = this.nodes[b];
    const e: RoadEdge = { id: this.edges.length, a, b, cls, lane, width, draw, len: Math.hypot(nb.x - na.x, nb.z - na.z) };
    this.edges.push(e);
    this.adj[a].push(e.id);
    this.adj[b].push(e.id);
    this.routeCache.clear();
    return e.id;
  }

  /** A road through several points (consecutive edges). */
  chain(points: [number, number][], cls: RoadClass, width: number, lane = width / 4, draw = false): number[] {
    const ids = points.map(([x, z]) => this.node(x, z));
    for (let i = 0; i + 1 < ids.length; i++) this.edge(ids[i], ids[i + 1], cls, width, lane, draw);
    return ids;
  }

  /**
   * Splits an existing edge at a point on it (a junction or destination added later) and returns the new node.
   * Used for T-junctions and for docks that sit along a road.
   */
  splitAt(x: number, z: number, opts: { dest?: string } = {}): number {
    const existing = this.nodes.find((o) => Math.abs(o.x - x) < 0.5 && Math.abs(o.z - z) < 0.5);
    if (existing) return this.node(x, z, opts);
    for (const e of this.edges) {
      const a = this.nodes[e.a], b = this.nodes[e.b];
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
      const t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
      if (t <= 0.001 || t >= 0.999) continue;
      if (Math.hypot(a.x + dx * t - x, a.z + dz * t - z) > 0.5) continue;
      const n = this.node(x, z, opts);
      // shorten e to a→n, add n→b
      const oldB = e.b;
      this.adj[oldB] = this.adj[oldB].filter((id) => id !== e.id);
      e.b = n;
      e.len = Math.hypot(this.nodes[n].x - a.x, this.nodes[n].z - a.z);
      this.adj[n].push(e.id);
      this.edge(n, oldB, e.cls, e.width, e.lane, e.draw);
      return n;
    }
    throw new Error(`splitAt: no road at ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }

  degree(n: number) {
    return this.adj[n].length;
  }

  other(e: RoadEdge, n: number) {
    return e.a === n ? e.b : e.a;
  }

  edgeBetween(a: number, b: number): RoadEdge | undefined {
    for (const id of this.adj[a]) {
      const e = this.edges[id];
      if (this.other(e, a) === b) return e;
    }
    return undefined;
  }

  /** Checks: one connected network, and every dead end is a named destination (a dock), never a stray stub. */
  validate(): { components: number; strayEnds: RoadNode[]; unreachable: string[] } {
    const seen = new Set<number>();
    let components = 0;
    for (const n of this.nodes) {
      if (seen.has(n.id) || !this.adj[n.id].length) continue;
      components++;
      const stack = [n.id];
      seen.add(n.id);
      while (stack.length) {
        const c = stack.pop()!;
        for (const id of this.adj[c]) {
          const o = this.other(this.edges[id], c);
          if (!seen.has(o)) {
            seen.add(o);
            stack.push(o);
          }
        }
      }
    }
    const strayEnds = this.nodes.filter((n) => this.degree(n.id) === 1 && !n.dest);
    const first = this.dests.values().next().value;
    const unreachable = first === undefined ? [] : [...this.dests.keys()].filter((d) => !this.route(first, this.dests.get(d)!, "van"));
    return { components, strayEnds, unreachable };
  }

  /** Cheapest node sequence from a to b for a vehicle kind (Dijkstra; cached, so it runs once per pair and kind). */
  route(a: number, b: number, kind: VehicleKind): number[] | null {
    const key = `${a}>${b}:${kind}`;
    if (this.routeCache.has(key)) return this.routeCache.get(key)!;
    const cost = CLASS_COST[kind];
    const dist = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const done = new Uint8Array(this.nodes.length);
    dist[a] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < best) (best = dist[i]), (u = i);
      if (u < 0 || u === b) break;
      done[u] = 1;
      for (const id of this.adj[u]) {
        const e = this.edges[id];
        const v = this.other(e, u);
        const d = best + e.len * cost[e.cls];
        if (d < dist[v]) {
          dist[v] = d;
          prev[v] = u;
        }
      }
    }
    let out: number[] | null = null;
    if (dist[b] < Infinity) {
      out = [];
      for (let c = b; c !== -1; c = prev[c]) out.push(c);
      out.reverse();
    }
    this.routeCache.set(key, out);
    return out;
  }
}

// ---- lane paths --------------------------------------------------------------------------------------------------

/** A drivable polyline in one lane, with cumulative lengths for O(log n) sampling. */
export class LanePath {
  readonly xs: Float32Array;
  readonly zs: Float32Array;
  readonly s: Float32Array;
  /** speed limit at each point */
  readonly limit: Float32Array;
  readonly length: number;
  /** distance along the path of each named stop (index = route node index) */
  readonly stops = new Map<number, number>();
  /** junctions on the way: node id and the stretch [enter, exit] where the vehicle is inside it */
  readonly junctions: { node: number; enter: number; exit: number }[] = [];

  constructor(pts: { x: number; z: number; v: number }[]) {
    const n = pts.length;
    this.xs = new Float32Array(n);
    this.zs = new Float32Array(n);
    this.s = new Float32Array(n);
    this.limit = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (i) acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      this.xs[i] = pts[i].x;
      this.zs[i] = pts[i].z;
      this.s[i] = acc;
      this.limit[i] = pts[i].v;
    }
    this.length = acc;
  }

  private index(s: number): number {
    let lo = 0, hi = this.s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Position at distance s (clamped to the path). */
  at(s: number, out: { x: number; z: number }) {
    s = Math.max(0, Math.min(this.length, s));
    const i = this.index(s);
    const j = Math.min(i + 1, this.s.length - 1);
    const span = this.s[j] - this.s[i] || 1;
    const t = (s - this.s[i]) / span;
    out.x = this.xs[i] + (this.xs[j] - this.xs[i]) * t;
    out.z = this.zs[i] + (this.zs[j] - this.zs[i]) * t;
    return out;
  }

  limitAt(s: number) {
    return this.limit[this.index(Math.max(0, Math.min(this.length, s)))];
  }
}

const _v = new THREE.Vector2();

/**
 * Builds the lane path for a node sequence: each edge in its right-hand lane, trimmed at junctions and joined by
 * smooth turn curves; dead-end reversals become U-turns, roundabouts are driven anticlockwise round the island.
 */
export function buildLanePath(g: RoadGraph, route: number[]): LanePath {
  const pts: { x: number; z: number; v: number }[] = [];
  const stopIdx: [number, number][] = [];
  const junc: { node: number; i0: number; i1: number }[] = [];
  const push = (x: number, z: number, v: number) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last.x - x, last.z - z) < 0.05) return;
    pts.push({ x, z, v });
  };
  const edges = route.slice(0, -1).map((n, i) => g.edgeBetween(n, route[i + 1])!);
  const dir = (i: number) => {
    const a = g.nodes[route[i]], b = g.nodes[route[i + 1]];
    _v.set(b.x - a.x, b.z - a.z).normalize();
    return { x: _v.x, z: _v.y };
  };
  // trim distance at a node: inside a junction / roundabout the turn curve takes over from the straight lane
  const trim = (n: number, e: RoadEdge) => {
    const node = g.nodes[n];
    if (node.ring) return node.ring + 1;
    const deg = g.degree(n);
    if (deg >= 3) return Math.max(...g.adj[n].map((id) => g.edges[id].width)) / 2;
    if (deg === 1) return e.lane * 1.4; // dead end: room for the U-turn loop
    // a bend between two edges: a short curve, unless the road runs straight through (a stop on a street)
    const [e1, e2] = g.adj[n].map((id) => g.edges[id]);
    const o1 = g.nodes[g.other(e1, n)], o2 = g.nodes[g.other(e2, n)];
    const a1 = Math.atan2(o1.z - node.z, o1.x - node.x), a2 = Math.atan2(o2.z - node.z, o2.x - node.x);
    const straight = Math.abs(Math.abs(((a1 - a2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)) < 0.05;
    return straight ? 0 : Math.min(7, Math.min(e1.len, e2.len) / 3);
  };

  let prevEnd: { x: number; z: number; d: { x: number; z: number }; v: number } | null = null;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const d = dir(i);
    const r = { x: -d.z, z: d.x };
    const a = g.nodes[route[i]], b = g.nodes[route[i + 1]];
    const isFirst = i === 0, isLast = i === edges.length - 1;
    const ts = isFirst ? 0 : Math.min(trim(route[i], e), e.len * 0.45);
    // a trip ending at a dead-end dock stops where the next trip's U-turn will start (same trim as passing through)
    const endTrim = isLast && g.degree(route[i + 1]) !== 1 ? 0 : trim(route[i + 1], e);
    const te = Math.min(endTrim, e.len * 0.45);
    const v = SPEED[e.cls];
    const sx = a.x + d.x * ts + r.x * e.lane, sz = a.z + d.z * ts + r.z * e.lane;
    const ex = b.x - d.x * te + r.x * e.lane, ez = b.z - d.z * te + r.z * e.lane;

    if (prevEnd) {
      // connect the previous lane end to this lane start through node route[i]
      const node = g.nodes[route[i]];
      const i0 = pts.length - 1;
      const pd = prevEnd.d;
      const turnV = Math.min(prevEnd.v, v, node.ring ? 7 : 6);
      if (node.ring) {
        // anticlockwise seen from above (+y): decreasing angle in the x–z plane keeps the island on the left
        const a0 = Math.atan2(prevEnd.z - node.z, prevEnd.x - node.x);
        const a1 = Math.atan2(sz - node.z, sx - node.x);
        const r0 = Math.hypot(prevEnd.x - node.x, prevEnd.z - node.z), r1 = Math.hypot(sx - node.x, sz - node.z);
        let sweep = a0 - a1;
        while (sweep <= 0.2) sweep += Math.PI * 2;
        const steps = Math.max(6, Math.ceil(sweep / 0.2));
        for (let k = 1; k < steps; k++) {
          const t = k / steps, ang = a0 - sweep * t, rr = r0 + (r1 - r0) * t;
          push(node.x + Math.cos(ang) * rr, node.z + Math.sin(ang) * rr, turnV);
        }
      } else if (pd.x * d.x + pd.z * d.z < -0.95) {
        // U-turn (a dock at a dead end, or turning back after a stop): a loop ahead of the stop point
        const k = Math.hypot(sx - prevEnd.x, sz - prevEnd.z) * 0.75 + 1;
        for (let s = 1; s < 10; s++) {
          const t = s / 10, u = 1 - t;
          const x = u * u * u * prevEnd.x + 3 * u * u * t * (prevEnd.x + pd.x * k) + 3 * u * t * t * (sx + pd.x * k) + t * t * t * sx;
          const z = u * u * u * prevEnd.z + 3 * u * u * t * (prevEnd.z + pd.z * k) + 3 * u * t * t * (sz + pd.z * k) + t * t * t * sz;
          push(x, z, 3);
        }
      } else if (Math.abs(pd.x * d.z - pd.z * d.x) > 0.05) {
        // a turn: quadratic curve with its control point where the two lane lines meet
        const den = pd.x * d.z - pd.z * d.x;
        const t = ((sx - prevEnd.x) * d.z - (sz - prevEnd.z) * d.x) / den;
        const cx = prevEnd.x + pd.x * t, cz = prevEnd.z + pd.z * t;
        for (let s = 1; s < 8; s++) {
          const q = s / 8, u = 1 - q;
          push(u * u * prevEnd.x + 2 * u * q * cx + q * q * sx, u * u * prevEnd.z + 2 * u * q * cz + q * q * sz, turnV);
        }
      }
      if (g.degree(route[i]) >= 3 || node.ring) junc.push({ node: route[i], i0, i1: pts.length });
    }
    push(sx, sz, v);
    // a named stop along the way (not the first or last node): the vehicle halts at the end of the incoming lane
    push(ex, ez, v);
    if (!isLast && g.nodes[route[i + 1]].dest) stopIdx.push([i + 1, pts.length - 1]);
    prevEnd = { x: ex, z: ez, d, v };
  }
  const path = new LanePath(pts);
  for (const [ri, pi] of stopIdx) path.stops.set(ri, path.s[pi]);
  for (const j of junc) path.junctions.push({ node: j.node, enter: path.s[Math.max(0, j.i0)], exit: path.s[Math.min(pts.length - 1, j.i1)] });
  return path;
}
