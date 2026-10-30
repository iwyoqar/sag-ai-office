// W0 — CSRF / Origin protection: state-changing requests only from the app's own origin; browsers' Origin and
// Sec-Fetch-Site decide; non-browser clients (no such headers) and the Telegram webhook keep working.
import { describe, expect, it } from "vitest";
import { checkOrigin, parseOrigins } from "../src/lib/origin.js";
import { ADMIN_PW, loginCookie, makeApp } from "./helpers.js";

const ALLOWED = parseOrigins(["http://localhost:5173", "https://sag-ai-office.vercel.app/"]);

describe("origin rule", () => {
  const post = (h: Partial<Parameters<typeof checkOrigin>[0]>) => checkOrigin({ method: "POST", url: "/api/tasks", ...h }, ALLOWED).ok;

  it("allows the app's own origins and safe methods; refuses other sites", () => {
    expect(post({ origin: "http://localhost:5173" })).toBe(true);
    expect(post({ origin: "https://sag-ai-office.vercel.app" })).toBe(true);
    expect(post({ origin: "https://evil.example" })).toBe(false);
    expect(post({ origin: "https://sag-ai-office.vercel.app.evil.example" })).toBe(false);
    expect(post({ origin: "null" })).toBe(false);
    expect(checkOrigin({ method: "GET", url: "/api/tasks", origin: "https://evil.example" }, ALLOWED).ok).toBe(true);
    for (const method of ["PUT", "PATCH", "DELETE"]) expect(checkOrigin({ method, url: "/x", origin: "https://evil.example" }, ALLOWED).ok).toBe(false);
  });

  it("falls back to Referer, then Sec-Fetch-Site; no browser headers at all = non-browser client", () => {
    expect(post({ referer: "http://localhost:5173/office?x=1" })).toBe(true);
    expect(post({ referer: "https://evil.example/page" })).toBe(false);
    expect(post({ referer: "not a url" })).toBe(false);
    expect(post({ secFetchSite: "cross-site" })).toBe(false);
    expect(post({ secFetchSite: "same-site" })).toBe(false);
    expect(post({ secFetchSite: "same-origin" })).toBe(true);
    expect(post({})).toBe(true);
  });

  it("exempts only server-to-server endpoints with their own secret", () => {
    expect(checkOrigin({ method: "POST", url: "/api/telegram/webhook", origin: "https://evil.example" }, ALLOWED).ok).toBe(true);
    expect(checkOrigin({ method: "POST", url: "/api/telegram/webhook-x", origin: "https://evil.example" }, ALLOWED).ok).toBe(false);
  });

  it("rejects malformed configuration", () => {
    expect(() => parseOrigins(["not-an-origin"])).toThrow(/invalid origin/);
  });
});

describe("origin check on the server", () => {
  it("blocks a cross-site login and a cross-site write with a valid session; the app's own page works", async () => {
    const { app, db } = await makeApp();
    const login = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN_PW }, headers });
    const evil = await login({ origin: "https://evil.example" });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe("bad_origin");
    expect((await login({ origin: "http://localhost:5173" })).statusCode).toBe(200);
    expect((await login({})).statusCode).toBe(200); // API client without browser headers

    const cookie = await loginCookie(app, "admin", ADMIN_PW);
    const create = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/tasks", payload: { title: "CSRF sinovi", agentId: "it-aziz" }, headers: { cookie, ...headers } });
    expect((await create({ origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await create({ "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect(db.get("SELECT 1 FROM tasks WHERE title = 'CSRF sinovi'")).toBeUndefined(); // refused before the handler
    expect((await create({ origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).statusCode).toBe(201);
    // reading is never blocked by the origin rule
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers: { cookie, origin: "https://evil.example" } })).statusCode).toBe(200);
  });

  it("the Telegram webhook is not subject to the browser origin rule (it has its own secret check)", async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: "POST", url: "/api/telegram/webhook", payload: {}, headers: { origin: "https://evil.example" } });
    expect(r.statusCode).not.toBe(403);
  });
});
