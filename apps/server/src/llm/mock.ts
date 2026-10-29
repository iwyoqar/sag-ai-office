// Scripted test double. Used by automated tests (and only by explicit LLM_PROVIDER=mock).
// Every run made with it is stored with mode = "mock" and the UI labels it — never presented as real work.
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "./types.js";

export type MockReply = string | LlmError | ((req: LlmRequest) => string | LlmError | Promise<string>);

/** Dev default: a fixed sample plan for orchestration, otherwise an explicitly labelled placeholder answer. */
function defaultMockReply(req: LlmRequest): string {
  if (req.json)
    return JSON.stringify({
      summary: "MOCK reja (haqiqiy AI emas)",
      subtasks: [
        { key: "s1", title: "MOCK: bozor tahlili", description: "Sinov kichik vazifasi", department: "marketing", dependsOn: [] },
        { key: "s2", title: "MOCK: budjet hisobi", description: "Sinov kichik vazifasi", department: "finance", dependsOn: [] },
        { key: "s3", title: "MOCK: yakuniy tavsiya", description: "Sinov kichik vazifasi", department: "marketing", dependsOn: ["s1", "s2"] },
      ],
    });
  const title = /Sarlavha: (.*)/.exec(req.messages.at(-1)?.text ?? "")?.[1] ?? req.messages.at(-1)?.text.slice(0, 60) ?? "";
  return `**MOCK javob — haqiqiy AI emas.**\n\nVazifa: ${title}\n\n- Bu matn sinov rejimida yaratildi.\n- Haqiqiy natija uchun GEMINI_API_KEY ni sozlang.`;
}

export class MockLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly mode = "mock" as const;
  readonly model = "mock-model";
  readonly calls: LlmRequest[] = [];

  constructor(private reply: MockReply = defaultMockReply) {}

  setReply(r: MockReply) {
    this.reply = r;
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    if (req.signal?.aborted) throw new LlmError("Bekor qilindi", "aborted", false);
    const out = await (typeof this.reply === "function" ? this.reply(req) : this.reply);
    if (out instanceof LlmError) throw out;
    const inTok = Math.ceil((req.system.length + req.messages.reduce((n, m) => n + m.text.length, 0)) / 4);
    return { text: out, inputTokens: inTok, outputTokens: Math.ceil(out.length / 4), finishReason: "STOP", model: this.model };
  }

  readonly embeddingModel = "mock-embedding";

  /** Deterministic bag-of-words hashing embedding (tests only): shared words → similar vectors. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const w of t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        v[Math.abs(h) % 64] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }

  async health() {
    return { ok: true, model: this.model, detail: "mock" };
  }
}
