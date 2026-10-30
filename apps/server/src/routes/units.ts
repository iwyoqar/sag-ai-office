import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, parse, requireUser } from "../app.js";
import { AttemptLimiter } from "../lib/auth.js";
import { HttpError } from "../lib/errors.js";
import {
  DATA_CLASSES, activateAccount, addUnitEmployee, approveAgreement, assignDirector, createUnitTask, listAgreements, listUnitEmployees,
  listUnitTasks, moveUnitTask, network, proposeAgreement, reissueInvitation, revokeAgreement, unitOverview, updateUnitEmployee,
} from "../domain/units.js";

const Id = z.string().min(1).max(80);
const UnitParams = z.object({ unitId: Id });
const UnitUserParams = z.object({ unitId: Id, userId: Id });
const UnitTaskParams = z.object({ unitId: Id, taskId: Id });
const StaffRole = z.enum(["unit_manager", "unit_staff"]);
const DataClass = z.enum(DATA_CLASSES as [string, ...string[]]);

/** Business units (stores). Every handler checks the caller's unit access in domain/units.ts. */
export const unitRoutes = (d: Deps) => async (app: FastifyInstance) => {
  const limiter = new AttemptLimiter(10, 60_000);

  // one-time activation of a pending account (director or employee); no session needed
  app.post("/api/auth/activate", async (req) => {
    if (!limiter.allow(req.ip)) throw new HttpError(429, "too_many_attempts", "Juda ko'p urinish. Bir daqiqadan keyin qayta urinib ko'ring.");
    const body = parse(z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(256) }), req.body);
    return { ok: true, ...(await activateAccount(d, body.token, body.password)) };
  });

  app.get("/api/units", async (req) => ({ network: network(d, requireUser(req)) }));

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
      priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
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

  // ---- data-sharing agreements
  app.get("/api/units/:unitId/agreements", async (req) => ({
    agreements: listAgreements(d, requireUser(req), parse(UnitParams, req.params).unitId),
  }));
  app.post("/api/units/:unitId/agreements", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(z.object({
      granteeNodeId: Id, dataClasses: z.array(DataClass).min(1).max(DATA_CLASSES.length), level: z.enum(["AGGREGATE", "DETAIL"]),
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
