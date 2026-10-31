import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, parse, requireUser } from "../app.js";
import { LoginThrottle } from "../lib/throttle.js";
import { HttpError } from "../lib/errors.js";
import {
  DATA_CLASSES, activateAccount, addUnitEmployee, approveAgreement, assignDirector, createPlacedUnit, createUnitTask, listAgreements, listUnitEmployees,
  listUnitTasks, moveUnitTask, network, proposeAgreement, reissueInvitation, revokeAgreement, setUnitFunctions, unitOverview, updateUnitEmployee,
} from "../domain/units.js";
import { BUSINESS_FUNCTIONS } from "@sag/shared";
import { priorityInput } from "../lib/priority.js";
import { closeBudget, createBudget, decideBudget, listBudgets, listEntries, recordEntry, submitBudget, updateBudget } from "../domain/budgets.js";
import { addUnitDocument, listUnitDocuments, removeUnitDocument, searchUnitKnowledge } from "../domain/unitKnowledge.js";
import { grantUnitAgentConnectors, installUnitConnector, listUnitConnectors, setUnitConnectorEnabled } from "../connectors/installations.js";
import { embedderOf } from "../knowledge/semantic.js";
import { MAX_UPLOAD_BYTES } from "../knowledge/extract.js";
import { badRequest } from "../lib/errors.js";

const Id = z.string().min(1).max(80);
const UnitParams = z.object({ unitId: Id });
const UnitUserParams = z.object({ unitId: Id, userId: Id });
const UnitTaskParams = z.object({ unitId: Id, taskId: Id });
const UnitBudgetParams = z.object({ unitId: Id, budgetId: Id });
const Amount = z.string().trim().regex(/^-?\d{1,15}(\.\d{1,4})?$/, "summa: o'nli son matn ko'rinishida, masalan \"1250000.00\"");
const Category = z.enum(["OPERATIONS", "AI", "MARKETING", "PAYROLL", "INVENTORY", "OTHER"]);
const StaffRole = z.enum(["unit_manager", "unit_staff"]);
const DataClass = z.enum(DATA_CLASSES as [string, ...string[]]);

