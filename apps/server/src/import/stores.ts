// Import of the Home Design store network from the owner's workbook (Книга1.xlsx, sheet Лист1).
// Layout found in the workbook: a region header row ("<Region> Sag Magazin", column A only), followed by its stores
// (store name in column A, ownership marker in one of the other columns: "hd" = SAG-owned, "f" = franchise).
// Nothing else is in the file: no addresses, coordinates, phones or directors — and nothing is invented here.
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { basename } from "node:path";
import type { BusinessType, OwnershipModel } from "@sag/shared";
import { now } from "../db/db.js";
import { audit, SYSTEM } from "../lib/audit.js";
import { slug, uid } from "../lib/ids.js";
import type { Ctx } from "../domain/context.js";
import { GROUP_NODE, provisionStoreUnit } from "../domain/units.js";
import { readFirstSheet } from "./xlsx.js";

const REGION_SUFFIX = / Sag Magazin$/i;

export interface ParsedStore {
  row: number;
  name: string;
  marker: "HD" | "F";
  regionCode: string;
}

export interface ParsedRegion {
  row: number;
  code: string;
  /** region text as written in the workbook, without the " Sag Magazin" suffix */
  name: string;
  /** full original header text */
  label: string;
  stores: ParsedStore[];
}

export interface ParsedWorkbook {
  sheetName: string;
  regions: ParsedRegion[];
  stores: ParsedStore[];
}

export const CLASSIFICATION: Record<"HD" | "F", { businessType: BusinessType; ownershipModel: OwnershipModel }> = {
  HD: { businessType: "SAG_BRANCH", ownershipModel: "SAG_OWNED" },
  F: { businessType: "INDEPENDENT_DEALER", ownershipModel: "FRANCHISE" },
};

