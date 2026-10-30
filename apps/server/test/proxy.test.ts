// W0 — trusted proxies and login throttling: forwarded headers count only from configured proxies, and forged or
// rotating client addresses cannot get around the per-account limit. The throttle lives in the database.
import { describe, expect, it } from "vitest";
import { Db } from "../src/db/db.js";
import { seed } from "../src/db/seed.js";
import { buildApp, type AppOptions } from "../src/app.js";
import { trustedProxiesFrom } from "../src/lib/throttle.js";
import { ADMIN_PW } from "./helpers.js";

async function appWith(trustProxy: AppOptions["trustProxy"], db?: Db) {
  if (!db) {
    db = new Db(":memory:");
    db.migrate();
    await seed(db, { adminPassword: ADMIN_PW });
  }
  const { app } = await buildApp({ db, trustProxy });
  await app.ready();
  return { app, db };
}

type App = Awaited<ReturnType<typeof appWith>>["app"];
const loginAs = (app: App, o: { username?: string; password?: string; remote?: string; xff?: string }) =>
  app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { username: o.username ?? "admin", password: o.password ?? "wrong-password" },
    remoteAddress: o.remote ?? "203.0.113.5",
    headers: o.xff ? { "x-forwarded-for": o.xff } : {},
  });
/** The client IP the server recorded for the last failed login. */
const lastIp = (db: Db) =>
  JSON.parse(db.get<{ metadata: string }>("SELECT metadata FROM audit_logs WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1")!.metadata).ip;

describe("trusted proxy configuration", () => {
  it("parses TRUSTED_PROXIES; the legacy TRUST_PROXY=true means one hop, never 'everyone'", () => {
    expect(trustedProxiesFrom({})).toBe(false);
    expect(trustedProxiesFrom({ TRUST_PROXY: "true" })).toBe(1);
    expect(trustedProxiesFrom({ TRUSTED_PROXIES: "2" })).toBe(2);
    expect(trustedProxiesFrom({ TRUSTED_PROXIES: " 10.0.0.0/8,127.0.0.1 " })).toBe("10.0.0.0/8,127.0.0.1");
    expect(trustedProxiesFrom({ TRUSTED_PROXIES: "1", TRUST_PROXY: "false" })).toBe(1);
  });

  it("refuses to trust every sender", async () => {
    await expect(appWith(true as never)).rejects.toThrow(/forge/);
  });
});

describe("client IP from forwarded headers", () => {
  it("direct request (no trusted proxy): X-Forwarded-For is ignored, the socket address counts", async () => {
    const { app, db } = await appWith(false);
    await loginAs(app, { remote: "203.0.113.5", xff: "1.2.3.4" });
    expect(lastIp(db)).toBe("203.0.113.5");
  });

  it("behind one trusted hop: the address that proxy saw counts; forged left-most entries are ignored", async () => {
    const { app, db } = await appWith(1);
    await loginAs(app, { remote: "10.0.0.2", xff: "6.6.6.6, 198.51.100.7" });
    expect(lastIp(db)).toBe("198.51.100.7");
  });

  it("trusted proxy list: only listed peers may forward; anyone else is taken at their socket address", async () => {
    const { app, db } = await appWith("10.0.0.0/8");
    await loginAs(app, { remote: "10.1.2.3", xff: "198.51.100.7" });
    expect(lastIp(db)).toBe("198.51.100.7");
    await loginAs(app, { remote: "203.0.113.9", xff: "198.51.100.7" });
    expect(lastIp(db)).toBe("203.0.113.9");
  });
});

describe("login throttling", () => {
  it("rotating (forged or real) client addresses cannot get past the per-account limit", async () => {
    const { app } = await appWith(1);
    for (let i = 0; i < 5; i++)
      expect((await loginAs(app, { remote: `10.0.0.${i + 2}`, xff: `198.51.100.${i + 10}` })).statusCode).toBe(401);
    const r = await loginAs(app, { password: ADMIN_PW, remote: "10.0.0.99", xff: "192.0.2.200" });
    expect(r.statusCode).toBe(429); // locked even with the right password, from a fresh address
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("one address spraying many accounts hits the per-address ceiling", async () => {
    const { app } = await appWith(false);
    for (let i = 0; i < 30; i++) expect((await loginAs(app, { username: `user${i}` })).statusCode).toBe(401);
    expect((await loginAs(app, { username: "someone-else" })).statusCode).toBe(429);
    expect((await loginAs(app, { username: "someone-else", remote: "198.51.100.1" })).statusCode).toBe(401); // other address unaffected
  });

  it("a successful login clears the account counter; the lock survives a restart (stored in the database)", async () => {
    const env = await appWith(false);
    for (let i = 0; i < 4; i++) expect((await loginAs(env.app, {})).statusCode).toBe(401);
    expect((await loginAs(env.app, { password: ADMIN_PW })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await loginAs(env.app, {})).statusCode).toBe(401); // counter started over
    expect((await loginAs(env.app, {})).statusCode).toBe(401); // 5th failure locks
    await env.app.close();
    const again = await appWith(false, env.db); // "restart": new process state, same database
    expect((await loginAs(again.app, { password: ADMIN_PW })).statusCode).toBe(429);
    expect(env.db.get("SELECT 1 FROM audit_logs WHERE action = 'auth.login_throttled'")).toBeTruthy();
  });
});
