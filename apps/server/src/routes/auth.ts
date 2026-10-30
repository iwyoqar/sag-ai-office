import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, SESSION_COOKIE, parse, requirePerm, requireUser } from "../app.js";
import { createSession, destroySession, login, sha } from "../lib/auth.js";
import { LoginThrottle } from "../lib/throttle.js";
import { changeOwnPassword, createUser, listUsers, resetPassword, updateUser } from "../domain/users.js";
import { actorOf } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { managedDepartments } from "../domain/access.js";

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

export const authRoutes = (d: Deps) => async (app: FastifyInstance) => {
  // req.ip is the socket address unless a configured trusted proxy reported the client (see AppOptions.trustProxy)
  const throttle = new LoginThrottle(d.db);
  const tooMany = (reply: { header: (k: string, v: string) => unknown }, ms: number) => {
    const s = Math.max(1, Math.ceil(ms / 1000));
    reply.header("retry-after", String(s));
    return new HttpError(429, "too_many_attempts", `Juda ko'p urinish. ${s} soniyadan keyin qayta urinib ko'ring.`, { retryAfterSeconds: s });
  };

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(LoginBody, req.body);
    throttle.prune();
    const wait = throttle.retryAfterMs(body.username, req.ip);
    if (wait > 0) {
      audit(d.db, { type: "system", id: null }, "auth.login_throttled", { type: "user", id: null }, { username: body.username, ip: req.ip });
      throw tooMany(reply, wait);
    }
    const user = await login(d.db, body.username, body.password);
    if (!user) {
      const lockMs = throttle.fail(body.username, req.ip);
      audit(d.db, { type: "system", id: null }, "auth.login_failed", { type: "user", id: null }, { username: body.username, ip: req.ip, lockMs });
      throw new HttpError(401, "invalid_credentials", "Login yoki parol noto'g'ri");
    }
    throttle.succeed(body.username);
    const s = createSession(d.db, user.id, d.sessionTtlHours);
    d.db.run("UPDATE users SET last_login_at = ? WHERE id = ?", new Date().toISOString(), user.id);
    audit(d.db, { type: "user", id: user.id }, "auth.login", { type: "user", id: user.id }, { ip: req.ip });
    reply.setCookie(SESSION_COOKIE, s.token, {
      httpOnly: true, sameSite: "lax", secure: d.cookieSecure, path: "/", expires: new Date(s.expiresAt),
    });
    return { user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    destroySession(d.db, req.cookies[SESSION_COOKIE]);
    if (req.user) audit(d.db, { type: "user", id: req.user.id }, "auth.logout", { type: "user", id: req.user.id });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const user = requireUser(req);
    return { user: { ...user, managedDepartments: managedDepartments(user) } };
  });

  app.post("/api/auth/password", async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) }), req.body);
    const raw = req.cookies[SESSION_COOKIE];
    await changeOwnPassword(d, u.id, body.current, body.next, raw ? sha(raw) : undefined);
    return { ok: true };
  });

  // ---- user management (admin)
  const Uid = z.object({ id: z.string().min(1).max(80) });
  app.get("/api/users", async (req) => {
    requirePerm(req, "users:manage");
    return { users: listUsers(d) };
  });
  app.post("/api/users", async (req, reply) => {
    const u = requirePerm(req, "users:manage");
    const body = parse(z.object({
      username: z.string().min(3).max(32), displayName: z.string().max(80).default(""),
      password: z.string().min(1).max(256), roles: z.array(z.string()).min(1).max(5),
    }), req.body);
    reply.status(201);
    return { user: await createUser(d, body, actorOf(u)) };
  });
  app.patch("/api/users/:id", async (req) => {
    const u = requirePerm(req, "users:manage");
    const body = parse(z.object({ displayName: z.string().max(80).optional(), roles: z.array(z.string()).max(5).optional(), isActive: z.boolean().optional() }).strict(), req.body);
    return { user: updateUser(d, parse(Uid, req.params).id, body, actorOf(u)) };
  });
  app.post("/api/users/:id/password", async (req) => {
    const u = requirePerm(req, "users:manage");
    const body = parse(z.object({ password: z.string().min(1).max(256) }), req.body);
    await resetPassword(d, parse(Uid, req.params).id, body.password, actorOf(u));
    return { ok: true };
  });

  app.get("/api/audit", async (req) => {
    requirePerm(req, "audit:read");
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), targetId: z.string().optional() }), req.query);
    // HQ audit: platform and HQ entries plus SAG-owned units; franchise activity stays with the franchise
    const scope = `(business_unit_id IS NULL OR business_unit_id IN (SELECT id FROM org_nodes WHERE business_type = 'SAG_BRANCH'))`;
    const where = q.targetId ? `WHERE ${scope} AND target_id = ?` : `WHERE ${scope}`;
    const params = q.targetId ? [q.targetId, q.limit] : [q.limit];
    return {
      items: d.db.all(
        `SELECT id, actor_type actorType, actor_id actorId, action, target_type targetType, target_id targetId,
                correlation_id correlationId, metadata, created_at createdAt FROM audit_logs ${where} ORDER BY id DESC LIMIT ?`,
        ...params,
      ),
    };
  });
};
