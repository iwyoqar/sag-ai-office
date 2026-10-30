// Which documents a business unit's knowledge namespace may read. Applied in SQL by every list and search
// (lexical and semantic), so retrieval for an agent or a person can never return another unit's document.
//   - every unit reads its own documents;
//   - SAG-owned branches (SAG_BRANCH) also read HQ documents HQ marked as shared with branches (visibility BRANCHES);
//   - franchise and other units read only their own — nothing is shared to or from them by default.
import type { Ctx } from "../domain/context.js";

export const HQ = "hq";

/** SQL predicate over documents alias `d`, plus params. */
export function unitDocScope(ctx: Ctx, unitId: string, alias = "d"): { sql: string; params: string[] } {
  if (unitId === HQ) return { sql: `${alias}.business_unit_id = 'hq'`, params: [] };
  const type = ctx.db.get<{ business_type: string | null }>("SELECT business_type FROM org_nodes WHERE id = ? AND level = 'UNIT'", unitId)?.business_type;
  if (!type) return { sql: "0", params: [] }; // unknown unit: nothing
  if (type === "SAG_BRANCH")
    return { sql: `(${alias}.business_unit_id = ? OR (${alias}.business_unit_id = 'hq' AND ${alias}.visibility = 'BRANCHES'))`, params: [unitId] };
  return { sql: `${alias}.business_unit_id = ?`, params: [unitId] };
}
