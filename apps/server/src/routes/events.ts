import type { FastifyInstance } from "fastify";
import type { OfficeEvent } from "@sag/shared";
import { type Deps, requirePerm } from "../app.js";

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
    requirePerm(req, "tasks:read");
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
    const send = (e: OfficeEvent) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
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

    const hb = setInterval(() => res.write("event: ping\ndata: {}\n\n"), HEARTBEAT_MS);
    open.add(res);
    res.on("close", () => {
      clearInterval(hb);
      unsubscribe();
      open.delete(res);
    });
  });
};
