// Provider-neutral LLM interface: Google Gemini and Anthropic Claude behind one shape, routed per agent (router.ts).

export interface LlmMessage {
  role: "user" | "model";
  text: string;
  /** model turn that asked for tools */
  toolCalls?: ToolCall[];
  /** user turn carrying tool results back to the model */
  toolResults?: ToolResult[];
}

/** A function the model may call (JSON-schema parameters, Gemini/OpenAPI subset). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** provider's call id (Claude needs it to match the result to the call) */
  id?: string;
}

export interface ToolResult {
  name: string;
  response: Record<string, unknown>;
  /** id of the call this answers */
  id?: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** ask the model for a JSON object (structured output) */
  json?: boolean;
  /** functions the model may call; its answer then has `toolCalls` instead of (or besides) text */
  tools?: ToolSpec[];
  timeoutMs?: number;
  correlationId: string;
  signal?: AbortSignal;
  /** per-agent routing: provider and model for this call (default: the router's default provider and its model) */
  route?: { provider?: ProviderId | null; model?: string | null };
  /** model override for a single-provider client (set by the router from `route`) */
  model?: string;
}

export interface LlmResult {
  text: string;
  toolCalls?: ToolCall[];
  /** agent_runs id (set by the runner) */
  runId?: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  model: string;
  /** provider that answered (after any fallback) */
  provider?: ProviderId;
  /** estimated USD cost at that provider's configured price (the router fills it in) */
  costUsd?: number;
}

/** providers the platform can call; "mock" is the labelled test double */
export type ProviderId = "gemini" | "anthropic" | "mock";

/** What a health check found, told apart so the UI can say what to fix. */
export type ProviderStatus = "not_configured" | "invalid_credentials" | "rate_limited" | "available" | "unavailable";

export interface ProviderHealth { provider: ProviderId; model: string; status: ProviderStatus; ok: boolean; detail?: string }

export interface LlmClient {
  readonly provider: ProviderId | "router";
  readonly model: string;
  /** "live" = real provider call; "mock" = scripted test double (never shown as real work) */
  readonly mode: "live" | "mock";
  generate(req: LlmRequest): Promise<LlmResult>;
  /** verifies credentials / model availability; never throws */
  health(): Promise<{ ok: boolean; model: string; detail?: string; status?: ProviderStatus }>;
  /** text embeddings (unit length); absent when the provider has no embedding model configured */
  embed?(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
  readonly embeddingModel?: string;
  /** web search grounded by the provider (Gemini: google_search); absent when not supported */
  searchWeb?(query: string, correlationId: string): Promise<{ text: string; sources: { title: string; url: string }[] }>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "rate_limit" | "timeout" | "blocked" | "server" | "bad_response" | "aborted" | "config",
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface Pricing {
  inputPerM: number;
  outputPerM: number;
}

/** Estimated cost in USD. Providers do not return billed amounts, so this is always an estimate. */
export function estimateCost(p: Pricing, inputTokens: number, outputTokens: number): number {
  return Math.round(((inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1e6) * 1e6) / 1e6;
}

/** Health status from a failed check (or an error seen on a call). */
export function statusOf(e: unknown): ProviderStatus {
  if (!(e instanceof LlmError)) return "unavailable";
  if (e.code === "auth") return "invalid_credentials";
  if (e.code === "rate_limit") return "rate_limited";
  if (e.code === "config") return "not_configured";
  return "unavailable";
}
