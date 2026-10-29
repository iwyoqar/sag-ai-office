// The Brain — knowledge base: ingest (versioned), full-text retrieval with access control, removal.
import { createHash } from "node:crypto";
import type { Db } from "../db/db.js";
import { now } from "../db/db.js";
import type { Ctx } from "../domain/context.js";
import { type Actor, audit } from "../lib/audit.js";
import { notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { chunkText, extractText } from "./extract.js";

export interface KnowledgeDoc {
  id: string; title: string; filename: string | null; mime: string | null; sizeBytes: number | null;
  departmentId: string | null; status: string; error: string | null; version: number; textChars: number;
  chunks: number; createdAt: string; updatedAt: string;
}

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
}

const NO_DEPT = "";

export function listDocuments({ db }: Ctx, departmentId?: string | null): KnowledgeDoc[] {
  const where = ["d.is_active = 1"];
  const p: string[] = [];
  if (departmentId !== undefined) {
    if (departmentId === null) where.push("d.department_id IS NULL");
    else { where.push("d.department_id = ?"); p.push(departmentId); }
  }
  return db.all<KnowledgeDoc>(
    `SELECT d.id, d.title, d.filename, d.mime, d.size_bytes sizeBytes, d.department_id departmentId, d.status, d.error,
            d.version, d.text_chars textChars, (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.document_id = d.id) chunks,
            d.created_at createdAt, d.updated_at updatedAt
     FROM knowledge_documents d WHERE ${where.join(" AND ")} ORDER BY d.updated_at DESC`,
    ...p,
  );
}

function sourceId(db: Db): string {
  const s = db.get<{ id: string }>("SELECT id FROM knowledge_sources WHERE kind = 'upload' LIMIT 1");
  if (s) return s.id;
  const id = uid("src");
  db.run("INSERT INTO knowledge_sources (id, name, kind, created_at) VALUES (?, 'Yuklangan hujjatlar', 'upload', ?)", id, now());
  return id;
}

function unindex(db: Db, documentId: string) {
  db.run("DELETE FROM knowledge_fts WHERE document_id = ?", documentId);
}

/**
 * Upload → extract → chunk → index. Re-uploading identical bytes is a no-op; uploading a document with the same
 * title (same scope) creates a new version and retires the old one from search, keeping it for history.
 */
export async function ingestDocument(
  ctx: Ctx,
  input: { title?: string; filename: string; mime?: string; data: Uint8Array; departmentId: string | null },
  actor: Actor,
): Promise<KnowledgeDoc & { duplicate?: boolean }> {
  const { db } = ctx;
  const sha = createHash("sha256").update(input.data).digest("hex");
  const title = (input.title?.trim() || input.filename.replace(/\.[^.]+$/, "")).slice(0, 200);
  const same = db.get<{ id: string }>(
    "SELECT id FROM knowledge_documents WHERE sha256 = ? AND is_active = 1 AND COALESCE(department_id, '') = ?", sha, input.departmentId ?? NO_DEPT,
  );
  if (same) return { ...listDocuments(ctx).find((d) => d.id === same.id)!, duplicate: true };

  // Throws a clear 400 for unsupported / spoofed / empty files before anything is stored.
  const { text } = await extractText(input.data, input.filename);
  const chunks = chunkText(text);
  const id = uid("doc");
  const t = now();
  db.tx(() => {
    const prev = db.get<{ id: string; version: number }>(
      "SELECT id, version FROM knowledge_documents WHERE title = ? AND is_active = 1 AND COALESCE(department_id, '') = ?",
      title, input.departmentId ?? NO_DEPT,
    );
    if (prev) {
      db.run("UPDATE knowledge_documents SET is_active = 0, updated_at = ? WHERE id = ?", t, prev.id);
      unindex(db, prev.id);
    }
    db.run(
      `INSERT INTO knowledge_documents (id, source_id, title, filename, mime, size_bytes, sha256, department_id, status, created_by, created_at, updated_at, version, is_active, text_chars)
       VALUES (?,?,?,?,?,?,?,?, 'indexed', ?,?,?,?,1,?)`,
      id, sourceId(db), title, input.filename, input.mime ?? null, input.data.length, sha, input.departmentId,
      actor.type === "user" ? actor.id : null, t, t, (prev?.version ?? 0) + 1, text.length,
    );
    chunks.forEach((c, i) => {
      const cid = uid("chk");
      db.run("INSERT INTO knowledge_chunks (id, document_id, ord, content, tokens) VALUES (?,?,?,?,?)", cid, id, i, c, Math.ceil(c.length / 4));
      db.run(
        "INSERT INTO knowledge_fts (content, title, chunk_id, document_id, department_id) VALUES (?,?,?,?,?)",
        c, title, cid, id, input.departmentId ?? NO_DEPT,
      );
    });
    audit(db, actor, "knowledge.ingest", { type: "document", id }, { title, filename: input.filename, chunks: chunks.length, replaced: prev?.id ?? null });
  });
  return listDocuments(ctx).find((d) => d.id === id)!;
}

