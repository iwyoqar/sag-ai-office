// Corporate perimeter district: a ring road around the campus and the store-district land, and the SAG group's 11
// companies along its outer side, each with a headquarters tower (rooftop logo) and lower office buildings.
// Pure data + layout maths (no three.js), so the plan can be checked in tests. Same world frame as campus/layout.ts.
import { CAMPUS_BOUNDS, type Rect } from "../campus/layout";

export type Archetype =
  | "flagship" | "premium" | "commercial" | "terraced" | "agri" | "industrial"
  | "twin" | "sustainable" | "compact" | "healthcare" | "cantilever";

export interface Palette {
  /** curtain glass tint, window frames, spandrel / solid wall */
  glass: string; frame: string; wall: string;
  /** accent for fins, fascia bands and sign frames */
  accent: string;
}

export interface CompanySpec {
  id: string;
  name: string;
  /** logo asset key (see brands.ts) */
  logo: string;
  archetype: Archetype;
  /** headquarters tower floors (5–15) */
  floors: number;
  palette: Palette;
}

/** The owner's order. The first building carries the primary SAG logo. */
export const COMPANIES: CompanySpec[] = [
  { id: "sag", name: "SAG", logo: "sag", archetype: "flagship", floors: 15,
    palette: { glass: "#5f86c2", frame: "#26324a", wall: "#e9edf3", accent: "#1d44b8" } },
  { id: "sag-flooring", name: "SAG Flooring", logo: "sag-flooring", archetype: "premium", floors: 13,
    palette: { glass: "#5a6f8e", frame: "#2a2f38", wall: "#d9d4c8", accent: "#b9a27a" } },
  { id: "sag-home-design", name: "SAG Home Design", logo: "sag-home-design", archetype: "commercial", floors: 10,
    palette: { glass: "#6e8fb3", frame: "#3b3f45", wall: "#e3d6c2", accent: "#2147c9" } },
  { id: "sag-gardens", name: "SAG Gardens", logo: "sag-gardens", archetype: "terraced", floors: 8,
    palette: { glass: "#5e8f86", frame: "#40382f", wall: "#e8e0cf", accent: "#2f5a35" } },
  { id: "maroqand-klaster", name: "Maroqand Klaster", logo: "maroqand-klaster", archetype: "agri", floors: 7,
    palette: { glass: "#5b86a8", frame: "#33415a", wall: "#efe9d8", accent: "#3e9a43" } },
  { id: "turbo-plast", name: "Turbo Plast", logo: "turbo-plast", archetype: "industrial", floors: 6,
    palette: { glass: "#4a6276", frame: "#2b2e33", wall: "#8d939a", accent: "#b8222b" } },
  { id: "set", name: "SET", logo: "set", archetype: "twin", floors: 12,
    palette: { glass: "#4f6c88", frame: "#eef0f2", wall: "#dfe3e7", accent: "#24405a" } },
  { id: "jarkurgan-plastic-recycling", name: "Jarkurgan Plastic Recycling", logo: "jarkurgan-plastic-recycling", archetype: "sustainable", floors: 6,
    palette: { glass: "#5f8d7a", frame: "#5a4632", wall: "#c9a982", accent: "#3a9a3f" } },
  { id: "seal", name: "SEAL", logo: "seal", archetype: "compact", floors: 9,
    palette: { glass: "#3a5a8c", frame: "#1f2d52", wall: "#2c3a63", accent: "#c9ced8" } },
  { id: "bionur-med", name: "Bionur Med", logo: "bionur-med", archetype: "healthcare", floors: 8,
    palette: { glass: "#4f9c9a", frame: "#d9dee2", wall: "#f4f6f7", accent: "#3fb39a" } },
  { id: "casva", name: "Casva", logo: "casva", archetype: "cantilever", floors: 11,
    palette: { glass: "#556a82", frame: "#1b2433", wall: "#3a4250", accent: "#f08a24" } },
];

export const FLOOR_H = 3.6;
export const GROUND_H = 4.5;
export const heightOf = (floors: number) => GROUND_H + (floors - 1) * FLOOR_H;

/**
 * Ring road centre lines, round the campus (with its east service road, x 490) and the store district (planned from
 * x -60, z 92: six stores per row, 52 m per row; today's 23 stores take 4–6 rows depending on how regions pack, i.e.
 * up to z 416). The south side keeps clear of that.
 */