/** Parses and validates the workbook. Throws with the row number on anything it cannot classify. */
export function parseStoreWorkbook(data: Uint8Array): ParsedWorkbook {
  const { sheetName, rows } = readFirstSheet(data);
  const regions: ParsedRegion[] = [];
  const errors: string[] = [];
  for (const r of rows) {
    const name = r.cells.A;
    const others = Object.entries(r.cells).filter(([col]) => col !== "A");
    if (!name) {
      errors.push(`row ${r.row}: value without a name in column A`);
      continue;
    }
    if (!others.length) {
      if (!REGION_SUFFIX.test(name)) {
        errors.push(`row ${r.row}: "${name}" has no HD/F marker and is not a region header`);
        continue;
      }
      const region = name.replace(REGION_SUFFIX, "").trim();
      const code = slug(region);
      if (regions.some((x) => x.code === code)) errors.push(`row ${r.row}: region "${region}" appears twice`);
      regions.push({ row: r.row, code, name: region, label: name, stores: [] });
      continue;
    }
    if (others.length > 1) {
      errors.push(`row ${r.row}: "${name}" has more than one marker (${others.map(([c, v]) => `${c}=${v}`).join(", ")})`);
      continue;
    }
    const marker = others[0][1].toUpperCase();
    if (marker !== "HD" && marker !== "F") {
      errors.push(`row ${r.row}: "${name}" has unknown marker "${others[0][1]}" (expected hd or f)`);
      continue;
    }
    const region = regions.at(-1);
    if (!region) {
      errors.push(`row ${r.row}: store "${name}" before any region header`);
      continue;
    }
    if (region.stores.some((s) => normalize(s.name) === normalize(name))) {
      errors.push(`row ${r.row}: store "${name}" appears twice in ${region.name}`);
      continue;
    }
    region.stores.push({ row: r.row, name, marker, regionCode: region.code });
  }
  for (const r of regions) if (!r.stores.length) errors.push(`row ${r.row}: region "${r.name}" has no stores`);
  if (errors.length) throw new Error(`Workbook rejected:\n- ${errors.join("\n- ")}`);
  return { sheetName, regions, stores: regions.flatMap((r) => r.stores) };
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export const provisionKeyOf = (s: ParsedStore) => `home-design:${s.regionCode}:${normalize(s.name)}`;

export interface ImportSummary {
  apply: boolean;
  sourceFile: string;
  sha256: string;
  batchId: string | null;
  totals: { stores: number; hd: number; f: number; regions: number };
  regionsCreated: string[];
  unitsCreated: number;
  unitsUnchanged: number;
  directorsCreated: number;
  aiDirectorsCreated: number;
  byRegion: { region: string; code: string; stores: number; hd: number; f: number }[];
}

/**
 * Imports every store as a business unit (idempotent: provision keys). apply=false is a dry run that writes nothing.
 * One transaction: either the whole workbook is imported or nothing is.
 */
export function importStores(ctx: Ctx, data: Uint8Array, sourcePath: string, apply: boolean): ImportSummary {
  const wb = parseStoreWorkbook(data);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const summary: ImportSummary = {
    apply, sourceFile: basename(sourcePath), sha256, batchId: null,
    totals: {
      stores: wb.stores.length, hd: wb.stores.filter((s) => s.marker === "HD").length,
      f: wb.stores.filter((s) => s.marker === "F").length, regions: wb.regions.length,
    },
    regionsCreated: [], unitsCreated: 0, unitsUnchanged: 0, directorsCreated: 0, aiDirectorsCreated: 0,
    byRegion: wb.regions.map((r) => ({
      region: r.name, code: r.code, stores: r.stores.length,
      hd: r.stores.filter((s) => s.marker === "HD").length, f: r.stores.filter((s) => s.marker === "F").length,
    })),
  };

  if (!apply) {
    for (const r of wb.regions) if (!ctx.db.get("SELECT 1 FROM org_nodes WHERE id = ?", r.code)) summary.regionsCreated.push(r.code);
    for (const s of wb.stores) {
      if (ctx.db.get("SELECT 1 FROM org_nodes WHERE provision_key = ?", provisionKeyOf(s))) summary.unitsUnchanged++;
      else { summary.unitsCreated++; summary.directorsCreated++; summary.aiDirectorsCreated++; }
    }
    return summary;
  }

  return ctx.db.tx(() => {
    const batchId = uid("imp");
    const t = now();
    ctx.db.run(
      "INSERT INTO store_import_batches (id, source_file, source_sha256, imported_by, imported_at) VALUES (?,?,?,?,?)",
      batchId, summary.sourceFile, sha256, safeUser(), t,
    );
    summary.batchId = batchId;
    for (const r of wb.regions) {
      const existing = ctx.db.get<{ level: string; source_label: string | null }>("SELECT level, source_label FROM org_nodes WHERE id = ?", r.code);
      if (!existing) {
        ctx.db.run(
          `INSERT INTO org_nodes (id, level, parent_id, path, name, code, source_label, import_batch_id, created_at, updated_at)
           VALUES (?, 'REGION', ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.code, GROUP_NODE, `/${GROUP_NODE}/${r.code}/`, r.name, r.code, r.label, batchId, t, t,
        );
        summary.regionsCreated.push(r.code);
      } else if (existing.level !== "REGION") {
        throw new Error(`Node "${r.code}" exists but is not a region`);
      } else if (!existing.source_label) {
        ctx.db.run("UPDATE org_nodes SET source_label = ?, updated_at = ? WHERE id = ?", r.label, t, r.code);
      }
    }
    for (const s of wb.stores) {
      const res = provisionStoreUnit(ctx, {
        provisionKey: provisionKeyOf(s), regionId: s.regionCode, name: s.name, sourceLabel: s.name,
        ...CLASSIFICATION[s.marker], sourceBrand: "HOME_DESIGN", sourceMarker: s.marker, importBatchId: batchId,
      });
      if (res.created) summary.unitsCreated++;
      else summary.unitsUnchanged++;
      if (res.directorCreated) summary.directorsCreated++;
      if (res.aiDirectorCreated) summary.aiDirectorsCreated++;
    }
    const { batchId: _b, ...recorded } = summary;
    ctx.db.run("UPDATE store_import_batches SET summary = ? WHERE id = ?", JSON.stringify(recorded), batchId);
    audit(ctx.db, SYSTEM, "stores.import", { type: "import", id: batchId }, {
      file: summary.sourceFile, sha256, created: summary.unitsCreated, unchanged: summary.unitsUnchanged,
    });
    return summary;
  });
}

function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}
