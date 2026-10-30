// HQ AI workforce: dashboard state, the AI Director's settings, per-agent provider selection, provider health.
// Reading needs brain:manage or users:manage (it shows spend); changing needs users:manage or agents:manage.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, parse, requireUser } from "../app.js";
import { has } from "../domain/access.js";
import { workforceState } from "../domain/workforce.js";
import { audit } from "../lib/audit.js";
import { forbidden, notFound } from "../lib/errors.js";
import { now } from "../db/db.js";
import { ProviderRouter } from "../llm/router.js";

const Provider = z.enum(["gemini", "anthropic"]).nullable();

export const workforceRoutes = (d: Deps) => async (app: FastifyInstance) => {
  app.get("/api/workforce", async (req) => {
    const u = requireUser(req);
    if (!has(u, "brain:manage") && !has(u, "users:manage")) throw forbidden();
    const c = d.llm.client;
    const providers = c instanceof ProviderRouter ? await c.healthAll() : [];
    return { state: workforceState(d, "hq"), providers, mode: c?.mode ?? null };
  });

  app.put("/api/workforce/director", async (req) => {
    const u = requireUser(req);
    if (!has(u, "users:manage")) throw forbidden();
    const b = parse(z.object({
      agentId: z.string().max(80).nullable().optional(), provider: Provider.optional(), model: z.string().trim().max(120).nullable().optional(),
      maxSubtasks: z.number().int().min(1).max(12).optional(), maxRevisions: z.number().int().min(0).max(5).optional(),
      maxAiHireRequests: z.number().int().min(0).max(20).optional(), budgetAlertPct: z.number().int().min(1).max(100).optional(),
    }), req.body);
    if (b.agentId && !d.db.get("SELECT 1 FROM agents WHERE id = ? AND business_unit_id = 'hq' AND lifecycle = 'ACTIVE'", b.agentId)) throw notFound("Agent");
    const cols: Record<string, string> = {
      agentId: "agent_id", provider: "provider", model: "model", maxSubtasks: "max_subtasks", maxRevisions: "max_revisions",
      maxAiHireRequests: "max_ai_hire_requests", budgetAlertPct: "budget_alert_pct",
    };
    const keys = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (keys.length)
      d.db.tx(() => {
        d.db.run(
          `UPDATE ai_director_settings SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")}, updated_by = ?, updated_at = ? WHERE business_unit_id = 'hq'`,
          ...keys.map((k) => ((b as Record<string, unknown>)[k] as string | number | null) || ((b as Record<string, unknown>)[k] === 0 ? 0 : null)), u.id, now(),
        );
        audit(d.db, { type: "user", id: u.id }, "workforce.director.update", { type: "unit", id: "hq" }, b);
      });
    return { state: workforceState(d, "hq") };
  });

  /** Which provider (and model) an agent runs on; NULL = the platform default. */
  app.put("/api/agents/:id/provider", async (req) => {
    const u = requireUser(req);
    if (!has(u, "agents:manage")) throw forbidden();
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const b = parse(z.object({ provider: Provider, model: z.string().trim().max(120).nullable().default(null) }), req.body);
    const a = d.db.get<{ business_unit_id: string }>("SELECT business_unit_id FROM agents WHERE id = ?", id);
    if (!a || a.business_unit_id !== "hq") throw notFound("Agent");
    d.db.tx(() => {
      d.db.run("UPDATE agents SET provider = ?, model = ?, updated_at = ? WHERE id = ?", b.provider, b.model || null, now(), id);
      audit(d.db, { type: "user", id: u.id }, "agent.provider", { type: "agent", id }, b);
    });
    d.bus.emit("agent.updated", { agentId: id }, { change: "provider" }, u.id);
    return { ok: true };
  });
};
