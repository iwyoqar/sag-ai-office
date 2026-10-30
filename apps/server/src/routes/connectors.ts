// Connector state, live checks, Google OAuth and the agent action log. Managing connectors needs brain:manage;
// approving agent actions goes through /api/approvals/:id/decide (tasks:manage).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, parse, requirePerm } from "../app.js";
import { audit } from "../lib/audit.js";
import { badRequest } from "../lib/errors.js";

export const connectorRoutes = (d: Deps) => async (app: FastifyInstance) => {
  const hub = d.connectors;

  app.get("/api/connectors/status", async (req) => {
    requirePerm(req, "agents:read");
    return {
      connectors: hub.status(),
      google: { configured: hub.google.configured, connected: hub.google.connected, account: hub.google.account, canStore: hub.secrets.enabled },
    };
  });

  app.post("/api/connectors/:id/verify", async (req) => {
    requirePerm(req, "brain:manage");
    const { id } = parse(z.object({ id: z.string().max(40) }), req.params);
    const r = await hub.verify(id);
    hub.sync();
    return r;
  });

  app.get("/api/connectors/activity", async (req) => {
    requirePerm(req, "tasks:read");
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return { items: hub.activity(q.limit) };
  });

  // ---- Google OAuth (one company account for Gmail, Drive, Sheets, Calendar)
  app.get("/api/connectors/google/start", async (req, reply) => {
    const u = requirePerm(req, "brain:manage");
    if (!hub.secrets.enabled && !hub.google.connected) throw badRequest("SECRETS_KEY sozlanmagan — tokenni xavfsiz saqlab bo'lmaydi");
    return reply.redirect(hub.google.authUrl(u.id));
  });

  app.get("/api/connectors/google/callback", async (req, reply) => {
    const q = parse(z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).default(""), error: z.string().max(200).optional() }), req.query);
    if (q.error || !q.code) return reply.redirect(`/?connectors=google_error&reason=${encodeURIComponent(q.error ?? "no_code")}`);
    try {
      const r = await hub.google.complete(q.code, q.state);
      audit(d.db, { type: "user", id: r.userId }, "connector.google.connect", { type: "connector", id: "google" }, { account: r.account, scopes: r.scopes });
      hub.sync();
      d.bus.emit("connector.activity", {}, { connector: "google", status: "connected" });
      return reply.redirect("/?connectors=google_connected");
    } catch (e) {
      return reply.redirect(`/?connectors=google_error&reason=${encodeURIComponent(e instanceof Error ? e.message : "error")}`);
    }
  });

  app.delete("/api/connectors/google", async (req) => {
    const u = requirePerm(req, "brain:manage");
    hub.google.disconnect();
    audit(d.db, { type: "user", id: u.id }, "connector.google.disconnect", { type: "connector", id: "google" });
    hub.sync();
    return { ok: true };
  });
};
