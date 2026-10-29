import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { adminClient, ADMIN_PW, makeApp } from "./helpers.js";
import { resolveRange, startOfTashkentDay } from "../src/domain/stats.js";
import { createTask, transitionTask } from "../src/domain/tasks.js";
import { SYSTEM } from "../src/lib/audit.js";

describe("stats", () => {
  it("uses Asia/Tashkent day boundaries", () => {
    // 2026-10-29 03:00 Tashkent == 2026-10-28 22:00 UTC
    const at = new Date("2026-10-28T22:00:00Z");
    expect(startOfTashkentDay(at).toISOString()).toBe("2026-10-28T19:00:00.000Z");
    const r = resolveRange("7d", undefined, undefined, at);
    expect(r.from).toBe("2026-10-22T19:00:00.000Z");
    const c = resolveRange("custom", "2026-10-01", "2026-10-02");
    expect(c).toEqual({ from: "2026-09-30T19:00:00.000Z", to: "2026-10-02T19:00:00.000Z" });
  });

  it("is computed from real rows (fresh office = zeros, not invented numbers)", async () => {
    const { app, deps } = await makeApp();
    const api = await adminClient(app);
    const fresh = (await api.get("/api/stats?range=today")).body.departments.find((d: { departmentId: string }) => d.departmentId === "marketing");
    expect(fresh).toMatchObject({ agents: 11, active: 0, idle: 11, inProgress: 0, completed: 0, tokens: 0, costUsd: 0, avgMinutes: null });

    const t1 = createTask(deps, { title: "a", agentId: "marketing-madina" }, SYSTEM);
    createTask(deps, { title: "b", agentId: "marketing-asal" }, SYSTEM);
    transitionTask(deps, t1.id, "IN_PROGRESS", SYSTEM);
    transitionTask(deps, t1.id, "DONE", SYSTEM);
    deps.db.run(
      "INSERT INTO usage_records (id, agent_id, department_id, task_id, model, input_tokens, output_tokens, cost_usd, is_estimate, created_at) VALUES ('u1','marketing-madina','marketing',?, 'm', 1000, 500, 0.02, 0, ?)",
      t1.id, new Date().toISOString(),
    );
    const s = (await api.get("/api/stats?range=today")).body.departments.find((d: { departmentId: string }) => d.departmentId === "marketing");
    expect(s).toMatchObject({ queued: 1, completed: 1, tokens: 1500, costUsd: 0.02 });
    expect(s.avgMinutes).not.toBeNull();
    expect((await api.get("/api/stats?range=custom")).status).toBe(400);
  });
});

describe("realtime events (SSE)", () => {
  it("streams new events and replays missed ones after reconnect", async () => {
    const { app, deps } = await makeApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: ADMIN_PW }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const read = async (res: Response, until: (s: string) => boolean) => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 3000;
      while (!until(buf) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      await reader.cancel();
      return buf;
    };

    // live
    const ctrl = new AbortController();
    const live = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctrl.signal });
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(() => createTask(deps, { title: "live one", agentId: "it-aziz" }, SYSTEM), 100);
    const got = await read(live, (s) => s.includes("live one"));
    expect(got).toContain("event: task.created");
    ctrl.abort();

    // missed while disconnected → replayed from task_events
    const lastId = Number(/id: (\d+)/.exec(got)![1]);
    createTask(deps, { title: "while away", agentId: "it-aziz" }, SYSTEM);
    const again = await fetch(`${base}/api/events`, { headers: { cookie, "last-event-id": String(lastId) } });
    const replay = await read(again, (s) => s.includes("event: ready"));
    expect(replay).toContain("while away");
    expect(replay).not.toContain("live one");

    const anon = await fetch(`${base}/api/events`);
    expect(anon.status).toBe(401);
    await app.close();
  }, 15_000); // real sockets + timers; slow under a parallel run
});
