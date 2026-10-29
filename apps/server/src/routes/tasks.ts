import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskStatus } from "@sag/shared";
import { type Deps, actorOf, parse, requirePerm } from "../app.js";
import {
  cancelTask, createTask, getTask, getTaskDetail, listTasks, reassignTask, retryTask, transitionTask, updateTask,
} from "../domain/tasks.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { canSeeTask, taskRef } from "../domain/access.js";

const Id = z.object({ id: z.string().min(1).max(80) });

/** UI filter groups → statuses. */
const GROUPS: Record<string, TaskStatus[]> = {
  ALL: [],
  BACKLOG: ["BACKLOG", "QUEUED"],
  IN_PROGRESS: ["IN_PROGRESS"],
  WAITING: ["WAITING_FOR_DEPENDENCY", "WAITING_APPROVAL", "BLOCKED"],
  DONE: ["DONE"],
  FAILED: ["FAILED", "CANCELLED"],
};

const Limits = z.object({
  maxAgents: z.number().int().min(1).max(20).optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  maxTokens: z.number().int().min(1000).max(2_000_000).optional(),
  maxCostUsd: z.number().positive().max(100).optional(),
  maxDurationMs: z.number().int().min(10_000).max(6 * 3600_000).optional(),
}).strict();

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO sana bo'lishi kerak");

const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  departmentId: z.string().nullish(),
  agentId: z.string().nullish(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  deadline: isoDate.nullish(),
  parentId: z.string().nullish(),
  dependsOn: z.array(z.string()).max(50).optional(),
  limits: Limits.optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backlog: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  scheduledFor: isoDate.nullish(),
});

const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  deadline: isoDate.nullish(),
  limits: Limits.optional(),
}).strict();

export const taskRoutes = (d: Deps) => async (app: FastifyInstance) => {
  // People's tasks share the table but are read and changed only through /api/work (own workflow + access rules).
  const agentTaskOnly = (id: string) => {
    const r = taskRef(d, id);
    if (!r) throw notFound("Vazifa");
    if (r.kind === "human") throw conflict("human_task", "Bu xodim vazifasi — /api/work orqali boshqariladi");
  };

  app.get("/api/tasks", async (req) => {
    requirePerm(req, "tasks:read");
    const q = parse(
      z.object({
        group: z.enum(Object.keys(GROUPS) as [string, ...string[]]).default("ALL"),
        status: z.string().optional(),
        departmentId: z.string().optional(),
        agentId: z.string().optional(),
        parentId: z.string().optional(),
        topLevel: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      req.query,
    );
    const status = q.status
      ? parse(z.array(z.enum(TASK_STATUSES)), q.status.split(","))
      : GROUPS[q.group];
    return {
      tasks: listTasks(d, {
        status, departmentId: q.departmentId, agentId: q.agentId, limit: q.limit,
        parentId: q.topLevel === "true" ? null : q.parentId,
      }).filter((t) => t.kind !== "human"),
    };
  });

  app.get("/api/tasks/:id", async (req) => {
    const u = requirePerm(req, "tasks:read");
    const { id } = parse(Id, req.params);
    const r = taskRef(d, id);
    if (!r || !canSeeTask(d, u, r)) throw notFound("Vazifa");
    return getTaskDetail(d, id);
  });

  app.post("/api/tasks", async (req, reply) => {
    const u = requirePerm(req, "tasks:create");
    const body = parse(CreateBody, req.body);
    if (body.parentId) agentTaskOnly(body.parentId);
    reply.status(201);
    return { task: createTask(d, body, actorOf(u)) };
  });

  /** Creator may edit / cancel their own task; anything else needs tasks:manage. */
  const ownerOrManager = (req: Parameters<typeof requirePerm>[0], id: string) => {
    const u = requirePerm(req, "tasks:read");
    agentTaskOnly(id);
    if (u.permissions.includes("tasks:manage")) return u;
    if (getTask(d, id).createdBy === u.id && u.permissions.includes("tasks:create")) return u;
    throw forbidden();
  };

  app.patch("/api/tasks/:id", async (req) => {
    const { id } = parse(Id, req.params);
    const u = ownerOrManager(req, id);
    return { task: updateTask(d, id, parse(PatchBody, req.body), actorOf(u)) };
  });

  app.post("/api/tasks/:id/cancel", async (req) => {
    const { id } = parse(Id, req.params);
    const u = ownerOrManager(req, id);
    const body = parse(z.object({ reason: z.string().max(500).optional() }).optional(), req.body ?? undefined);
    return { task: cancelTask(d, id, actorOf(u), body?.reason) };
  });

  app.post("/api/tasks/:id/retry", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    agentTaskOnly(parse(Id, req.params).id);
    return { task: retryTask(d, parse(Id, req.params).id, actorOf(u)) };
  });

  app.post("/api/tasks/:id/reassign", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    const body = parse(z.object({ agentId: z.string().min(1) }), req.body);
    agentTaskOnly(parse(Id, req.params).id);
    return { task: reassignTask(d, parse(Id, req.params).id, body.agentId, actorOf(u)) };
  });

  app.post("/api/tasks/:id/transition", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    const body = parse(z.object({ to: z.enum(TASK_STATUSES), reason: z.string().max(500).optional() }), req.body);
    agentTaskOnly(parse(Id, req.params).id);
    return { task: transitionTask(d, parse(Id, req.params).id, body.to, actorOf(u), { reason: body.reason }) };
  });
};
