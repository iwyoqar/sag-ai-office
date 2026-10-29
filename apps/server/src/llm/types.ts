// Provider-neutral LLM interface. Gemini today; Claude (Anthropic) can be added behind the same interface.

export interface LlmMessage {
  role: "user" | "model";
  text: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** ask the model for a JSON object (structured output) */
  json?: boolean;
  timeoutMs?: number;
  correlationId: string;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
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