export function removeDocument(ctx: Ctx, id: string, actor: Actor) {
  const d = ctx.db.get<{ id: string }>("SELECT id FROM knowledge_documents WHERE id = ? AND is_active = 1", id);
  if (!d) throw notFound("Hujjat");
  ctx.db.tx(() => {
    ctx.db.run("UPDATE knowledge_documents SET is_active = 0, updated_at = ? WHERE id = ?", now(), id);
    unindex(ctx.db, id);
    audit(ctx.db, actor, "knowledge.remove", { type: "document", id });
  });
}

/** Turn free text into a safe FTS5 query: quoted terms OR-ed together (no operators from user input). */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}ʻʼ'’-]{3,}/gu) ?? [])]
    .map((t) => t.replace(/["'’ʻʼ]/g, ""))
    .filter((t) => t.length >= 3)
    .slice(0, 24);
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

/**
 * BM25 search. `departmentId` limits results to company-wide documents + that department's documents
 * (agents only ever see what their department may see). Omit it for an unrestricted admin search.
 */
export function searchKnowledge(ctx: Ctx, text: string, opts: { departmentId?: string | null; limit?: number } = {}): KnowledgeHit[] {
  const q = ftsQuery(text);
  if (!q) return [];
  const scope = opts.departmentId === undefined ? "" : "AND (f.department_id = '' OR f.department_id = ?)";
  const params: (string | number)[] = [q];
  if (opts.departmentId !== undefined) params.push(opts.departmentId ?? NO_DEPT);
  params.push(opts.limit ?? 6);
  try {
    return ctx.db.all<KnowledgeHit>(
      `SELECT f.chunk_id chunkId, f.document_id documentId, f.title, f.content, bm25(knowledge_fts) score
       FROM knowledge_fts f WHERE knowledge_fts MATCH ? ${scope} ORDER BY score LIMIT ?`,
      ...params,
    );
  } catch {
    return [];
  }
}

export function knowledgeStatus({ db }: Ctx, embeddingModel?: string | null, lastError?: string | null) {
  const n = db.get<{ docs: number; chunks: number }>(
    "SELECT COUNT(*) docs, (SELECT COUNT(*) FROM knowledge_fts) chunks FROM knowledge_documents WHERE is_active = 1",
  )!;
  if (!embeddingModel)
    return {
      documents: n.docs, chunks: n.chunks, search: "fulltext" as const,
      semantic: { available: false, reason: "Embedding modeli sozlanmagan — matnli (BM25) qidiruv ishlaydi" },
    };
  const cov = db.get<{ embedded: number }>(
    `SELECT COUNT(e.chunk_id) embedded FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id AND d.is_active = 1
     JOIN knowledge_embeddings e ON e.chunk_id = c.id AND e.model = ?`, embeddingModel,
  )!;
  return {
    documents: n.docs, chunks: n.chunks, search: "hybrid" as const,
    semantic: {
      available: true, model: embeddingModel, embedded: cov.embedded, pending: Math.max(0, n.chunks - cov.embedded),
      ...(lastError ? { lastError } : {}),
    },
  };
}
