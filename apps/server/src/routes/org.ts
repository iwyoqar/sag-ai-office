import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, parse, requirePerm } from "../app.js";
import { listConnectors, listDepartments, listFloors } from "../domain/org.js";
import { departmentStats, resolveRange, TZ } from "../domain/stats.js";
import { has, visibleTaskSql } from "../domain/access.js";

const StatsQuery = z.object({
  range: z.enum(["today", "7d", "30d", "custom"]).default("today"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const orgRoutes = (d: Deps) => async (app: FastifyInstance) => {
  app.get("/api/floors", async (req) => {
    requirePerm(req, "agents:read");
    return { floors: listFloors(d), departments: listDepartments(d) };
  });

  app.get("/api/connectors", async (req) => {
    requirePerm(req, "agents:read");
    return { connectors: listConnectors(d) };
  });

  app.get("/api/stats", async (req) => {
    const u = requirePerm(req, "tasks:read");
    const q = parse(StatsQuery, req.query);
    const range = resolveRange(q.range, q.from, q.to);
    // same boundaries as the task list: counts cover only tasks this person can see; usage/cost needs budget:read
    const view = { visible: visibleTaskSql(u), usage: has(u, "budget:read") };
    return { range: { ...range, kind: q.range, timezone: TZ }, departments: departmentStats(d, range, view) };
  });
};
