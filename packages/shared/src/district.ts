// Store district layout and the world placement grid, shared by the 3D world (web) and the server (which validates
// placements), so both always agree on where a store stands and which land is free.
//
// Layout: stores stand side by side in rows; every store front faces the street below its row and every loading yard
// the street above it, so one street is both the shop frontage of one row and the delivery lane of the next. Regions
// are blocks within a row, separated by cross streets. Units WITHOUT a stored placement are packed automatically;
// units WITH one (created on the map, see `placement`) keep their own grid slot, as a single-store block with streets
// on both sides. Only visual coordinates live here; unit ids, regions and ownership are never changed by it.
import type { UnitCardDto, UnitPlacement } from "./dto.js";

export interface DistrictConfig {
  /** store lot cell (one Home Design store and its lot: forecourt, parking, loading yard) */
  cellW: number;
  cellD: number;
  /** sidewalk round each block */
  sidewalk: number;
  /** street width (kerb to kerb) */
  street: number;
  /** stores per row before a new row starts */
  maxRowCells: number;
  /** outer-left x and top z of the street grid */
  left: number;
  top: number;
  /** placement land ends here: the inner kerb of the corporate perimeter ring road (centre x 560 / z 440, 16 m wide)
   *  less its 4 m sidewalk; the web test checks this against the ring in scene/perimeter/layout.ts */
  limitX: number;
  limitZ: number;
}

export const DISTRICT_CONFIG: DistrictConfig = {
  cellW: 38, cellD: 34, sidewalk: 3, street: 12, maxRowCells: 6, left: -60, top: 92, limitX: 548, limitZ: 428,
};

export interface PlannedStore { unit: UnitCardDto; cx: number; cz: number; row: number }
export interface PlannedBlock { region: string; label: boolean; x0: number; x1: number; z0: number; z1: number; row: number; placed: boolean }
/** street centre lines: horizontal (constant z) and vertical (constant x) */
export interface StreetLine { at: number; from: number; to: number }

export interface DistrictPlan {
  stores: PlannedStore[];
  blocks: PlannedBlock[];
  hStreets: StreetLine[];
  vStreets: (StreetLine & { row: number })[];
  /** street centre z above each row (the row's delivery lane) */
  rearStreetZ: number[];
  bounds: { x0: number; x1: number; z0: number; z1: number };
  cfg: DistrictConfig;
}

// ---- grid ---------------------------------------------------------------------------------------------------------
// A placement slot is one store lot plus its sidewalk ring (a single-store block) and half a cross street on each
// side: slots tile the land in x every blockW + street, and rows share the district's row pitch, so a placed store
// lines up with the existing rows and their streets.

const blockW = (c: DistrictConfig) => c.cellW + 2 * c.sidewalk;
const blockD = (c: DistrictConfig) => c.cellD + 2 * c.sidewalk;
export const slotPitchX = (c: DistrictConfig = DISTRICT_CONFIG) => blockW(c) + c.street;
export const rowPitch = (c: DistrictConfig = DISTRICT_CONFIG) => blockD(c) + c.street;
/** centre z of the street above row k */
export const streetZ = (k: number, c: DistrictConfig = DISTRICT_CONFIG) => c.top + c.street / 2 + k * rowPitch(c);

/** The block (lot + sidewalk) of slot (gridX, gridZ), and the store lot centre in it. */
export function slotRect(gridX: number, gridZ: number, c: DistrictConfig = DISTRICT_CONFIG) {
  const x0 = c.left + c.street + gridX * slotPitchX(c);
  const z0 = streetZ(gridZ, c) + c.street / 2;
  return { x0, x1: x0 + blockW(c), z0, z1: z0 + blockD(c), cx: x0 + c.sidewalk + c.cellW / 2, cz: z0 + c.sidewalk + c.cellD / 2 };
}

/** Grid slot under a world point (x, z), or null outside the grid's origin quadrant. */
export function slotAt(x: number, z: number, c: DistrictConfig = DISTRICT_CONFIG): { gridX: number; gridZ: number } | null {
  const gx = Math.floor((x - (c.left + c.street / 2)) / slotPitchX(c));
  const gz = Math.floor((z - (c.top + c.street / 2)) / rowPitch(c));
  return gx >= 0 && gz >= 0 ? { gridX: gx, gridZ: gz } : null;
}

/** The world placement stored for a unit created in slot (gridX, gridZ): lot centre, front facing +z. */
export function placementFor(gridX: number, gridZ: number, c: DistrictConfig = DISTRICT_CONFIG): UnitPlacement {
  const r = slotRect(gridX, gridZ, c);
  return { x: r.cx, z: r.cz, rotation: 0, gridX, gridZ };
}

export type SlotStatus = "free" | "occupied" | "outside";

/**
 * Whether a new store may stand in slot (gridX, gridZ) of the current plan:
 * - "outside": not on the district land (before the first street, or past the perimeter ring);
 * - "occupied": the store's block or the cross streets it needs would overlap an existing block, or its block would
 *   sit on an existing cross street (streets, lots, trees and buildings all live inside blocks or on streets);
 * - "free" otherwise. Free slots always touch the street grid, so the road network reaches them.
 */
