// W4 agent marketplace (HQ): templates, limits, hire checks and requests, archive-all. Permissions live in
// domain/marketplace.ts (admin = users:manage; department heads for their own departments).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, parse, requireUser } from "../app.js";
import {
  addVersion, approveRequest, approveVersion, archiveAll, archivePreview, cancelRequest, checkHire, createTemplate, getLimits,
  headDepartments, isAdmin, listRequests, listTemplates, rejectRequest, requestHire, retireTemplate, setLimit,
} from "../domain/marketplace.js";
import { forbidden } from "../lib/errors.js";

const Id = z.object({ id: z.string().min(1).max(120) });
const Tool = z.object({ connectorId: z.string().min(1).max(80), actions: z.array(z.enum(["read", "write"])).min(1) });
const Version = z.object({
  role: z.string().trim().min(1).max(120),
  responsibilities: z.string().max(4000).default(""),
  skills: z.array(z.string().max(80)).max(40).default([]),
  instructions: z.string().max(20000).default(""),
  tools: z.array(Tool).max(40).default([]),
  model: z.string().max(120).nullable().default(null),
  maxTokensPerTask: z.number().int().positive().nullable().default(null),
  estMonthlyMinor: z.number().int().min(0).default(0),
});
const Hire = z.object({ templateId: z.string().min(1).max(120), departmentId: z.string().min(1).max(80) });

export const marketplaceRoutes = (d: Deps) => async (app: FastifyInstance) => {
  app.get("/api/marketplace/templates", async (req) => ({ templates: listTemplates(d, requireUser(req)) }));

  app.post("/api/marketplace/templates", async (req, reply) => {
    const b = parse(z.object({
      name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(80),
      allowedDepartments: z.array(z.string().max(80)).max(50).default([]), version: Version,
    }), req.body);
    reply.status(201);
    return { template: createTemplate(d, requireUser(req), b) };
  });

  app.post("/api/marketplace/templates/:id/versions", async (req, reply) => {
    reply.status(201);
    return { template: addVersion(d, requireUser(req), parse(Id, req.params).id, parse(Version, req.body)) };
  });

  app.post("/api/marketplace/templates/:id/versions/:v/approve", async (req) => {
    const p = parse(z.object({ id: z.string().min(1).max(120), v: z.coerce.number().int().positive() }), req.params);
    return { template: approveVersion(d, requireUser(req), p.id, p.v) };
  });

  app.post("/api/marketplace/templates/:id/retire", async (req) => ({ template: retireTemplate(d, requireUser(req), parse(Id, req.params).id) }));

  app.get("/api/marketplace/limits", async (req) => ({ limits: getLimits(d, requireUser(req)) }));

  app.put("/api/marketplace/limits/:id", async (req) => {
    const b = parse(z.object({
      maxAgents: z.number().int().min(0).nullable().optional(),
      monthlyBudgetMinor: z.number().int().min(0).nullable().optional(),
      autoTemplates: z.array(z.string().max(120)).max(200).optional(),
    }), req.body);
    return { limit: setLimit(d, requireUser(req), parse(Id, req.params).id, b) };
  });

  // what would happen, without recording anything
  app.post("/api/marketplace/check", async (req) => {
    const u = requireUser(req);
    const b = parse(Hire, req.body);
    const admin = isAdmin(u);
    if (!admin && !headDepartments(d, u.id).includes(b.departmentId)) throw forbidden("Faqat o'z bo'limingiz uchun");
    return checkHire(d, { ...b, requester: admin ? "admin" : "head" });
  });

  app.get("/api/marketplace/requests", async (req) => ({ requests: listRequests(d, requireUser(req)) }));

  app.post("/api/marketplace/requests", async (req, reply) => {
    const b = parse(Hire.extend({ justification: z.string().trim().min(3).max(1000), override: z.boolean().optional() }), req.body);
    reply.status(201);
    return { request: requestHire(d, requireUser(req), b) };
  });

  app.post("/api/marketplace/requests/:id/approve", async (req) => {
    const b = parse(z.object({ override: z.boolean().optional() }), req.body ?? {});
    return { request: approveRequest(d, requireUser(req), parse(Id, req.params).id, !!b.override) };
  });

  app.post("/api/marketplace/requests/:id/reject", async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body);
    return { request: rejectRequest(d, requireUser(req), parse(Id, req.params).id, b.reason) };
  });

  app.post("/api/marketplace/requests/:id/cancel", async (req) => ({ request: cancelRequest(d, requireUser(req), parse(Id, req.params).id) }));

  app.get("/api/marketplace/archive-preview", async (req) => archivePreview(d, requireUser(req)));

  app.post("/api/marketplace/archive-all", async (req) => archiveAll(d, requireUser(req)));
};
