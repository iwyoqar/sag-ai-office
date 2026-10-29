import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, SESSION_COOKIE, parse, requirePerm, requireUser } from "../app.js";
import { AttemptLimiter, createSession, destroySession, login } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

export const authRoutes = (d: Deps) => async (app: FastifyInstance) => {
  const limiter = new AttemptLimiter(5, 60_000);

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const key = `${req.ip}:${body.username.toLowerCase()}`;
    if (!limiter.allow(key)) throw new HttpError(429, "too_many_attempts", "Juda ko'p urinish. Bir daqiqadan keyin qayta urinib ko'ring.");
    const user = await login(d.db, body.username, body.password);
    if (!user) {
      audit(d.db, { type: "system", id: null }, "auth.login_failed", { type: "user", id: null }, { username: body.username, ip: req.ip });
      throw new HttpError(401, "invalid_credentials", "Login yoki parol noto'g'ri");
    }
    limiter.reset(key);
    const s = createSession(d.db, user.id, d.sessionTtlHours);
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

  app.get("/api/auth/me", async (req) => ({ user: requireUser(req) }));

  app.get("/api/audit", async (req) => {
    requirePerm(req, "audit:read");
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), targetId: z.string().optional() }), req.query);
    const where = q.targetId ? "WHERE target_id = ?" : "";
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