export const RING = {
  x0: CAMPUS_BOUNDS.x0 - 75, // -120
  x1: 560,
  z0: CAMPUS_BOUNDS.z0 - 70, // -205
  z1: 440,
};
export const ROAD_W = 16;
export const WALK_W = 4;
/** building frontage line, measured from the road centre line */
export const SETBACK = ROAD_W / 2 + WALK_W + 6;
/**
 * Business park on the free land inside the ring, east of the store district and south of the M37 (PerimeterDistrict
 * draws it; map placement keeps out of it, see DISTRICT_KEEP_OUT in @sag/shared).
 */
export const BUSINESS_PARK: Rect = { x0: 316, x1: RING.x1 - ROAD_W / 2 - WALK_W - 10, z0: 104, z1: RING.z1 - ROAD_W / 2 - WALK_W - 10 };
/** M37 corridor (road + both walks) where it crosses the west and east sides */
export const M37_GAP = { z0: 54, z1: 96 };
const CORNER = 14;
const GAP = 10;

export type SideId = "n" | "e" | "s" | "w";

export interface PlotSpec {
  company: string;
  /** the company's headquarters tower (carries the rooftop logo) */
  main: boolean;
  side: SideId;
  x0: number; x1: number; z0: number; z1: number;
  floors: number;
  seed: number;
}

interface Side { id: SideId; a: number; b: number }

/** Sides walked clockwise as seen from above (north = -z): north going east, east going south, and so on. */
function sides(): Side[] {
  const o = SETBACK;
  return [
    { id: "n", a: RING.x0 - o + CORNER, b: RING.x1 + o - CORNER },
    { id: "e", a: RING.z0 - o + CORNER, b: RING.z1 + o - CORNER },
    { id: "s", a: RING.x1 + o - CORNER, b: RING.x0 - o + CORNER }, // walked westwards
    { id: "w", a: RING.z1 + o - CORNER, b: RING.z0 - o + CORNER }, // walked northwards
  ];
}

