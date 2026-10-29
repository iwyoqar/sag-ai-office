import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Deps, parse, requirePerm } from "../app.js";
import { buildSystemPrompt } from "../agents/prompt.js";
import { now } from "../db/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { LlmError, estimateCost } from "../llm/types.js";
import { searchKnowledge } from "../knowledge/service.js";
import { approvedMemory } from "../domain/brain.js";

const Id = z.object({ id: z.string().min(1).max(80) });

export const runtimeRoutes = (d: Deps) => async (app: FastifyInstance) => {
  /** What powers the agents right now — shown in the top bar so mock/off is never mistaken for live. */
  app.get("/api/system", async (req) => {
    requirePerm(req, "agents:read");
    const c = d.llm.client;
    return {
      llm: c
        ? { configured: true, provider: c.provider, model: c.model, mode: c.mode, health: d.llmHealth ?? null }
        : { configured: false, provider: null, model: null, mode: null, reason: d.llm.reason ?? "LLM sozlanmagan", health: null },
      worker: { running: d.runner?.running ?? false, active: d.runner?.activeCount ?? 0 },
    };
  });

  app.get("/api/agents/:id/chat", async (req) => {
    requirePerm(req, "agents:read");
    const { id } = parse(Id, req.params);
    return {
      messages: d.db.all(
        `SELECT id, role, content, created_at createdAt FROM chat_messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`, id,
      ).reverse(),
    };
  });

  app.post("/api/agents/:id/chat", async (req) => {
    const u = requirePerm(req, "tasks:create");
    const { id } = parse(Id, req.params);
    const { message } = parse(z.object({ message: z.string().trim().min(1).max(4000) }), req.body);
    const agent = d.db.get<{ id: string; department_id: string; lifecycle: string }>("SELECT id, department_id, lifecycle FROM agents WHERE id = ?", id);
    if (!agent) throw notFound("Agent");
    if (agent.lifecycle === "ARCHIVED") throw new HttpError(409, "agent_archived", "Agent arxivlangan");
    const llm = d.llm.client;
    if (!llm) throw new HttpError(503, "llm_not_configured", `AI ulanmagan: ${d.llm.reason ?? ""}`.trim());

    const history = d.db
      .all<{ role: "user" | "agent"; content: string }>(
        "SELECT role, content FROM chat_messages WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 12", id, u.id,
      )
      .reverse();
    const system = buildSystemPrompt(d, id, [
      "\n## Suhbat rejimi",
      "Bu foydalanuvchi bilan qisqa suhbat. Aniq va qisqa javob ber (odatda 1–3 paragraf).",
      "Katta hajmli ish so'ralsa, uni vazifa (task) sifatida yaratishni tavsiya qil.",
    ]);
    // Company documents (only this agent's department scope) and approved memory, passed as data.
    const hits = searchKnowledge(d, message, { departmentId: agent.department_id, limit: 4 });
    const mem = approvedMemory(d, agent.department_id, 8);
    const grounding = [
      ...mem.map((m) => `<context type="kompaniya xotirasi">[${m.kind}] ${m.content.replace(/<\/?(context|document)>/gi, "")}</context>`),
      ...hits.map((h) => `<document source="${h.title.replace(/"/g, "'")}">${h.content.replace(/<\/?(context|document)>/gi, "")}</document>`),
    ].join("\n");
    const userText = grounding ? `${grounding}\n\nSavol: ${message}` : message;
    const runId = uid("run");
    const correlationId = randomUUID();
    const started = Date.now();
    d.db.run(
      "INSERT INTO agent_runs (id, task_id, agent_id, correlation_id, model, mode, status, started_at) VALUES (?, NULL, ?, ?, ?, ?, 'running', ?)",
      runId, id, correlationId, llm.model, llm.mode, now(),
    );
    const userMsg = { id: uid("chat"), role: "user" as const, content: message, createdAt: now() };
    d.db.run("INSERT INTO chat_messages (id, agent_id, user_id, role, content, created_at) VALUES (?,?,?,?,?,?)", userMsg.id, id, u.id, "user", message, userMsg.createdAt);
    try {
      const res = await llm.generate({
        system,
        messages: [...history.map((h) => ({ role: h.role === "user" ? ("user" as const) : ("model" as const), text: h.content })), { role: "user", text: userText }],
        maxOutputTokens: 1500, correlationId, timeoutMs: 60_000,
      });
      const cost = estimateCost(d.llm.pricing, res.inputTokens, res.outputTokens);
      const reply = { id: uid("chat"), role: "agent" as const, content: res.text, createdAt: now() };
      d.db.tx(() => {
        d.db.run(
          "UPDATE agent_runs SET status = 'succeeded', model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, latency_ms = ?, finished_at = ? WHERE id = ?",
          res.model, res.inputTokens, res.outputTokens, cost, Date.now() - started, now(), runId,
        );
        d.db.run(
          `INSERT INTO usage_records (id, run_id, agent_id, department_id, task_id, model, input_tokens, output_tokens, cost_usd, is_estimate, created_at)
           VALUES (?,?,?,?,NULL,?,?,?,?,1,?)`,
          uid("use"), runId, id, agent.department_id, res.model, res.inputTokens, res.outputTokens, cost, now(),
        );
        d.db.run("INSERT INTO chat_messages (id, agent_id, user_id, role, content, run_id, created_at) VALUES (?,?,?,?,?,?,?)", reply.id, id, u.id, "agent", res.text, runId, reply.createdAt);
      });
      return { messages: [userMsg, reply], mode: llm.mode };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError(String(e), "server", false);
      d.db.run("UPDATE agent_runs SET status = 'failed', error = ?, latency_ms = ?, finished_at = ? WHERE id = ?", err.message, Date.now() - started, now(), runId);
      throw new HttpError(err.code === "rate_limit" ? 429 : 502, `llm_${err.code}`, err.message);
    }
  });
};
