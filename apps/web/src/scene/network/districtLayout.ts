// Compact store district layout: stores stand side by side in rows, every store front faces the street below its
// row and every loading yard the street above it, so one street is both the shop frontage of one row and the delivery
// lane of the next. Regions are blocks within a row, separated by cross streets. Pure function of the region list:
// new stores are placed automatically, and the road graph is generated from the same plan (no hand-drawn roads).
// Only visual coordinates are computed here; unit ids, regions and ownership are untouched.
import type { UnitCardDto } from "@sag/shared";

export interface DistrictConfig {
  /** store lot cell (one store and its lot) */
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
}

export const DISTRICT_CONFIG: DistrictConfig = { cellW: 38, cellD: 34, sidewalk: 3, street: 12, maxRowCells: 6, left: -60, top: 92 };

export interface PlannedStore { unit: UnitCardDto; cx: number; cz: number; row: number }
export interface PlannedBlock { region: string; label: boolean; x0: number; x1: number; z0: number; z1: number; row: number }
/** street centre lines: horizontal (constant z) and vertical (constant x) */
export interface StreetLine { at: number; from: number; to: number }

export interface DistrictPlan {
  stores: PlannedStore[];
  blocks: PlannedBlock[];
  hStreets: StreetLine[];
  vStreets: StreetLine[];
  /** street centre z above each row (the row's delivery lane) */
  rearStreetZ: number[];
  bounds: { x0: number; x1: number; z0: number; z1: number };
  cfg: DistrictConfig;
}

export function planDistrict(regions: { name: string; units: UnitCardDto[] }[], cfg = DISTRICT_CONFIG): DistrictPlan {
  const { cellW, cellD, sidewalk, street, maxRowCells } = cfg;
  const blockD = cellD + 2 * sidewalk;
  // 1. pack regions into rows (a region larger than a row continues in the next one)
  const rows: { region: string; units: UnitCardDto[]; label: boolean }[][] = [[]];
  let used = 0;
  for (const r of regions) {
    let rest = r.units, first = true;
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

  // 2. place blocks and stores
  const stores: PlannedStore[] = [];
  const blocks: PlannedBlock[] = [];
  const hz = (k: number) => cfg.top + street / 2 + k * (blockD + street); // centre of the street above row k
  const leftX = cfg.left + street / 2;
  const rowEnd: number[] = [];
  const vStreets: StreetLine[] = [];
  rows.forEach((row, k) => {
    let x = cfg.left + street;
    const z0 = hz(k) + street / 2;
    row.forEach((b, j) => {
      const w = b.units.length * cellW + 2 * sidewalk;
      blocks.push({ region: b.region, label: b.label, x0: x, x1: x + w, z0, z1: z0 + blockD, row: k });
      b.units.forEach((u, i) => stores.push({ unit: u, cx: x + sidewalk + cellW / 2 + i * cellW, cz: z0 + sidewalk + cellD / 2, row: k }));
      x += w;
      // a cross street after every block: between regions, and at the row's right-hand end
      vStreets.push({ at: x + street / 2, from: hz(k), to: hz(k + 1) });
      x += street;
      if (j === row.length - 1) rowEnd[k] = x - street / 2;
    });
  });

  // 3. streets: one above every row and one below the last; each spans to the further right end of its two rows
  const hStreets: StreetLine[] = [];
  for (let k = 0; k <= rows.length; k++) {
    const right = Math.max(rowEnd[k - 1] ?? -Infinity, rowEnd[k] ?? -Infinity);
    hStreets.push({ at: hz(k), from: leftX, to: right });
  }
  vStreets.unshift({ at: leftX, from: hz(0), to: hz(rows.length) });

  const x1 = Math.max(...rowEnd) + street / 2;
  return {
    stores, blocks, hStreets, vStreets, cfg,
    rearStreetZ: rows.map((_, k) => hz(k)),
    bounds: { x0: cfg.left, x1, z0: cfg.top, z1: hz(rows.length) + street / 2 },
  };
}
