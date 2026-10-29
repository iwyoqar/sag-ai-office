import { describe, expect, it } from "vitest";
import { ADMIN_PW, addUser, client, loginCookie, makeApp } from "./helpers.js";

describe("authentication", () => {
  it("rejects unauthenticated access to protected routes", async () => {
    const { app } = await makeApp();
    for (const url of ["/api/agents", "/api/tasks", "/api/floors", "/api/stats", "/api/auth/me", "/api/audit"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("logs in with an httpOnly session cookie and logs out", async () => {
    const { app, db } = await makeApp();
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PW } });
    expect(r.statusCode).toBe(200);
    const c = r.cookies.find((x) => x.name === "sag_session")!;
    expect(c.httpOnly).toBe(true);
    expect(r.body).not.toContain("password_hash");
    // only a hash of the token is stored
    expect(db.get("SELECT 1 FROM sessions WHERE token_hash = ?", c.value)).toBeUndefined();

    const api = client(app, `sag_session=${c.value}`);
    expect((await api.get("/api/auth/me")).body.user.roles).toEqual(["admin"]);
    await api.post("/api/auth/logout");
    expect((await api.get("/api/auth/me")).status).toBe(401);
  });

  it("rejects wrong passwords and rate-limits repeated attempts", async () => {
    const { app } = await makeApp();
    const bad = () => app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "nope" } });
    for (let i = 0; i < 5; i++) expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(429);
  });

  it("does not leak secrets into the audit log", async () => {
    const { app, db } = await makeApp();
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "wrong-secret-123" } });
    const rows = db.all<{ metadata: string }>("SELECT metadata FROM audit_logs");
    expect(rows.some((r) => r.metadata.includes("wrong-secret-123"))).toBe(false);
  });
});

describe("authorization", () => {
  it("applies role permissions", async () => {
    const { app, db } = await makeApp();
    const viewer = await addUser(db, "vera", "viewer");
    const member = await addUser(db, "mark", "member");
    const hr = await addUser(db, "hana", "hr");
    const v = client(app, await loginCookie(app, viewer.username, viewer.password));
    const m = client(app, await loginCookie(app, member.username, member.password));
    const h = client(app, await loginCookie(app, hr.username, hr.password));

    expect((await v.get("/api/agents")).status).toBe(200);
    expect((await v.post("/api/tasks", { title: "x", departmentId: "it" })).status).toBe(403);
    expect((await m.post("/api/tasks", { title: "x", departmentId: "it" })).status).toBe(201);
    expect((await m.post("/api/agents", { name: "N", role: "R", departmentId: "it" })).status).toBe(403);
    expect((await h.post("/api/agents", { name: "N", role: "R", departmentId: "it" })).status).toBe(201);
    expect((await m.get("/api/audit")).status).toBe(403);
    expect((await m.post("/api/agents/it-aziz/pause")).status).toBe(403);
  });

  it("lets a member edit/cancel only their own tasks", async () => {
    const { app, db } = await makeApp();
    const a = await addUser(db, "ann", "member");
    const b = await addUser(db, "bob", "member");
    const ca = client(app, await loginCookie(app, a.username, a.password));
    const cb = client(app, await loginCookie(app, b.username, b.password));
    const t = (await ca.post("/api/tasks", { title: "mine", departmentId: "sales" })).body.task;
    expect((await cb.post(`/api/tasks/${t.id}/cancel`)).status).toBe(403);
    expect((await cb.patch(`/api/tasks/${t.id}`, { title: "hijack" })).status).toBe(403);
    expect((await ca.patch(`/api/tasks/${t.id}`, { title: "renamed" })).body.task.title).toBe("renamed");
    expect((await ca.post(`/api/tasks/${t.id}/cancel`)).body.task.status).toBe("CANCELLED");
  });
});