/** Business units (stores). Every handler checks the caller's unit access in domain/units.ts. */
export const unitRoutes = (d: Deps) => async (app: FastifyInstance) => {
  // failed activations per client address (trusted proxies only, see app.ts), stored in the database
  const activation = new LoginThrottle(d.db, { accountFree: 10, ipFree: 10, windowMs: 15 * 60_000, baseLockMs: 60_000, maxLockMs: 15 * 60_000 }, "activate:");

  // one-time activation of a pending account (director or employee); no session needed
  app.post("/api/auth/activate", async (req, reply) => {
    const wait = activation.retryAfterIpMs(req.ip);
    if (wait > 0) {
      reply.header("retry-after", String(Math.ceil(wait / 1000)));
      throw new HttpError(429, "too_many_attempts", "Juda ko'p urinish. Keyinroq qayta urinib ko'ring.");
    }
    const body = parse(z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(256) }), req.body);
    try {
      return { ok: true, ...(await activateAccount(d, body.token, body.password)) };
    } catch (e) {
      activation.failIp(req.ip);
      throw e;
    }
  });

  app.get("/api/units", async (req) => ({ network: network(d, requireUser(req)) }));

  // ---- new store / branch placed on the 3D world map (HQ platform admin; the slot is validated on the server)
  app.post("/api/units", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({
      name: z.string().trim().min(2).max(80),
      regionId: Id,
      businessType: z.enum(["SAG_BRANCH", "INDEPENDENT_DEALER"]),
      address: z.string().trim().max(200).nullish(),
      functions: z.array(z.enum(BUSINESS_FUNCTIONS)).min(1).max(BUSINESS_FUNCTIONS.length),
      description: z.string().trim().max(1000).nullish(),
      placement: z.object({ gridX: z.number().int().min(0).max(1000), gridZ: z.number().int().min(0).max(1000) }).strict(),
    }).strict(), req.body);
    reply.status(201);
    return { unit: createPlacedUnit(d, u, body) };
  });

  app.get("/api/units/:unitId", async (req) => {
    const u = requireUser(req);
    return { overview: unitOverview(d, u, parse(UnitParams, req.params).unitId) };
  });

  // ---- director (HQ platform admin): record the real person, hand over a one-time activation token
  app.post("/api/units/:unitId/director", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({
      displayName: z.string().trim().min(2).max(80),
      username: z.string().trim().regex(/^[a-z0-9._-]{3,40}$/i).optional(),
      email: z.string().email().max(120).nullish(),
    }).strict(), req.body);
    reply.status(201);
    return assignDirector(d, u, parse(UnitParams, req.params).unitId, body);
  });

  // ---- employees (unit director)
  app.get("/api/units/:unitId/employees", async (req) => ({
    employees: listUnitEmployees(d, requireUser(req), parse(UnitParams, req.params).unitId),
  }));
  app.post("/api/units/:unitId/employees", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({
      displayName: z.string().trim().min(2).max(80), jobTitle: z.string().trim().max(80).optional(), role: StaffRole,
      username: z.string().trim().regex(/^[a-z0-9._-]{3,40}$/i).optional(),
    }).strict(), req.body);
    reply.status(201);
    return addUnitEmployee(d, u, parse(UnitParams, req.params).unitId, body);
  });
  app.patch("/api/units/:unitId/employees/:userId", async (req) => {
    const u = requireUser(req);
    const p = parse(UnitUserParams, req.params);
    const body = parse(z.object({ role: StaffRole.optional(), status: z.enum(["active", "inactive"]).optional() }).strict(), req.body);
    return { employee: updateUnitEmployee(d, u, p.unitId, p.userId, body) };
  });
  app.post("/api/units/:unitId/employees/:userId/invitation", async (req, reply) => {
    const p = parse(UnitUserParams, req.params);
    reply.status(201);
    return reissueInvitation(d, requireUser(req), p.unitId, p.userId);
  });

  // ---- tasks inside the unit (people and the unit's AI Director)
  app.get("/api/units/:unitId/tasks", async (req) => ({
    tasks: listUnitTasks(d, requireUser(req), parse(UnitParams, req.params).unitId),
  }));
  app.post("/api/units/:unitId/tasks", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({
      title: z.string().trim().min(1).max(200), description: z.string().max(10_000).optional(),
      priority: priorityInput.optional(),
      assigneeUserId: Id.optional(), toAiDirector: z.boolean().optional(),
    }).strict(), req.body);
    reply.status(201);
    return { task: createUnitTask(d, u, parse(UnitParams, req.params).unitId, body) };
  });
  app.post("/api/units/:unitId/tasks/:taskId/transition", async (req) => {
    const p = parse(UnitTaskParams, req.params);
    const body = parse(z.object({ to: z.enum(["ACCEPTED", "IN_PROGRESS", "IN_REVIEW", "DONE", "CHANGES_REQUESTED", "CANCELLED"]) }), req.body);
    return { task: moveUnitTask(d, requireUser(req), p.unitId, p.taskId, body.to) };
  });

  // ---- functions (structure: HQ platform admins)
  app.put("/api/units/:unitId/functions", async (req) => {
    const body = parse(z.object({ functions: z.array(z.enum(BUSINESS_FUNCTIONS)).min(1).max(BUSINESS_FUNCTIONS.length) }).strict(), req.body);
    return { unit: setUnitFunctions(d, requireUser(req), parse(UnitParams, req.params).unitId, body.functions) };
  });

  // ---- budgets (UZS, integer minor units; amounts are decimal strings)
  app.get("/api/units/:unitId/budgets", async (req) => {
    const q = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.query);
    return { budgets: listBudgets(d, requireUser(req), parse(UnitParams, req.params).unitId, q.period) };
  });
  app.post("/api/units/:unitId/budgets", async (req, reply) => {
    const body = parse(z.object({ period: z.string(), category: Category, allocated: Amount, note: z.string().max(2000).optional() }).strict(), req.body);
    reply.status(201);
    return { budget: createBudget(d, requireUser(req), parse(UnitParams, req.params).unitId, body) };
  });
  app.patch("/api/units/:unitId/budgets/:budgetId", async (req) => {
    const p = parse(UnitBudgetParams, req.params);
    const body = parse(z.object({ allocated: Amount.optional(), note: z.string().max(2000).optional() }).strict(), req.body);
    return { budget: updateBudget(d, requireUser(req), p.unitId, p.budgetId, body) };
  });
  app.post("/api/units/:unitId/budgets/:budgetId/submit", async (req) => {
    const p = parse(UnitBudgetParams, req.params);
    return { budget: submitBudget(d, requireUser(req), p.unitId, p.budgetId) };
  });
  app.post("/api/units/:unitId/budgets/:budgetId/decide", async (req) => {
    const p = parse(UnitBudgetParams, req.params);
    const body = parse(z.object({ decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().max(2000).optional() }).strict(), req.body);
    return { budget: decideBudget(d, requireUser(req), p.unitId, p.budgetId, body.decision, body.reason) };
  });
  app.post("/api/units/:unitId/budgets/:budgetId/close", async (req) => {
    const p = parse(UnitBudgetParams, req.params);
    return { budget: closeBudget(d, requireUser(req), p.unitId, p.budgetId) };
  });
  app.get("/api/units/:unitId/budgets/:budgetId/entries", async (req) => {
    const p = parse(UnitBudgetParams, req.params);
    return { entries: listEntries(d, requireUser(req), p.unitId, p.budgetId) };
  });
  app.post("/api/units/:unitId/budgets/:budgetId/entries", async (req, reply) => {
    const p = parse(UnitBudgetParams, req.params);
    const body = parse(z.object({
      amount: Amount, currency: z.string().length(3), description: z.string().trim().min(1).max(500),
      occurredOn: z.string(), fxRate: z.string().max(40).optional(), fxRateDate: z.string().max(10).optional(), fxSource: z.string().max(80).optional(),
    }).strict(), req.body);
    reply.status(201);
    return { entry: recordEntry(d, requireUser(req), p.unitId, p.budgetId, body) };
  });

  // ---- the unit's own knowledge base (existing Brain/RAG pipeline, unit namespace)
  const embedder = embedderOf(d.llm.client);
  app.get("/api/units/:unitId/knowledge", async (req) => ({
    documents: listUnitDocuments(d, requireUser(req), parse(UnitParams, req.params).unitId),
  }));
  app.get("/api/units/:unitId/knowledge/search", async (req) => {
    const q = parse(z.object({ q: z.string().min(2).max(500) }), req.query);
    return searchUnitKnowledge(d, embedder, requireUser(req), parse(UnitParams, req.params).unitId, q.q);
  });
  app.post("/api/units/:unitId/knowledge", async (req, reply) => {
    const u = requireUser(req);
    const unitId = parse(UnitParams, req.params).unitId;
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
    const doc = await addUnitDocument(d, u, unitId, { title: fields.title, filename: file.filename, mime: file.mimetype, data: file.data, sourceLabel: fields.source || undefined });
    reply.status(doc.duplicate ? 200 : 201);
    return { document: doc };
  });
  app.delete("/api/units/:unitId/knowledge/:documentId", async (req) => {
    const p = parse(z.object({ unitId: Id, documentId: Id }), req.params);
    removeUnitDocument(d, requireUser(req), p.unitId, p.documentId);
    return { ok: true };
  });

  // ---- connectors installed for the unit (metadata only; credentials never leave the server)
  app.get("/api/units/:unitId/connectors", async (req) => ({
    connectors: listUnitConnectors(d, requireUser(req), parse(UnitParams, req.params).unitId),
  }));
  app.post("/api/units/:unitId/connectors", async (req, reply) => {
    const body = parse(z.object({ connectorId: z.string().min(1).max(40) }).strict(), req.body);
    reply.status(201);
    return { connector: installUnitConnector(d, requireUser(req), parse(UnitParams, req.params).unitId, body.connectorId) };
  });
  app.patch("/api/units/:unitId/connectors/:connectorId", async (req) => {
    const p = parse(z.object({ unitId: Id, connectorId: z.string().min(1).max(40) }), req.params);
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    return { connector: setUnitConnectorEnabled(d, requireUser(req), p.unitId, p.connectorId, body.enabled) };
  });
  app.put("/api/units/:unitId/agents/:agentId/connectors", async (req) => {
    const p = parse(z.object({ unitId: Id, agentId: Id }), req.params);
    const body = parse(z.object({ connectorIds: z.array(z.string().max(40)).max(20), writeIds: z.array(z.string().max(40)).max(20).optional() }).strict(), req.body);
    return { connectors: grantUnitAgentConnectors(d, requireUser(req), p.unitId, p.agentId, body.connectorIds, body.writeIds) };
  });

  // ---- data-sharing agreements
  app.get("/api/units/:unitId/agreements", async (req) => ({
    agreements: listAgreements(d, requireUser(req), parse(UnitParams, req.params).unitId),
  }));
  app.post("/api/units/:unitId/agreements", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({
      granteeNodeId: Id, dataClasses: z.array(DataClass).min(1).max(DATA_CLASSES.length), level: z.enum(["AGGREGATE", "DETAIL"]),
      access: z.enum(["READ", "READ_WRITE"]).optional(),
      contractRef: z.string().trim().min(1).max(120), validFrom: z.string().datetime().optional(), validTo: z.string().datetime().nullish(),
    }).strict(), req.body);
    reply.status(201);
    return { agreement: proposeAgreement(d, u, parse(UnitParams, req.params).unitId, body as Parameters<typeof proposeAgreement>[3]) };
  });
  app.post("/api/agreements/:id/approve", async (req) => ({
    agreement: approveAgreement(d, requireUser(req), parse(z.object({ id: Id }), req.params).id),
  }));
  app.post("/api/agreements/:id/revoke", async (req) => ({
    agreement: revokeAgreement(d, requireUser(req), parse(z.object({ id: Id }), req.params).id),
  }));
};
