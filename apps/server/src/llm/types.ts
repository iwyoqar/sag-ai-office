// Provider-neutral LLM interface. Gemini today; Claude (Anthropic) can be added behind the same interface.

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
}

export interface ToolResult {
  name: string;
  response: Record<string, unknown>;
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
}

export interface LlmClient {
  readonly provider: "gemini" | "mock";
  readonly model: string;
  /** "live" = real provider call; "mock" = scripted test double (never shown as real work) */
  readonly mode: "live" | "mock";
  generate(req: LlmRequest): Promise<LlmResult>;
  /** verifies credentials / model availability; never throws */
  health(): Promise<{ ok: boolean; model: string; detail?: string }>;
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
