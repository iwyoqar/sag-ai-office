// T1 Unified Task Engine routes: the same endpoints for people's and AI tasks. Everything is authorised in
// domain/taskEngine.ts (visibility, ownership, assignee scope, lifecycle rules); the app.ts by-id hook already turns
// another unit's task id into 404 on these /api/tasks/:id paths.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ASSIGNEE_TYPES, ASSIGNMENT_ROLES, TASK_LIFECYCLES } from "@sag/shared";
import { type Deps, parse, requirePerm } from "../app.js";
import { assign, release, respond, transition, view } from "../domain/taskEngine.js";

const Id = z.object({ id: z.string().min(1).max(80) });
const AssignmentId = Id.extend({ assignmentId: z.string().min(1).max(80) });
const version = z.number().int().min(0).optional();
const reason = z.string().trim().max(2000).optional();

export const taskEngineRoutes = (d: Deps) => async (app: FastifyInstance) => {
  app.get("/api/tasks/:id/engine", async (req) => {
    const u = requirePerm(req, "tasks:read");
    return view(d, u, parse(Id, req.params).id);
  });

  /** Lifecycle transition: { to, reason?, version? } — reason is required for BLOCKED and REVISION. */
  app.post("/api/tasks/:id/lifecycle", async (req) => {
    const u = requirePerm(req, "tasks:read");
    const b = parse(z.object({ to: z.enum(TASK_LIFECYCLES), reason, version }).strict(), req.body);
    return transition(d, u, parse(Id, req.params).id, b);
  });

  app.post("/api/tasks/:id/assignments", async (req) => {
    const u = requirePerm(req, "tasks:read");
    const b = parse(z.object({
      assigneeType: z.enum(ASSIGNEE_TYPES), assigneeId: z.string().min(1).max(80), role: z.enum(ASSIGNMENT_ROLES), version,
    }).strict(), req.body);
    return assign(d, u, parse(Id, req.params).id, b);
  });

  app.post("/api/tasks/:id/assignments/:assignmentId/release", async (req) => {
    const u = requirePerm(req, "tasks:read");
    const p = parse(AssignmentId, req.params);
    return release(d, u, p.id, p.assignmentId, parse(z.object({ reason, version }).strict().optional(), req.body ?? undefined) ?? {});
  });

  app.post("/api/tasks/:id/assignments/:assignmentId/accept", async (req) => {
    const u = requirePerm(req, "tasks:read");
    const p = parse(AssignmentId, req.params);
    return respond(d, u, p.id, p.assignmentId, true);
  });

  app.post("/api/tasks/:id/assignments/:assignmentId/decline", async (req) => {
    const u = requirePerm(req, "tasks:read");
    const p = parse(AssignmentId, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(1).max(2000) }).strict(), req.body);
    return respond(d, u, p.id, p.assignmentId, false, b.reason);
  });
};