export function slotStatus(plan: DistrictPlan, gridX: number, gridZ: number): SlotStatus {
  const c = plan.cfg;
  if (!Number.isInteger(gridX) || !Number.isInteger(gridZ) || gridX < 0 || gridZ < 0) return "outside";
  const r = slotRect(gridX, gridZ, c);
  if (r.x1 + c.street > c.limitX || r.z1 + c.street > c.limitZ) return "outside";
  const half = c.street / 2;
  const hits = (a: { x0: number; x1: number; z0: number; z1: number }, b: { x0: number; x1: number; z0: number; z1: number }) =>
    a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.z0 < b.z1 - 0.01 && b.z0 < a.z1 - 0.01;
  // the block plus a full street width on each side (its own cross streets) must be clear of other blocks
  const withStreets = { x0: r.x0 - c.street, x1: r.x1 + c.street, z0: r.z0, z1: r.z1 };
  if (plan.blocks.some((b) => hits(withStreets, b))) return "occupied";
  // the block must not sit on a cross street of that row (shared street lines at its edges are fine)
  for (const v of plan.vStreets) {
    if (v.row !== gridZ) continue;
    if (hits({ x0: v.at - half, x1: v.at + half, z0: r.z0, z1: r.z1 }, r)) return "occupied";
  }
  return "free";
}

// ---- layout ---------------------------------------------------------------------------------------------------------

export function planDistrict(regions: { name: string; units: UnitCardDto[] }[], cfg = DISTRICT_CONFIG): DistrictPlan {
  const { cellW, cellD, sidewalk, street, maxRowCells } = cfg;
  const bD = blockD(cfg);
  const hz = (k: number) => streetZ(k, cfg);

  // 1. pack the units without a placement into rows (a region larger than a row continues in the next one)
  const rows: { region: string; units: UnitCardDto[]; label: boolean }[][] = [[]];
  let used = 0;
  for (const r of regions) {
    let rest = r.units.filter((u) => !u.placement), first = true;
    while (rest.length) {
      const room = maxRowCells - used;
      if (room <= 0 || (rest.length <= maxRowCells && rest.length > room && used > 0)) {
        rows.push([]);
        used = 0;
        continue;
      }
      const take = rest.slice(0, Math.min(rest.length, maxRowCells - used));
      rows[rows.length - 1].push({ region: r.name, units: take, label: first });
      used += take.length;
      rest = rest.slice(take.length);
      first = false;
    }
  }
  if (!rows[rows.length - 1].length) rows.pop();

  // 2. place the packed blocks and their stores
  const stores: PlannedStore[] = [];
  const blocks: PlannedBlock[] = [];
  const vStreets: (StreetLine & { row: number })[] = [];
  const addV = (at: number, row: number) => {
    if (!vStreets.some((v) => v.row === row && Math.abs(v.at - at) < 0.5)) vStreets.push({ at, from: hz(row), to: hz(row + 1), row });
  };
  rows.forEach((row, k) => {
    let x = cfg.left + street;
    const z0 = hz(k) + street / 2;
    for (const b of row) {
      const w = b.units.length * cellW + 2 * sidewalk;
      blocks.push({ region: b.region, label: b.label, x0: x, x1: x + w, z0, z1: z0 + bD, row: k, placed: false });
      b.units.forEach((u, i) => stores.push({ unit: u, cx: x + sidewalk + cellW / 2 + i * cellW, cz: z0 + sidewalk + cellD / 2, row: k }));
      x += w;
      // a cross street after every block: between regions, and at the row's right-hand end
      addV(x + street / 2, k);
      x += street;
    }
  });

  // 3. stores placed on the map keep their own slot: a single-store block with a cross street on each side
  for (const r of regions)
    for (const u of r.units) {
      const p = u.placement;
      if (!p) continue;
      const k = p.gridZ;
      const x0 = p.x - cellW / 2 - sidewalk, z0 = p.z - cellD / 2 - sidewalk;
      blocks.push({ region: r.name, label: false, x0, x1: x0 + blockW(cfg), z0, z1: z0 + bD, row: k, placed: true });
      stores.push({ unit: u, cx: p.x, cz: p.z, row: k });
      addV(x0 - street / 2, k);
      addV(x0 + blockW(cfg) + street / 2, k);
    }

  // 4. streets: one above every row and one below the last, each reaching the further right end of its two rows
  const nRows = Math.max(0, ...blocks.map((b) => b.row + 1));
  const rowEnd: number[] = [];
  for (const v of vStreets) rowEnd[v.row] = Math.max(rowEnd[v.row] ?? -Infinity, v.at);
  const leftX = cfg.left + street / 2;
  const hStreets: StreetLine[] = [];
  for (let k = 0; k <= nRows; k++) {
    const right = Math.max(rowEnd[k - 1] ?? -Infinity, rowEnd[k] ?? -Infinity);
    if (right > leftX) hStreets.push({ at: hz(k), from: leftX, to: right });
  }
  if (nRows) vStreets.unshift({ at: leftX, from: hz(0), to: hz(nRows), row: -1 });

  const x1 = Math.max(cfg.left + street, ...rowEnd.filter((v) => v !== undefined)) + street / 2;
  return {
    stores, blocks, hStreets, vStreets, cfg,
    rearStreetZ: Array.from({ length: nRows }, (_, k) => hz(k)),
    bounds: { x0: cfg.left, x1, z0: cfg.top, z1: hz(nRows) + street / 2 },
  };
}
