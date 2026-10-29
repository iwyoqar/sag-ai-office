// Semantic retrieval: one embedding per chunk (stored in SQLite), cosine similarity over the chunks the caller may
// see, fused with BM25 by reciprocal-rank fusion. Any embedding failure degrades to plain full-text search.
import type { Ctx } from "../domain/context.js";
import { now } from "../db/db.js";
import type { LlmClient } from "../llm/types.js";
import { searchKnowledge, type KnowledgeHit } from "./service.js";

export interface Embedder {
  model: string;
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}

export function embedderOf(client: LlmClient | null | undefined): Embedder | null {
  if (!client?.embed || !client.embeddingModel) return null;
  return { model: client.embeddingModel, embed: (t, k) => client.embed!(t, k) };
}

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
// copy: SQLite blobs are not guaranteed to be 4-byte aligned
const fromBlob = (b: Uint8Array) => new Float32Array(b.slice().buffer);

function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}

const running = new WeakMap<object, Promise<number>>();

/**
 * Embeds active chunks that have no vector for the current model yet. Safe to call often: concurrent calls
 * share one run, and it only touches missing chunks. Returns how many chunks were embedded.
 */
export function embedPending(ctx: Ctx, embedder: Embedder, opts: { batch?: number; max?: number } = {}): Promise<number> {
  const busy = running.get(ctx.db);
  if (busy) return busy;
  const run = (async () => {
    let done = 0;
    const max = opts.max ?? 5000;
    while (done < max) {
      const rows = ctx.db.all<{ id: string; content: string; title: string }>(
        `SELECT c.id, c.content, d.title FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
         LEFT JOIN knowledge_embeddings e ON e.chunk_id = c.id AND e.model = ?
         WHERE d.is_active = 1 AND e.chunk_id IS NULL ORDER BY d.updated_at, c.ord LIMIT ?`,
        embedder.model, opts.batch ?? 50,
      );
      if (!rows.length) break;
      const vecs = await embedder.embed(rows.map((r) => `${r.title}\n${r.content}`), "document");
      const t = now();
      ctx.db.tx(() => {
        rows.forEach((r, i) => {
          const v = vecs[i];
          if (!v) return;
          ctx.db.run(
            "INSERT OR REPLACE INTO knowledge_embeddings (chunk_id, model, dims, vector, created_at) VALUES (?,?,?,?,?)",
            r.id, embedder.model, v.length, toBlob(v), t,
          );
        });
      });
      done += rows.length;
    }
    return done;
  })().finally(() => running.delete(ctx.db));
  running.set(ctx.db, run);
  return run;
}

export function embeddingCoverage(ctx: Ctx, model: string) {
  return ctx.db.get<{ total: number; embedded: number }>(
    `SELECT COUNT(*) total, COUNT(e.chunk_id) embedded FROM knowledge_chunks c
     JOIN knowledge_documents d ON d.id = c.document_id AND d.is_active = 1
     LEFT JOIN knowledge_embeddings e ON e.chunk_id = c.id AND e.model = ?`,
    model,
  )!;
}

const queryCache = new Map<string, Float32Array>();

async function queryVector(embedder: Embedder, text: string, timeoutMs: number): Promise<Float32Array> {
  const key = `${embedder.model}\u0000${text}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("embedding timeout")), timeoutMs);
  });
  try {
    const [v] = await Promise.race([embedder.embed([text.slice(0, 2000)], "query"), timeout]);
    if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value!);
    queryCache.set(key, v);
    return v;
  } finally {
    clearTimeout(timer);
  }
}

export type SearchMode = "hybrid" | "fulltext";

/**
 * Hybrid retrieval with the same access rules as `searchKnowledge`: `departmentId` limits results to
 * company-wide documents + that department's documents; omit it for an unrestricted admin search.
 */
export async function retrieve(
  ctx: Ctx,
  embedder: Embedder | null,
  text: string,
  opts: { departmentId?: string | null; limit?: number; timeoutMs?: number; onError?: (e: unknown) => void } = {},
): Promise<{ hits: KnowledgeHit[]; mode: SearchMode }> {
  const limit = opts.limit ?? 6;
  const lexical = searchKnowledge(ctx, text, { departmentId: opts.departmentId, limit: limit * 3 });
  if (!embedder || !text.trim()) return { hits: lexical.slice(0, limit), mode: "fulltext" };
  let semantic: KnowledgeHit[];
  try {
    const q = await queryVector(embedder, text, opts.timeoutMs ?? 8000);
    const scope = opts.departmentId === undefined ? "" : "AND COALESCE(d.department_id, '') IN ('', ?)";
    const params: string[] = [embedder.model];
    if (opts.departmentId !== undefined) params.push(opts.departmentId ?? "");
    const rows = ctx.db.all<{ chunkId: string; documentId: string; title: string; content: string; vector: Uint8Array }>(
      `SELECT c.id chunkId, c.document_id documentId, d.title, c.content, e.vector
       FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.id = e.chunk_id
       JOIN knowledge_documents d ON d.id = c.document_id AND d.is_active = 1
       WHERE e.model = ? ${scope}`,
      ...params,
    );
    semantic = rows
      .map(({ vector, ...r }) => ({ ...r, score: dot(q, fromBlob(vector)) }))
      .filter((r) => r.score > 0.5) // Gemini puts unrelated text around 0.5–0.6; RRF ranks the rest
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 3);
  } catch (e) {
    opts.onError?.(e);
    return { hits: lexical.slice(0, limit), mode: "fulltext" };
  }
  // Reciprocal-rank fusion (k = 60): robust to the two scores living on different scales.
  const fused = new Map<string, KnowledgeHit>();
  for (const list of [lexical, semantic])
    list.forEach((h, rank) => {
      const prev = fused.get(h.chunkId);
      const add = 1 / (60 + rank + 1);
      fused.set(h.chunkId, prev ? { ...prev, score: prev.score + add } : { ...h, score: add });
    });
  return { hits: [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit), mode: "hybrid" };
}
