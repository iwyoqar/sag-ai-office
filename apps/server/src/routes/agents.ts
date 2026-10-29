import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, actorOf, parse, requirePerm } from "../app.js";
import {
  archiveAgent, createAgent, getAgentProfile, listAgents, setAgentConnectors, setLifecycle, stopAgent, transferAgent, updateAgent,
} from "../domain/agents.js";

const Id = z.object({ id: z.string().min(1).max(80) });
const name = z.string().trim().min(1).max(80);

const CreateBody = z.object({
  name, role: z.string().trim().min(1).max(120), departmentId: z.string().min(1),
  model: z.string().max(80).nullish(), skills: z.array(z.string().max(60)).max(30).optional(),
  responsibilities: z.string().max(4000).optional(), instructions: z.string().max(20000).optional(),
  connectorIds: z.array(z.string()).max(30).optional(),
  maxTokensPerTask: z.number().int().positive().nullish(), maxCostPerTaskUsd: z.number().positive().nullish(),
});

const PatchBody = CreateBody.pick({
  name: true, role: true, model: true, skills: true, responsibilities: true, maxTokensPerTask: true, maxCostPerTaskUsd: true,
}).partial().strict();

const Strategy = z
  .discriminatedUnion("strategy", [
    z.object({ strategy: z.literal("reassign"), toAgentId: z.string().min(1) }),
    z.object({ strategy: z.literal("cancel") }),
  ])
  .optional();

export const agentRoutes = (d: Deps) => async (app: FastifyInstance) => {
  app.get("/api/agents", async (req) => {
    requirePerm(req, "agents:read");
    const q = parse(z.object({ departmentId: z.string().optional(), includeArchived: z.enum(["true", "false"]).optional() }), req.query);
    return { agents: listAgents(d, { departmentId: q.departmentId, includeArchived: q.includeArchived === "true" }) };
  });

  app.get("/api/agents/:id", async (req) => {
    requirePerm(req, "agents:read");
    return getAgentProfile(d, parse(Id, req.params).id);
  });

  app.post("/api/agents", async (req, reply) => {
    const u = requirePerm(req, "agents:manage");
    reply.status(201);
    return { agent: createAgent(d, parse(CreateBody, req.body), actorOf(u)) };
  });

  app.patch("/api/agents/:id", async (req) => {
    const u = requirePerm(req, "agents:manage");
    return { agent: updateAgent(d, parse(Id, req.params).id, parse(PatchBody, req.body), actorOf(u)) };
  });

  app.put("/api/agents/:id/connectors", async (req) => {
    const u = requirePerm(req, "agents:manage");
    const body = parse(z.object({ connectorIds: z.array(z.string()).max(30) }), req.body);
    return setAgentConnectors(d, parse(Id, req.params).id, body.connectorIds, actorOf(u));
  });

  app.post("/api/agents/:id/pause", async (req) => {
    const u = requirePerm(req, "agents:control");
    return { agent: setLifecycle(d, parse(Id, req.params).id, "PAUSED", actorOf(u)) };
  });

  app.post("/api/agents/:id/resume", async (req) => {
    const u = requirePerm(req, "agents:control");
    return { agent: setLifecycle(d, parse(Id, req.params).id, "ACTIVE", actorOf(u)) };
  });

  app.post("/api/agents/:id/stop", async (req) => {
    const u = requirePerm(req, "agents:control");
    return stopAgent(d, parse(Id, req.params).id, actorOf(u));
  });

  app.post("/api/agents/:id/archive", async (req) => {
    const u = requirePerm(req, "agents:manage");
    const body = req.body as { strategy?: unknown } | undefined;
    // No strategy given → 409 with the open task list if there is anything to resolve.
    const how = body?.strategy === undefined ? undefined : parse(Strategy, body);
    return archiveAgent(d, parse(Id, req.params).id, how, actorOf(u));
  });

  app.post("/api/agents/:id/transfer", async (req) => {
    const u = requirePerm(req, "agents:manage");
    const body = parse(
      z.object({ departmentId: z.string().min(1), strategy: z.enum(["reassign", "cancel"]).optional(), toAgentId: z.string().optional() }),
      req.body,
    );
    const how = body.strategy ? parse(Strategy, { strategy: body.strategy, toAgentId: body.toAgentId }) : undefined;
    return transferAgent(d, parse(Id, req.params).id, body.departmentId, how, actorOf(u));
  });
};
