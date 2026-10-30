import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { ZodError, type ZodTypeAny, type z } from "zod";
import type { Permission } from "@sag/shared";
import type { Db } from "./db/db.js";
import { EventBus } from "./lib/events.js";
import { type AuthUser, userForSession } from "./lib/auth.js";
import { HttpError, forbidden, unauthorized } from "./lib/errors.js";
import type { Actor } from "./lib/audit.js";
import type { Ctx } from "./domain/context.js";
import { authRoutes } from "./routes/auth.js";
import { orgRoutes } from "./routes/org.js";
import { agentRoutes } from "./routes/agents.js";
import { taskRoutes } from "./routes/tasks.js";
import { eventRoutes } from "./routes/events.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { brainRoutes } from "./routes/brain.js";
import { scheduleRoutes } from "./routes/schedule.js";
import { peopleRoutes } from "./routes/people.js";
import { touchActivity } from "./domain/employees.js";
import type { TelegramBot } from "./telegram/bot.js";
import type { LlmSetup } from "./llm/index.js";
import type { AgentRunner } from "./agents/runner.js";
import { ConnectorHub, type ConnectorConfig } from "./connectors/hub.js";
import { connectorRoutes } from "./routes/connectors.js";
import { randomUUID } from "node:crypto";

export const SESSION_COOKIE = "sag_session";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export interface AppOptions {
  db: Db;
  sessionTtlHours?: number;
  cookieSecure?: boolean;
  logger?: boolean | object;
  llm?: LlmSetup;
  /** behind Render / Vercel: take the client IP from X-Forwarded-For (login rate limit) */
  trustProxy?: boolean;
  connectors?: ConnectorConfig;
  /** HTTP client for connector calls (tests inject a fake) */
  http?: typeof fetch;
}

export interface Deps extends Ctx {
  sessionTtlHours: number;
  cookieSecure: boolean;
  llm: LlmSetup;
  /** set by the process that runs agents (absent in API-only tests) */
  runner?: AgentRunner;
  llmHealth?: { ok: boolean; model: string; detail?: string; checkedAt: string };
  telegram?: TelegramBot;
  connectors: ConnectorHub;
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requirePerm(req: FastifyRequest, perm: Permission): AuthUser {
  const u = requireUser(req);
  if (!u.permissions.includes(perm)) throw forbidden();
  return u;
}

export const actorOf = (u: AuthUser): Actor => ({ type: "user", id: u.id });

export async function buildApp(opts: AppOptions) {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? false,
    genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
    bodyLimit: 1_000_000,
  });
  const bus = new EventBus(opts.db);
  const deps: Deps = {
    db: opts.db, bus,
    sessionTtlHours: opts.sessionTtlHours ?? 24 * 7,
    cookieSecure: opts.cookieSecure ?? false,
    llm: opts.llm ?? { client: null, pricing: { inputPerM: 0, outputPerM: 0 }, reason: "LLM sozlanmagan" },
  } as Deps;
  deps.connectors = new ConnectorHub(deps, opts.connectors ?? { publicUrl: "http://localhost:5173", google: {} }, {
    llm: () => deps.llm.client, telegram: () => deps.telegram, http: opts.http,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 10 } });
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    req.user = userForSession(opts.db, req.cookies[SESSION_COOKIE]);
    if (req.user) touchActivity(deps, req.user.id);
  });

  app.setErrorHandler((err, req, reply: FastifyReply) => {
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: { code: "validation", message: "Noto'g'ri ma'lumot", details: err.issues }, requestId: req.id });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.status(status).send({ error: { code: "bad_request", message: err.message }, requestId: req.id });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Server xatosi. So'rov ID: " + req.id }, requestId: req.id });
  });

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString(), subscribers: bus.subscriberCount }));

  await app.register(authRoutes(deps));
  await app.register(orgRoutes(deps));
  await app.register(agentRoutes(deps));
  await app.register(taskRoutes(deps));
  await app.register(peopleRoutes(deps));
  await app.register(connectorRoutes(deps));
  await app.register(eventRoutes(deps));
  await app.register(runtimeRoutes(deps));
  await app.register(brainRoutes(deps));
  await app.register(scheduleRoutes(deps));

  return { app, deps };
}
