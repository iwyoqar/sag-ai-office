import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { ZodError, type ZodTypeAny, type z } from "zod";
import type { Permission } from "@sag/shared";
import type { Db } from "./db/db.js";
import { EventBus } from "./lib/events.js";
import { type AuthUser, userForSession } from "./lib/auth.js";
import { HttpError, forbidden, notFound, unauthorized } from "./lib/errors.js";
import { HQ_UNIT } from "./domain/units.js";
import { unitRoutes } from "./routes/units.js";
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
import { checkOrigin, parseOrigins } from "./lib/origin.js";

export const SESSION_COOKIE = "sag_session";

/** The only routes accounts of non-HQ units (stores) may call. */
const UNIT_ACCOUNT_ROUTES = ["/api/auth/", "/api/units", "/api/agreements/", "/api/notifications", "/api/health"];

/** HQ routes addressing one row by `:id`, and how to find that row's unit. */
const HQ_OWNED_BY_ID: [string, string][] = [
  ["/api/agents/:id", "SELECT business_unit_id u FROM agents WHERE id = ?"],
  ["/api/tasks/:id", "SELECT business_unit_id u FROM tasks WHERE id = ?"],
  ["/api/work/:id", "SELECT business_unit_id u FROM tasks WHERE id = ?"],
  ["/api/employees/:id", "SELECT home_unit_id u FROM users WHERE id = ?"],
  ["/api/users/:id", "SELECT home_unit_id u FROM users WHERE id = ?"],
  ["/api/departments/:id", "SELECT business_unit_id u FROM departments WHERE id = ?"],
  ["/api/approvals/:id", "SELECT COALESCE(t.business_unit_id, ag.business_unit_id) u FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN agents ag ON ag.id = a.agent_id WHERE a.id = ?"],
  ["/api/routines/:id", "SELECT COALESCE(ag.business_unit_id, d.business_unit_id) u FROM routines r LEFT JOIN agents ag ON ag.id = r.agent_id LEFT JOIN departments d ON d.id = r.department_id WHERE r.id = ?"],
];

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
  /**
   * Proxies whose X-Forwarded-For is believed (client IP for login throttling and audit): false (default), a hop
   * count, or a comma-separated list of IPs/CIDRs. `true` (trust any sender) is refused.
   */
  trustProxy?: false | number | string;
  connectors?: ConnectorConfig;
  /** HTTP client for connector calls (tests inject a fake) */
  http?: typeof fetch;
  /** origins allowed to send state-changing requests (CSRF protection); default: the connectors' public URL */
  allowedOrigins?: string[];
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
  if ((opts.trustProxy as unknown) === true) throw new Error("trustProxy: true would let any client forge its IP — give a hop count or proxy addresses");
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
    // Company-wide routes are HQ's. Accounts of other units (stores) work only through their unit routes.
    if (req.user && req.user.homeUnitId !== HQ_UNIT && !UNIT_ACCOUNT_ROUTES.some((p) => req.url.startsWith(p))) throw forbidden();
  });
  // CSRF: state-changing requests only from the app's own origin (lib/origin.ts). Runs before any handler.
  const origins = parseOrigins(opts.allowedOrigins ?? [opts.connectors?.publicUrl ?? "http://localhost:5173"]);
  app.addHook("onRequest", async (req) => {
    const h = (n: string) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v; };
    const r = checkOrigin({ method: req.method, url: req.url, origin: h("origin"), referer: h("referer"), secFetchSite: h("sec-fetch-site") }, origins);
    if (!r.ok) {
      req.log.warn({ reason: r.reason, origin: h("origin") ?? null }, "cross-origin request refused");
      throw new HttpError(403, "bad_origin", "So'rov ilovaning o'z sahifasidan kelmadi");
    }
  });
  // On HQ routes an id that belongs to another unit does not exist (no cross-unit reads or writes by id).
  app.addHook("preHandler", async (req) => {
    const route = req.routeOptions.url ?? "";
    const id = (req.params as { id?: string } | undefined)?.id;
    if (!id) return;
    const owner = HQ_OWNED_BY_ID.find(([prefix]) => route.startsWith(prefix));
    if (!owner) return;
    const row = opts.db.get<{ u: string }>(owner[1], id);
    if (row && row.u !== HQ_UNIT) throw notFound("Ma'lumot");
  });

  app.setErrorHandler((err, req, reply: FastifyReply) => {
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: { code: "validation", message: "Noto'g'ri ma'lumot", details: err.issues }, requestId: req.id });
    // database refused a reference to another business unit (triggers in 010_org_tree.sql)
    if (err instanceof Error && /cross_unit|org_tree_shape/.test(err.message))
      return reply.status(400).send({ error: { code: "cross_unit", message: "Boshqa biznes bo'limga tegishli ma'lumotga bog'lab bo'lmaydi" }, requestId: req.id });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.status(status).send({ error: { code: "bad_request", message: err.message }, requestId: req.id });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Server xatosi. So'rov ID: " + req.id }, requestId: req.id });
  });

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString(), subscribers: bus.subscriberCount }));

  // Readiness for the platform / monitoring: can we write, is the queue moving, are backups fresh. Public, so it
  // reports states and ages only — no names, paths, keys or error texts. 503 when not ready to serve.
  app.get("/api/ready", async (_req, reply) => {
    let writable = false;
    try {
      opts.db.tx(() => opts.db.get("SELECT 1"));
      writable = true;
    } catch { /* reported below */ }
    const oldestQueued = opts.db.get<{ at: string | null }>(
      "SELECT MIN(updated_at) at FROM tasks WHERE status = 'QUEUED' AND kind <> 'human' AND (scheduled_for IS NULL OR scheduled_for <= ?)", new Date().toISOString(),
    )?.at;
    const lastVerified = opts.db.get<{ at: string | null }>("SELECT MAX(verified_at) at FROM backup_runs WHERE status = 'verified'")?.at ?? null;
    const age = (iso: string | null | undefined) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 1000) : null);
    const body = {
      ok: writable,
      database: writable ? "writable" : "unavailable",
      worker: deps.runner ? (deps.runner.running ? "running" : "stopped") : "absent",
      queueLagSeconds: age(oldestQueued),
      lastVerifiedBackupAgeSeconds: age(lastVerified),
    };
    return reply.status(writable ? 200 : 503).send(body);
  });

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
  await app.register(unitRoutes(deps));

  return { app, deps };
}
