import type { Config } from "../config.js";
import { AnthropicClient } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";
import { MockLlm } from "./mock.js";
import { ProviderRouter } from "./router.js";
import type { LlmClient, Pricing, ProviderId } from "./types.js";

export * from "./types.js";
export { ProviderRouter } from "./router.js";

export interface LlmSetup {
  client: LlmClient | null;
  /** price of the default provider (the router prices every answer at the provider that gave it) */
  pricing: Pricing;
  /** why there is no client (shown in the UI) */
  reason?: string;
}

/**
 * Gemini and/or Claude behind one router. LLM_PROVIDER picks the default provider (gemini | anthropic | mock);
 * LLM_FALLBACK lists the providers tried after it (e.g. "anthropic"). A provider without its API key is simply
 * not configured — it is never called, and the health check says so.
 */
export function createLlm(cfg: Config, log?: (msg: string, meta?: Record<string, unknown>) => void): LlmSetup {
  const l = cfg.llm;
  const pricing: Partial<Record<ProviderId, Pricing>> = {
    gemini: { inputPerM: l.priceInputPerM, outputPerM: l.priceOutputPerM },
    anthropic: { inputPerM: l.anthropicPriceInputPerM, outputPerM: l.anthropicPriceOutputPerM },
    mock: { inputPerM: l.priceInputPerM, outputPerM: l.priceOutputPerM },
  };
  if (l.provider === "mock") {
    const mock = new MockLlm();
    return { client: new ProviderRouter({ clients: { mock }, defaultProvider: "mock", fallback: [], pricing, log }), pricing: pricing.mock! };
  }
  const clients: Partial<Record<ProviderId, LlmClient>> = {};
  if (l.geminiApiKey)
    clients.gemini = new GeminiClient({
      apiKey: l.geminiApiKey, model: l.geminiModel, minIntervalMs: l.minIntervalMs, log,
      embeddingModel: l.embeddingModel, embeddingDims: 768,
    });
  if (l.anthropicApiKey) clients.anthropic = new AnthropicClient({ apiKey: l.anthropicApiKey, model: l.anthropicModel, serverFallback: l.anthropicServerFallback });
  const wanted = (["gemini", "anthropic"] as const).find((p) => p === l.provider);
  if (!wanted) return { client: null, pricing: pricing.gemini!, reason: `LLM_PROVIDER="${l.provider}" qo'llab-quvvatlanmaydi (gemini | anthropic | mock)` };
  if (!Object.keys(clients).length) return { client: null, pricing: pricing[wanted]!, reason: "GEMINI_API_KEY ham, ANTHROPIC_API_KEY ham .env da yo'q" };
  const defaultProvider: ProviderId = clients[wanted] ? wanted : (Object.keys(clients)[0] as ProviderId);
  const fallback = l.fallback.filter((p): p is ProviderId => p === "gemini" || p === "anthropic").filter((p) => p !== defaultProvider);
  return {
    client: new ProviderRouter({ clients, defaultProvider, fallback, pricing, log }),
    pricing: pricing[defaultProvider]!,
    ...(clients[wanted] ? {} : { reason: `${wanted} sozlanmagan — ${defaultProvider} ishlatiladi` }),
  };
}