const hash = (n: number) => {
  const x = Math.sin(n * 78.233 + 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** Footprint of a building of `width` along a side, centred at `t`, `depth` deep away from the ring. */
function footprint(side: SideId, t: number, width: number, depth: number): Rect {
  const o = SETBACK;
  const lo = t - width / 2, hi = t + width / 2;
  switch (side) {
    case "n": return { x0: lo, x1: hi, z0: RING.z0 - o - depth, z1: RING.z0 - o };
    case "s": return { x0: lo, x1: hi, z0: RING.z1 + o, z1: RING.z1 + o + depth };
    case "e": return { x0: RING.x1 + o, x1: RING.x1 + o + depth, z0: lo, z1: hi };
    case "w": return { x0: RING.x0 - o - depth, x1: RING.x0 - o, z0: lo, z1: hi };
  }
}

export const MAIN_WIDTH: Record<Archetype, number> = {
  flagship: 46, premium: 36, commercial: 44, terraced: 46, agri: 48, industrial: 50,
  twin: 48, sustainable: 46, compact: 30, healthcare: 50, cantilever: 42,
};
export const MAIN_DEPTH: Record<Archetype, number> = {
  flagship: 36, premium: 32, commercial: 30, terraced: 34, agri: 28, industrial: 30,
  twin: 26, sustainable: 30, compact: 30, healthcare: 28, cantilever: 30,
};

/**
 * The whole plan: every company gets an equal share of the ring's frontage, in the owner's order, starting on the
 * north side behind the head office. Its tower stands in the middle of its longest stretch; office buildings fill
 * the rest edge to edge (10 m gaps), so the ring reads as one continuous street front.
 */
export function perimeterPlan(): PlotSpec[] {
  const list = sides();
  // stretches of usable frontage, in path order (the M37 crossing cuts the east and west sides)
  const stretches: { side: SideId; a: number; b: number; dir: 1 | -1 }[] = [];
  let total = 0;
  for (const s of list) {
    const dir = s.b > s.a ? 1 : -1;
    const lo = Math.min(s.a, s.b), hi = Math.max(s.a, s.b);
    const parts: [number, number][] = s.id === "e" || s.id === "w"
      ? [[lo, M37_GAP.z0], [M37_GAP.z1, hi]]
      : [[lo, hi]];
    if (dir === -1) parts.reverse();
    for (const [p0, p1] of parts) {
      stretches.push({ side: s.id, a: dir === 1 ? p0 : p1, b: dir === 1 ? p1 : p0, dir });
      total += p1 - p0;
    }
  }
  const share = total / COMPANIES.length;
  const plots: PlotSpec[] = [];
  let seed = 1;
  COMPANIES.forEach((c, k) => {
    // this company's frontage pieces along the path
    const from = k * share, to = (k + 1) * share;
    const pieces: { side: SideId; lo: number; hi: number }[] = [];
    let acc = 0;
    for (const st of stretches) {
      const len = Math.abs(st.b - st.a);
      const s0 = Math.max(from, acc), s1 = Math.min(to, acc + len);
      if (s1 - s0 > 1) {
        const p = st.a + st.dir * (s0 - acc), q = st.a + st.dir * (s1 - acc);
        pieces.push({ side: st.side, lo: Math.min(p, q), hi: Math.max(p, q) });
      }
      acc += len;
    }
    // shares meet edge to edge: keep a gap between neighbouring companies
    pieces.forEach((p, i) => {
      if (i === 0 && k > 0) p.lo += GAP / 2;
      if (i === pieces.length - 1 && k < COMPANIES.length - 1) p.hi -= GAP / 2;
    });
    const longest = pieces.reduce((a, p) => (p.hi - p.lo > a.hi - a.lo ? p : a), pieces[0]);
    for (const p of pieces) {
      const segs: [number, number][] = [];
      if (p === longest) {
        // towers keep their long side along x on every side, so the rooftop logo always faces the camera (+z)
        const ew = p.side === "e" || p.side === "w";
        const w = ew ? MAIN_DEPTH[c.archetype] : MAIN_WIDTH[c.archetype], mid = (p.lo + p.hi) / 2;
        const depth = ew ? MAIN_WIDTH[c.archetype] : MAIN_DEPTH[c.archetype];
        plots.push({ company: c.id, main: true, side: p.side, ...footprint(p.side, mid, w, depth), floors: c.floors, seed: seed++ });
        segs.push([p.lo, mid - w / 2 - GAP], [mid + w / 2 + GAP, p.hi]);
      } else segs.push([p.lo, p.hi]);
      for (const [a, b] of segs) {
        const len = b - a;
        if (len < 18) continue; // a small green pocket instead
        const n = Math.max(1, Math.round((len + GAP) / (34 + GAP)));
        const w = (len - (n - 1) * GAP) / n;
        for (let i = 0; i < n; i++) {
          const t = a + w / 2 + i * (w + GAP);
          const depth = 22 + Math.round(hash(seed) * 3) * 3;
          plots.push({ company: c.id, main: false, side: p.side, ...footprint(p.side, t, w, depth), floors: 5 + Math.floor(hash(seed + 0.5) * 4), seed: seed++ });
        }
      }
    }
  });
  return plots;
}

/** Ring road asphalt, split so no two road surfaces overlap (corners belong to the north/south roads, the M37 to itself). */
export function ringRoads(): (Rect & { along: "x" | "z" })[] {
  const h = ROAD_W / 2;
  const nsX0 = RING.x0 - h, nsX1 = RING.x1 + h;
  const r: (Rect & { along: "x" | "z" })[] = [
    { x0: nsX0, x1: nsX1, z0: RING.z0 - h, z1: RING.z0 + h, along: "x" },
    { x0: nsX0, x1: nsX1, z0: RING.z1 - h, z1: RING.z1 + h, along: "x" },
  ];
  for (const x of [RING.x0, RING.x1]) {
    r.push({ x0: x - h, x1: x + h, z0: RING.z0 + h, z1: 66, along: "z" });
    r.push({ x0: x - h, x1: x + h, z0: 84, z1: RING.z1 - h, along: "z" });
  }
  return r;
}

/** Everything the perimeter occupies (roads, walks, buildings, rear lots): context houses stay outside it. */
export const PERIMETER_OUTER: Rect = {
  x0: RING.x0 - SETBACK - 110, x1: RING.x1 + SETBACK + 110,
  z0: RING.z0 - SETBACK - 110, z1: RING.z1 + SETBACK + 110,
};

/** x positions where the ring's west and east roads cross the M37 (site.ts keeps trees, lamps and walks off them). */
export const M37_CROSSINGS = [RING.x0, RING.x1];
