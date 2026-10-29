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
  maxRetries?: number;
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string }[] };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GeminiClient implements LlmClient {
  readonly provider = "gemini" as const;
  readonly mode = "live" as const;
  model: string;
  private nextSlot = 0;
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

  async generate(req: LlmRequest): Promise<LlmResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens ?? 4096,
        temperature: req.temperature ?? 0.6,
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
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
        await this.sleep(backoff);
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
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
    if (!text) {
      const reason = cand?.finishReason ?? "EMPTY";
      throw new LlmError(`Gemini bo'sh javob qaytardi (${reason})`, reason === "SAFETY" ? "blocked" : "bad_response", reason !== "SAFETY");
    }
    const u = data.usageMetadata ?? {};
    return {
      text,
      inputTokens: u.promptTokenCount ?? 0,
      // thinking tokens are billed as output
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      finishReason: cand?.finishReason ?? "STOP",
      model: data.modelVersion ?? this.model,
    };
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

function toError(status: number, data: GeminiResponse): LlmError {
  const msg = data.error?.message ?? `HTTP ${status}`;
  if (status === 400 && /API key/i.test(msg)) return new LlmError("Gemini API kaliti noto'g'ri", "auth", false);
  if (status === 401 || status === 403) return new LlmError(`Gemini ruxsat bermadi: ${msg}`, "auth", false);
  if (status === 404) return new LlmError(`Gemini modeli topilmadi: ${msg}`, "config", false);
  if (status === 429) {
    const delay = data.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    const ms = delay ? Math.ceil(parseFloat(delay) * 1000) : undefined;
    return new LlmError("Gemini limiti tugadi (429)", "rate_limit", true, ms);
  }
  if (status >= 500) return new LlmError(`Gemini server xatosi (${status})`, "server", true);
  return new LlmError(`Gemini xatosi: ${msg}`, "bad_response", false);
}
