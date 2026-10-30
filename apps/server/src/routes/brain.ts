import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, actorOf, parse, requirePerm } from "../app.js";
import {
  addMemory, decideApproval, decideMemory, listApprovals, listInstructions, listMemory, retireInstruction,
  saveInstruction, setSetting, type Scope,
} from "../domain/brain.js";
import { ingestDocument, knowledgeStatus, listDocuments, removeDocument } from "../knowledge/service.js";
import { embedPending, embedderOf, retrieve } from "../knowledge/semantic.js";
import { MAX_UPLOAD_BYTES } from "../knowledge/extract.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";

const Id = z.object({ id: z.string().min(1).max(80) });
const ScopeQ = z.object({
  scope: z.enum(["GLOBAL", "DEPARTMENT", "AGENT"]),
  scopeId: z.string().max(80).optional(),
  history: z.enum(["true", "false"]).optional(),
});

export const brainRoutes = (d: Deps) => async (app: FastifyInstance) => {
  const embedder = embedderOf(d.llm.client);
  let embedError: string | null = null;
  const embedInBackground = () => {
    if (!embedder) return;
    embedPending(d, embedder).then(
      () => { embedError = null; },
      (e) => { embedError = (e as Error).message; app.log.warn({ err: embedError }, "embedding failed — full-text search still works"); },
    );
  };
  embedInBackground(); // backfill chunks ingested before embeddings were enabled

  // ---------------------------------------------------------------- knowledge
  app.get("/api/knowledge", async (req) => {
    requirePerm(req, "agents:read");
    return { status: knowledgeStatus(d, embedder?.model, embedError), documents: listDocuments(d) };
  });

  app.post("/api/knowledge", async (req, reply) => {
    const u = requirePerm(req, "brain:manage");
    let file: { filename: string; mimetype: string; data: Buffer } | null = null;
    const fields: Record<string, string> = {};
    for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })) {
      if (part.type === "file") {
        const data = await part.toBuffer();
        if (part.file.truncated) throw badRequest("Fayl 15 MB dan katta");
        file = { filename: part.filename, mimetype: part.mimetype, data };
      } else fields[part.fieldname] = String(part.value ?? "");
    }
    if (!file) throw badRequest("Fayl tanlanmagan");
    const departmentId = fields.departmentId?.trim() || null;
    if (departmentId && !d.db.get("SELECT 1 FROM departments WHERE id = ?", departmentId)) throw notFound("Bo'lim");
    const doc = await ingestDocument(d, { title: fields.title, filename: file.filename, mime: file.mimetype, data: file.data, departmentId }, actorOf(u));
    if (!doc.duplicate) embedInBackground();
    reply.status(doc.duplicate ? 200 : 201);
    return { document: doc };
  });

  app.delete("/api/knowledge/:id", async (req) => {
    const u = requirePerm(req, "brain:manage");
    removeDocument(d, parse(Id, req.params).id, actorOf(u));
    return { ok: true };
  });

  app.get("/api/knowledge/search", async (req) => {
    requirePerm(req, "agents:read");
    const q = parse(z.object({ q: z.string().min(2).max(500), departmentId: z.string().optional() }), req.query);
    // departmentId given → exactly what an agent of that department would retrieve
    return retrieve(d, embedder, q.q, { departmentId: q.departmentId === undefined ? undefined : q.departmentId || null, limit: 10 });
  });

  // ---------------------------------------------------------------- instructions
  app.get("/api/instructions", async (req) => {
    requirePerm(req, "agents:read");
    const q = parse(ScopeQ, req.query);
    return { instructions: listInstructions(d, q.scope as Scope, q.scopeId ?? null, q.history === "true") };
  });

  app.post("/api/instructions", async (req, reply) => {
    const body = parse(
      z.object({
        scope: z.enum(["GLOBAL", "DEPARTMENT", "AGENT"]),
        scopeId: z.string().max(80).nullish(),
        title: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(20_000),
      }),
      req.body,
    );
    // HR may maintain agent instructions; company/department rules need brain:manage.
    const u = requirePerm(req, body.scope === "AGENT" && req.user?.permissions.includes("agents:manage") ? "agents:manage" : "brain:manage");
    reply.status(201);
    return { instruction: saveInstruction(d, { ...body, scopeId: body.scopeId ?? null }, actorOf(u)) };
  });

  app.post("/api/instructions/:id/retire", async (req) => {
    const u = requirePerm(req, "brain:manage");
    retireInstruction(d, parse(Id, req.params).id, actorOf(u));
    return { ok: true };
  });

  // ---------------------------------------------------------------- company memory
  app.get("/api/memory", async (req) => {
    requirePerm(req, "agents:read");
    const q = parse(z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional() }), req.query);
    return { memory: listMemory(d, q.status) };
  });

  app.post("/api/memory", async (req, reply) => {
    const u = requirePerm(req, "brain:manage");
    const body = parse(
      z.object({
        kind: z.enum(["decision", "correction", "lesson", "rule", "result"]),
        content: z.string().trim().min(3).max(4000),
        departmentId: z.string().nullish(),
      }),
      req.body,
    );
    reply.status(201);
    // entered by an authorised person → approved immediately
    return { memory: addMemory(d, { ...body, approved: true }, actorOf(u)) };
  });

  app.post("/api/memory/:id/decide", async (req) => {
    const u = requirePerm(req, "brain:manage");
    const body = parse(z.object({ decision: z.enum(["APPROVED", "REJECTED"]) }), req.body);
    decideMemory(d, parse(Id, req.params).id, body.decision, actorOf(u));
    return { ok: true };
  });

  // ---------------------------------------------------------------- approvals
  app.get("/api/approvals", async (req) => {
    requirePerm(req, "tasks:read");
    const q = parse(z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING") }), req.query);
    return { approvals: listApprovals(d, q.status) };
  });

  app.post("/api/approvals/:id/decide", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    const body = parse(z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(2000).optional() }), req.body);
    const { id } = parse(Id, req.params);
    // agent actions through connectors (tool:*) run now when approved; result approvals move the task
    const action = d.db.get<{ action: string }>("SELECT action FROM approvals WHERE id = ?", id)?.action;
    if (action?.startsWith("tool:")) return { execution: await d.connectors.decide(id, body.decision, body.reason, u) };
    return { task: decideApproval(d, id, body.decision, body.reason, actorOf(u), "web") };
  });

  // ---------------------------------------------------------------- connectors
  app.put("/api/connectors/:id/departments", async (req) => {
    const u = requirePerm(req, "brain:manage");
    const { id } = parse(Id, req.params);
    const { departmentIds } = parse(z.object({ departmentIds: z.array(z.string()).max(50) }), req.body);
    if (!d.db.get("SELECT 1 FROM connectors WHERE id = ?", id)) throw notFound("Connector");
    d.db.tx(() => {
      d.db.run("DELETE FROM department_connectors WHERE connector_id = ?", id);
      for (const dep of departmentIds) {
        if (!d.db.get("SELECT 1 FROM departments WHERE id = ?", dep)) throw notFound(`Bo'lim ${dep}`);
        d.db.run("INSERT INTO department_connectors (department_id, connector_id) VALUES (?, ?)", dep, id);
      }
      // agent grants outside the new mapping are revoked
      d.db.run(
        `DELETE FROM agent_connector_permissions WHERE connector_id = ?
         AND agent_id NOT IN (SELECT a.id FROM agents a JOIN department_connectors dc ON dc.department_id = a.department_id WHERE dc.connector_id = ?)`,
        id, id,
      );
      audit(d.db, actorOf(u), "connector.departments", { type: "connector", id }, { departmentIds });
    });
    d.bus.emit("agent.updated", {}, { change: "connectors" });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Telegram
  app.get("/api/telegram", async (req) => {
    requirePerm(req, "agents:read");
    const bot = d.telegram;
    return {
      status: bot?.status ?? { configured: false, running: false, reason: "TELEGRAM_BOT_TOKEN yoki TELEGRAM_GROUP_ID .env da yo'q" },
      settings: bot?.settings() ?? null,
      recent: d.db.all(
        "SELECT update_id updateId, user_id userId, username, command, outcome, task_id taskId, received_at receivedAt FROM telegram_updates ORDER BY update_id DESC LIMIT 20",
      ),
    };
  });

  app.put("/api/telegram/settings", async (req) => {
    const u = requirePerm(req, "brain:manage");
    const ids = z.array(z.number().int().positive()).max(100);
    const body = parse(
      z.object({ adminUserIds: ids, allowedUserIds: ids, notify: z.enum(["linked", "all"]), verbosity: z.enum(["minimal", "normal"]) }),
      req.body,
    );
    setSetting(d, "telegram", body, actorOf(u));
    return { settings: d.telegram?.settings() ?? body };
  });

  app.post("/api/telegram/verify", async (req) => {
    requirePerm(req, "brain:manage");
    if (!d.telegram) throw badRequest("Telegram sozlanmagan");
    const status = await d.telegram.verify();
    if (status.mode === "webhook") await d.telegram.webhookInfo().catch(() => undefined);
    return { status };
  });

  // Public endpoint for Telegram's webhook calls: no session; authenticated by the secret header only.
  // Unknown/forged callers get a bare 404 so the endpoint does not reveal whether webhook mode is on.
  app.post("/api/telegram/webhook", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const bot = d.telegram;
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (!bot || !bot.acceptsWebhook(typeof secret === "string" ? secret : undefined)) return reply.status(404).send();
    const body = parse(z.object({ update_id: z.number().int().nonnegative() }).passthrough(), req.body);
    // handleUpdate never throws (errors are recorded per update); 200 tells Telegram not to redeliver.
    await bot.receive(body as Parameters<typeof bot.receive>[0]);
    return { ok: true };
  });
};
