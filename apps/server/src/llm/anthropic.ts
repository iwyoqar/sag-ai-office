// Anthropic Claude through the official TypeScript SDK (@anthropic-ai/sdk). Same LlmClient shape as Gemini: text,
// tool calls (with ids, so results match their calls), provider-reported usage, typed error classes mapped to
// LlmError codes. The key comes from ANTHROPIC_API_KEY only; nothing here logs prompts or credentials.
import Anthropic from "@anthropic-ai/sdk";
import { LlmError, statusOf, type LlmClient, type LlmMessage, type LlmRequest, type LlmResult, type ProviderStatus } from "./types.js";

/** The two SDK calls this client uses (injectable so tests never reach the network). */
export interface AnthropicApi {
  beta: { messages: { create(body: Record<string, unknown>, opts?: { timeout?: number; signal?: AbortSignal; maxRetries?: number }): Promise<unknown> } };
  models: { retrieve(id: string): Promise<unknown> };
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** SDK-level retries for 408/409/429/5xx and connection errors (default 2) */
  maxRetries?: number;
  /** server-side refusal fallback (`fallbacks: "default"`); on for the models that accept it */
  serverFallback?: boolean;
  api?: AnthropicApi;
}

interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
interface MessageResponse {
  content: ContentBlock[]; model: string; stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

/** Models that accept the `fallbacks: "default"` server-side refusal fallback on the Claude API. */
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5)/;

/** Claude messages from the neutral history: tool calls become tool_use blocks, results tool_result blocks. */
export function toClaudeMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.toolCalls?.length)
      return {
        role: "assistant",
        content: [
          ...(m.text ? [{ type: "text", text: m.text }] : []),
          ...m.toolCalls.map((c, i) => ({ type: "tool_use", id: c.id ?? `call_${i}`, name: c.name, input: c.args })),
        ],
      };
    if (m.toolResults?.length)
      return {
        role: "user",
        content: m.toolResults.map((r, i) => ({ type: "tool_result", tool_use_id: r.id ?? `call_${i}`, content: JSON.stringify(r.response) })),
      };
    return { role: m.role === "model" ? "assistant" : "user", content: m.text };
  });
}

/** SDK error → LlmError (most specific class first). */
export function toLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new LlmError("Bekor qilindi", "aborted", false);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("Claude javob bermadi (timeout)", "timeout", true);
  if (e instanceof Anthropic.AuthenticationError) return new LlmError("Claude API kaliti noto'g'ri", "auth", false);
  if (e instanceof Anthropic.PermissionDeniedError) return new LlmError("Claude ruxsat bermadi", "auth", false);
  if (e instanceof Anthropic.NotFoundError) return new LlmError("Claude modeli topilmadi", "config", false);
  if (e instanceof Anthropic.RateLimitError) {
    const after = Number(e.headers?.get?.("retry-after"));
    return new LlmError("Claude limiti tugadi (429)", "rate_limit", true, Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
  }
  if (e instanceof Anthropic.BadRequestError) return new LlmError(`Claude so'rovni qabul qilmadi: ${e.message}`, "bad_response", false);
  if (e instanceof Anthropic.InternalServerError) return new LlmError(`Claude server xatosi (${e.status})`, "server", true);
  if (e instanceof Anthropic.APIConnectionError) return new LlmError("Claude bilan aloqa yo'q", "server", true);
  if (e instanceof Anthropic.APIError) return new LlmError(`Claude xatosi (${e.status ?? "?"})`, e.status && e.status >= 500 ? "server" : "bad_response", !!e.status && e.status >= 500);
  return new LlmError(String(e), "server", false);
}

export class AnthropicClient implements LlmClient {
  readonly provider = "anthropic" as const;
  readonly mode = "live" as const;
  readonly model: string;
  private readonly api: AnthropicApi;

  constructor(private o: AnthropicOptions) {
    this.model = o.model;
    this.api = o.api ?? (new Anthropic({ apiKey: o.apiKey, maxRetries: o.maxRetries ?? 2 }) as unknown as AnthropicApi);
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    if (req.signal?.aborted) throw new LlmError("Bekor qilindi", "aborted", false);
    const model = req.model ?? this.model;
    const fallback = (this.o.serverFallback ?? true) && FALLBACK_MODELS.test(model);
    const system = req.json ? `${req.system}\n\nJavob faqat bitta JSON obyekt bo'lsin, boshqa matnsiz.` : req.system;
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxOutputTokens ?? 16000,
      system,
      messages: toClaudeMessages(req.messages),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
    let res: MessageResponse;
    try {
      res = (await this.api.beta.messages.create(body, { timeout: req.timeoutMs ?? 120_000, signal: req.signal })) as MessageResponse;
    } catch (e) {
      throw toLlmError(e);
    }
    if (res.stop_reason === "refusal") throw new LlmError("Claude bu so'rovni bajarmadi (refusal)", "blocked", false);
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    const toolCalls = res.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name ?? "", args: b.input ?? {} }));
    if (!text && !toolCalls.length) throw new LlmError("Claude bo'sh javob qaytardi", "bad_response", true);
    const u = res.usage;
    return {
      text, ...(toolCalls.length ? { toolCalls } : {}),
      // provider-reported usage; cached input is billed differently but still counts as input here
      inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens,
      finishReason: res.stop_reason ?? "end_turn", model: res.model ?? model, provider: "anthropic",
    };
  }

  /** Model lookup: no tokens spent, tells a bad key from a missing model from an outage. */
  async health(): Promise<{ ok: boolean; model: string; detail?: string; status: ProviderStatus }> {
    try {
      await this.api.models.retrieve(this.model);
      return { ok: true, model: this.model, status: "available" };
    } catch (e) {
      const err = toLlmError(e);
      return { ok: false, model: this.model, detail: err.message, status: statusOf(err) };
    }
  }
}
