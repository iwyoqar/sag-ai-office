import type { Config } from "../config.js";
import { GeminiClient } from "./gemini.js";
import { MockLlm } from "./mock.js";
import type { LlmClient, Pricing } from "./types.js";

export * from "./types.js";

export interface LlmSetup {
  client: LlmClient | null;
  pricing: Pricing;
  /** why there is no client (shown in the UI) */
  reason?: string;
}

export function createLlm(cfg: Config, log?: (msg: string, meta?: Record<string, unknown>) => void): LlmSetup {
  const pricing = { inputPerM: cfg.llm.priceInputPerM, outputPerM: cfg.llm.priceOutputPerM };
  if (cfg.llm.provider === "mock") return { client: new MockLlm(), pricing };
  if (cfg.llm.provider === "gemini") {
    if (!cfg.llm.geminiApiKey) return { client: null, pricing, reason: "GEMINI_API_KEY .env da yo'q" };
    return {
      client: new GeminiClient({
        apiKey: cfg.llm.geminiApiKey, model: cfg.llm.geminiModel, minIntervalMs: cfg.llm.minIntervalMs, log,
        embeddingModel: cfg.llm.embeddingModel, embeddingDims: 768,
      }),
      pricing,
    };
  }
  return { client: null, pricing, reason: `LLM_PROVIDER="${cfg.llm.provider}" qo'llab-quvvatlanmaydi` };
}
