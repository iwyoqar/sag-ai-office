import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TASK_PRIORITIES } from "@sag/shared";
import { type Deps, actorOf, parse, requirePerm } from "../app.js";
import {
  calendar, createRoutine, deleteRoutine, getRoutine, listRoutines, runOccurrence, setRoutineStatus, updateRoutine,
} from "../schedule/service.js";
import { badRequest, conflict } from "../lib/errors.js";

const Id = z.object({ id: z.string().min(1).max(80) });
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO sana bo'lishi kerak");

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  departmentId: z.string().nullish(),
  agentId: z.string().nullish(),
  rrule: z.string().trim().min(8).max(200),
  timezone: z.string().max(60).optional(),
  requiresApproval: z.boolean().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  startAt: iso.nullish(),
});

export const scheduleRoutes = (d: Deps) => async (app: FastifyInstance) => {
  app.get("/api/routines", async (req) => {
    requirePerm(req, "tasks:read");
    return { routines: listRoutines(d) };
  });

  app.get("/api/routines/:id", async (req) => {
    requirePerm(req, "tasks:read");
    return { routine: getRoutine(d, parse(Id, req.params).id) };
  });

  app.post("/api/routines", async (req, reply) => {
    const u = requirePerm(req, "tasks:manage");
    reply.status(201);
    return { routine: createRoutine(d, parse(Body, req.body), actorOf(u)) };
  });

  app.patch("/api/routines/:id", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    return { routine: updateRoutine(d, parse(Id, req.params).id, parse(Body.partial().strict(), req.body), actorOf(u)) };
  });

  app.post("/api/routines/:id/pause", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    return { routine: setRoutineStatus(d, parse(Id, req.params).id, "PAUSED", actorOf(u)) };
  });

  app.post("/api/routines/:id/resume", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    return { routine: setRoutineStatus(d, parse(Id, req.params).id, "ACTIVE", actorOf(u)) };
  });

  /** Run now — recorded as its own occurrence; a double click within the same second is ignored. */
  app.post("/api/routines/:id/run", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const run = runOccurrence(d, parse(Id, req.params).id, at, actorOf(u));
    if (!run) throw conflict("already_running", "Bu routine hozirgina ishga tushirildi");
    return { run };
  });

  app.delete("/api/routines/:id", async (req) => {
    const u = requirePerm(req, "tasks:manage");
    deleteRoutine(d, parse(Id, req.params).id, actorOf(u));
    return { ok: true };
  });

  app.get("/api/calendar", async (req) => {
    requirePerm(req, "tasks:read");
    const q = parse(z.object({ from: iso, to: iso, departmentId: z.string().optional(), agentId: z.string().optional() }), req.query);
    const from = new Date(q.from), to = new Date(q.to);
    if (!(from < to) || to.getTime() - from.getTime() > 62 * 86_400_000) throw badRequest("Oraliq noto'g'ri (ko'pi bilan 62 kun)");
    return { items: calendar(d, from, to, { departmentId: q.departmentId, agentId: q.agentId }) };
  });
};
