// A business unit's own knowledge base, on the existing Brain/RAG pipeline (extract → chunk → FTS + embeddings).
// Reading needs the "knowledge" data class in the unit (members, HQ group level for SAG-owned branches, or an
// agreement for anyone else); adding and removing documents is for the unit's director and managers only.
// Retrieval is bounded in SQL by knowledge/scope.ts — see there for what each kind of unit can read.
import { now } from "../db/db.js";
import type { AuthUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { ingestDocument, listDocuments, removeDocument, type KnowledgeDoc } from "../knowledge/service.js";
import { type Embedder, retrieve } from "../knowledge/semantic.js";
import type { Ctx } from "./context.js";
import { HQ_UNIT, can, unitAccess } from "./units.js";

function access(ctx: Ctx, u: AuthUser, unitId: string, write: boolean) {
  if (unitId === HQ_UNIT) throw notFound("Biznes bo'lim"); // HQ's documents live in The Brain (/api/knowledge)
  const a = unitAccess(ctx, u, unitId);
  if (!can(a, "knowledge", "DETAIL")) throw forbidden("Bu bo'lim hujjatlarini ko'rish uchun ruxsat yo'q");
  if (write && a.memberRole !== "unit_director" && a.memberRole !== "unit_manager") throw forbidden();
  return a;
}

export function listUnitDocuments(ctx: Ctx, u: AuthUser, unitId: string): KnowledgeDoc[] {
  access(ctx, u, unitId, false);
  return listDocuments(ctx, undefined, unitId);
}

export async function addUnitDocument(
  ctx: Ctx, u: AuthUser, unitId: string, f: { title?: string; filename: string; mime?: string; data: Uint8Array; sourceLabel?: string },
) {
  access(ctx, u, unitId, true);
  return ingestDocument(ctx, { ...f, departmentId: null, unitId, visibility: "UNIT", sourceLabel: f.sourceLabel ?? "upload" }, { type: "user", id: u.id });
}

export function removeUnitDocument(ctx: Ctx, u: AuthUser, unitId: string, documentId: string) {
  access(ctx, u, unitId, true);
  removeDocument(ctx, documentId, { type: "user", id: u.id }, unitId); // 404 for documents of other namespaces
}

export function searchUnitKnowledge(ctx: Ctx, embedder: Embedder | null, u: AuthUser, unitId: string, q: string) {
  access(ctx, u, unitId, false);
  return retrieve(ctx, embedder, q, { unitId, limit: 10 });
}

/** HQ decides which of its own documents SAG-owned branches may read (franchise units never receive them). */
export function setHqDocumentVisibility(ctx: Ctx, u: AuthUser, documentId: string, visibility: "UNIT" | "BRANCHES") {
  if (!u.permissions.includes("brain:manage") || u.homeUnitId !== HQ_UNIT) throw forbidden();
  const d = ctx.db.get<{ id: string; department_id: string | null }>(
    "SELECT id, department_id FROM knowledge_documents WHERE id = ? AND is_active = 1 AND business_unit_id = 'hq'", documentId,
  );
  if (!d) throw notFound("Hujjat");
  if (visibility === "BRANCHES" && d.department_id) throw badRequest("Faqat kompaniya darajasidagi hujjatni filiallar bilan ulashish mumkin");
  ctx.db.tx(() => {
    ctx.db.run("UPDATE knowledge_documents SET visibility = ?, updated_at = ? WHERE id = ?", visibility, now(), documentId);
    audit(ctx.db, { type: "user", id: u.id }, "knowledge.visibility", { type: "document", id: documentId }, { unitId: HQ_UNIT, visibility });
  });
  return listDocuments(ctx).find((x) => x.id === documentId)!;
}
