// Multi-provider execution layer: one LlmClient that routes each call to the agent's provider (Gemini or Claude),
// falls back to the next configured provider on failures that another provider can absorb (rate limits, outages,
// timeouts — never on a refusal, bad request or an aborted call), and prices each answer at the provider that gave it.
import { LlmError, estimateCost, type LlmClient, type LlmRequest, type LlmResult, type Pricing, type ProviderHealth, type ProviderId } from "./types.js";

/** Errors worth trying on another provider. */
const FALLBACK_CODES = new Set<LlmError["code"]>(["rate_limit", "server", "timeout", "auth", "config"]);

export interface RouterOptions {
  clients: Partial<Record<ProviderId, LlmClient>>;
  /** provider used when the agent names none */
  defaultProvider: ProviderId;
  /** providers tried, in order, after the chosen one fails with a fallback-worthy error ([] = no fallback) */
  fallback: ProviderId[];
  pricing: Partial<Record<ProviderId, Pricing>>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class ProviderRouter implements LlmClient {
  readonly provider = "router" as const;

  constructor(private o: RouterOptions) {}

  get providers(): ProviderId[] {
    return Object.keys(this.o.clients) as ProviderId[];
  }

  clientFor(p: ProviderId): LlmClient | undefined {
    return this.o.clients[p];
  }

  private get primary(): LlmClient {
    return this.o.clients[this.o.defaultProvider] ?? Object.values(this.o.clients)[0]!;
  }

  get model() {
    return this.primary.model;
  }

  /** "mock" only when every configured provider is the test double */
  get mode(): "live" | "mock" {
    return Object.values(this.o.clients).some((c) => c?.mode === "live") ? "live" : "mock";
  }

  get embeddingModel() {
    return this.o.clients.gemini?.embeddingModel ?? this.o.clients.mock?.embeddingModel;
  }

  /** embeddings and grounded search stay with the provider that offers them (Gemini; the mock in tests) */
  get embed() {
    const c = this.o.clients.gemini ?? this.o.clients.mock;
    return c?.embed?.bind(c);
  }

  get searchWeb() {
    const c = this.o.clients.gemini ?? this.o.clients.mock;
    return c?.searchWeb?.bind(c);
  }

  /** The order to try for a call: the agent's provider (or the default), then the fallback chain, each once. */
  order(req: Pick<LlmRequest, "route">): ProviderId[] {
    const first = req.route?.provider && this.o.clients[req.route.provider] ? req.route.provider : this.o.defaultProvider;
    return [...new Set([first, ...this.o.fallback])].filter((p) => !!this.o.clients[p]);
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const order = this.order(req);
    if (!order.length) throw new LlmError("Hech bir AI provider sozlanmagan", "config", false);
    let last: LlmError | null = null;
    for (const [i, p] of order.entries()) {
      const client = this.o.clients[p]!;
      // the agent's model applies to its own provider only; a fallback provider uses its own configured model
      const model = i === 0 && req.route?.model ? req.route.model : undefined;
      try {
        const res = await client.generate({ ...req, model });
        const provider = (res.provider ?? (p as ProviderId)) as ProviderId;
        const price = this.o.pricing[provider];
        return { ...res, provider, costUsd: price ? estimateCost(price, res.inputTokens, res.outputTokens) : 0 };
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), "server", false);
        last = err;
        if (req.signal?.aborted || !FALLBACK_CODES.has(err.code) || i === order.length - 1) throw err;
        this.o.log?.("llm fallback", { from: p, to: order[i + 1], code: err.code, correlationId: req.correlationId });
      }
    }
    throw last ?? new LlmError("Noma'lum xato", "server", false);
  }

  /** Every configured provider's health, plus the not-configured ones the platform knows about. */
  async healthAll(): Promise<ProviderHealth[]> {
    const known: ProviderId[] = ["gemini", "anthropic"];
    const out: ProviderHealth[] = [];
    for (const p of [...new Set([...known, ...this.providers])]) {
      const c = this.o.clients[p];
      if (!c) {
        out.push({ provider: p, model: "", status: "not_configured", ok: false, detail: `${p === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} sozlanmagan` });
        continue;
      }
      const h = await c.health();
      out.push({ provider: p, model: h.model, ok: h.ok, status: h.status ?? (h.ok ? "available" : "unavailable"), ...(h.detail ? { detail: h.detail } : {}) });
    }
    return out;
  }

  /** Healthy when the default provider (or, failing that, any fallback) can answer. */
  async health(): Promise<{ ok: boolean; model: string; detail?: string; status?: ProviderHealth["status"] }> {
    const all = await this.healthAll();
    const usable = this.order({}).map((p) => all.find((h) => h.provider === p)!).filter(Boolean);
    const ok = usable.find((h) => h.ok);
    const first = usable[0];
    if (ok) return { ok: true, model: ok.model, status: "available", ...(ok !== first ? { detail: `${first?.provider}: ${first?.detail ?? first?.status}; ${ok.provider} ishlatiladi` } : {}) };
    return { ok: false, model: first?.model ?? "", status: first?.status ?? "not_configured", detail: usable.map((h) => `${h.provider}: ${h.detail ?? h.status}`).join("; ") };
  }
}
