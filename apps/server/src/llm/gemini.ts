// Google Gemini via the official REST API (generativelanguage.googleapis.com, v1beta).
// No SDK dependency: one fetch per call, with timeout, retry/backoff, rate-limit handling and a request spacer
// so the free tier's requests-per-minute limit is respected.
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "./types.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

type FetchFn = typeof fetch;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** minimum gap between requests (free tier ≈ 10–15 RPM) */
  minIntervalMs?: number;
  /** embedding model for semantic search (e.g. gemini-embedding-001); empty disables embeddings */
  embeddingModel?: string;
  embeddingDims?: number;
  maxRetries?: number;
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] }; finishReason?: string;
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string }[] };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Longest in-process wait for a rate limit before giving up (per-minute limits reset well within this). */
export const MAX_RETRY_WAIT_MS = 90_000;
const formatWait = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} soat` : `${Math.ceil(ms / 60_000)} daqiqa`);

export class GeminiClient implements LlmClient {
  readonly provider = "gemini" as const;
  readonly mode = "live" as const;
  model: string;
  private nextSlot = 0;
  private nextEmbedSlot = 0;
  private readonly fetch: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private o: GeminiOptions) {
    this.model = o.model;
    this.fetch = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? defaultSleep;
  }

  /** Serialises call starts so bursts from parallel workers stay under the RPM limit. */
  private async waitTurn() {
    const gap = this.o.minIntervalMs ?? 4500;
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + gap;
    if (at > now) await this.sleep(at - now);
  }

  /** Embeddings have their own (much higher) rate limit, so they don't queue behind generation calls. */
  private async waitEmbedTurn() {
    const now = Date.now();
    const at = Math.max(now, this.nextEmbedSlot);
    this.nextEmbedSlot = at + 700;
    if (at > now) await this.sleep(at - now);
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({
        role: m.role,
        parts: m.toolCalls?.length
          ? m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))
          : m.toolResults?.length
            ? m.toolResults.map((r) => ({ functionResponse: { name: r.name, response: r.response } }))
            : [{ text: m.text }],
      })),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens ?? 4096,
        temperature: req.temperature ?? 0.6,
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
      ...(req.tools?.length
        ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }], toolConfig: { functionCallingConfig: { mode: "AUTO" } } }
        : {}),
    };
    const retries = this.o.maxRetries ?? 3;
    let lastErr: LlmError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (req.signal?.aborted) throw new LlmError("Bekor qilindi", "aborted", false);
      await this.waitTurn();
      try {
        return await this.once(body, req);
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), "server", true);
        lastErr = err;
        if (!err.retryable || attempt === retries) throw err;
        const backoff = err.retryAfterMs ?? Math.min(30_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 400);
        this.o.log?.("gemini retry", { attempt: attempt + 1, code: err.code, waitMs: backoff, correlationId: req.correlationId });
        // abortable: cancelling the task or its timeout must not wait out a back-off
        await Promise.race([this.sleep(Math.min(backoff, MAX_RETRY_WAIT_MS)), abortPromise(req.signal)]);
        if (req.signal?.aborted) throw new LlmError("Bekor qilindi", "aborted", false);
      }
    }
    throw lastErr ?? new LlmError("Noma'lum xato", "server", false);
  }

  private async once(body: unknown, req: LlmRequest): Promise<LlmResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), req.timeoutMs ?? 90_000);
    const onAbort = () => ctrl.abort(new Error("aborted"));
    req.signal?.addEventListener("abort", onAbort);
    let res: Response;
    try {
      res = await this.fetch(`${BASE}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.o.apiKey, "x-request-id": req.correlationId },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError("Bekor qilindi", "aborted", false);
      if (ctrl.signal.aborted) throw new LlmError("Gemini javob bermadi (timeout)", "timeout", true);
      throw new LlmError(`Tarmoq xatosi: ${(e as Error).message}`, "server", true);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }

    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) throw toError(res.status, data);

    if (data.promptFeedback?.blockReason)
      throw new LlmError(`So'rov Gemini tomonidan bloklandi: ${data.promptFeedback.blockReason}`, "blocked", false);
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
    const toolCalls = parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
    if (!text && !toolCalls.length) {
      const reason = cand?.finishReason ?? "EMPTY";
      throw new LlmError(`Gemini bo'sh javob qaytardi (${reason})`, reason === "SAFETY" ? "blocked" : "bad_response", reason !== "SAFETY");
    }
    const u = data.usageMetadata ?? {};
    return {
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      inputTokens: u.promptTokenCount ?? 0,
      // thinking tokens are billed as output
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      finishReason: cand?.finishReason ?? "STOP",
      model: data.modelVersion ?? this.model,
    };
  }

  /** Grounded web search: a separate call with the google_search tool (it cannot be mixed with functions). */
  async searchWeb(query: string, correlationId: string) {
    await this.waitTurn();
    const res = await this.fetch(`${BASE}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.o.apiKey, "x-request-id": correlationId },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Internetdan qidir va qisqa, faktlarga asoslangan xulosa ber (manbalar bilan): ${query}` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1200, temperature: 0.2 },
      }),
    }).catch((e) => {
      throw new LlmError(`Tarmoq xatosi: ${(e as Error).message}`, "server", true);
    });
    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) throw toError(res.status, data);
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
    const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => ({ title: c.web?.title ?? "", url: c.web?.uri ?? "" }))
      .filter((s) => s.url)
      .slice(0, 8);
    return { text, sources };
  }

  get embeddingModel() {
    return this.o.embeddingModel || undefined;
  }

  /** Batch embeddings (≤100 texts per request), normalised to unit length for cosine similarity. */
  async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    const model = this.o.embeddingModel;
    if (!model) throw new LlmError("Embedding modeli sozlanmagan", "config", false);
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      let attempt = 0;
      for (;;) {
        await this.waitEmbedTurn();
        const res = await this.fetch(`${BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.o.apiKey },
          body: JSON.stringify({
            requests: batch.map((t) => ({
              model: `models/${model}`, content: { parts: [{ text: t.slice(0, 8000) }] },
              taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
              outputDimensionality: this.o.embeddingDims ?? 768,
            })),
          }),
        }).catch((e) => {
          throw new LlmError(`Tarmoq xatosi: ${(e as Error).message}`, "server", true);
        });
        const data = (await res.json().catch(() => ({}))) as GeminiResponse & { embeddings?: { values: number[] }[] };
        if (res.ok && data.embeddings) {
          for (const e of data.embeddings) out.push(normalise(e.values));
          break;
        }
        const err = toError(res.status, data);
        if (!err.retryable || ++attempt > (this.o.maxRetries ?? 3)) throw err;
        await this.sleep(Math.min(err.retryAfterMs ?? 1500 * 2 ** attempt, MAX_RETRY_WAIT_MS));
      }
    }
    return out;
  }

  async health() {
    try {
      const res = await this.fetch(`${BASE}/models/${encodeURIComponent(this.model)}`, {
        headers: { "x-goog-api-key": this.o.apiKey },
      });
      if (res.ok) return { ok: true, model: this.model };
      const data = (await res.json().catch(() => ({}))) as GeminiResponse;
      return { ok: false, model: this.model, detail: toError(res.status, data).message };
    } catch (e) {
      return { ok: false, model: this.model, detail: `Tarmoq xatosi: ${(e as Error).message}` };
    }
  }
}

function abortPromise(signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (!signal) return;
    if (signal.aborted) return r();
    signal.addEventListener("abort", () => r(), { once: true });
  });
}

function normalise(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

function toError(status: number, data: GeminiResponse): LlmError {
  const msg = data.error?.message ?? `HTTP ${status}`;
  if (status === 400 && /API key/i.test(msg)) return new LlmError("Gemini API kaliti noto'g'ri", "auth", false);
  if (status === 401 || status === 403) return new LlmError(`Gemini ruxsat bermadi: ${msg}`, "auth", false);
  if (status === 404) return new LlmError(`Gemini modeli topilmadi: ${msg}`, "config", false);
  if (status === 429) {
    const delay = data.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    const ms = delay ? Math.ceil(parseFloat(delay) * 1000) : undefined;
    // A long retryDelay means a quota window (e.g. the free tier's daily limit), not a burst: waiting in-process
    // for hours would freeze the task. Fail clearly instead; the task can be retried later.
    if (ms !== undefined && ms > MAX_RETRY_WAIT_MS)
      return new LlmError(`Gemini limiti tugadi (429): taxminan ${formatWait(ms)} dan keyin qayta urinib ko'ring`, "rate_limit", false, ms);
    return new LlmError("Gemini limiti tugadi (429)", "rate_limit", true, ms);
  }
  if (status >= 500) return new LlmError(`Gemini server xatosi (${status})`, "server", true);
  return new LlmError(`Gemini xatosi: ${msg}`, "bad_response", false);
}
