import type { FastifyInstance } from "fastify";
import type { OfficeEvent } from "@sag/shared";
import { type Deps, SESSION_COOKIE, requirePerm } from "../app.js";
import { HQ_UNIT } from "../domain/units.js";
import { type AuthUser, userForSession } from "../lib/auth.js";
import { canSeeTask, has, taskRef } from "../domain/access.js";

// A real named event (not an SSE comment), so clients can detect a silently dead stream behind proxies.
const HEARTBEAT_MS = 20_000;

/**
 * Server-Sent Events. On (re)connect the client sends Last-Event-ID and gets every event it missed
 * from task_events, so a browser reload or server restart never loses state.
 */
export const eventRoutes = (d: Deps) => async (app: FastifyInstance) => {
  const open = new Set<import("node:http").ServerResponse>();
  // Long-lived streams would otherwise keep a graceful shutdown waiting.
  app.addHook("preClose", async () => {
    for (const res of open) res.end();
  });

  app.get("/api/events", async (req, reply) => {
    let u: AuthUser = requirePerm(req, "tasks:read");
    // Task visibility per stream, refreshed with the session check (permissions may change while it is open).
    let seen = new Map<string, boolean>();
    const seesTask = (id: string) => {
      let v = seen.get(id);
      if (v === undefined) {
        const r = taskRef(d, id);
        v = !!r && canSeeTask(d, u, r);
        seen.set(id, v);
      }
      return v;
    };
    // Every event reaches only people who may see what it is about: personal notices their audience, people's
    // work its audience (or unit-wide readers), AI task events those who can see the task. Agent status without a
    // task is public — it is what the 3D office shows.
    const allowed = (e: OfficeEvent) => {
      // the company-wide stream is HQ's; other units' activity never reaches it
      if (e.unitId && e.unitId !== HQ_UNIT) return false;
      const aud = e.data?.audience as string[] | undefined;
      if (e.type === "notification.created") return !!aud?.includes(u.id);
      if (e.data?.human) return has(u, "tasks:read_all") || has(u, "tasks:assign_any") || !!aud?.includes(u.id);
      if (e.taskId) return seesTask(e.taskId);
      if (e.type === "connector.activity") return has(u, "brain:manage");
      return true;
    };
    const header = req.headers["last-event-id"];
    const q = req.query as { since?: string };
    const since = Number((Array.isArray(header) ? header[0] : header) ?? q.since ?? 0) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // filtered events still advance the client's Last-Event-ID (an id-only frame dispatches nothing)
    const send = (e: OfficeEvent) => !allowed(e) ? res.write(`id: ${e.id}\n\n`) : res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.write("retry: 3000\n\n");

    // Subscribe before replaying so nothing emitted in between is lost; skip duplicates by id.
    let last = since;
    const queue: OfficeEvent[] = [];
    let replaying = true;
    const unsubscribe = d.bus.subscribe((e) => {
      if (replaying) queue.push(e);
      else if (e.id > last) { last = e.id; send(e); }
    });
    if (since > 0) for (const e of d.bus.since(since)) { last = e.id; send(e); }
    else last = (d.db.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) id FROM task_events")?.id ?? 0);
    replaying = false;
    for (const e of queue) if (e.id > last) { last = e.id; send(e); }
    res.write(`event: ready\ndata: ${JSON.stringify({ lastEventId: last })}\n\n`);

    // The heartbeat doubles as the session check: logout, expiry or deactivation ends the stream.
    const cookie = req.cookies[SESSION_COOKIE];
    const hb = setInterval(() => {
      const fresh = userForSession(d.db, cookie);
      if (!fresh || !fresh.permissions.includes("tasks:read")) return void res.end();
      u = fresh;
      seen = new Map();
      res.write("event: ping\ndata: {}\n\n");
    }, HEARTBEAT_MS);
    open.add(res);
    res.on("close", () => {
      clearInterval(hb);
      unsubscribe();
      open.delete(res);
    });
  });
};
