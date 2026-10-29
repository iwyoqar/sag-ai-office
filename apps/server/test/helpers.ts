import { Db } from "../src/db/db.js";
import { seed } from "../src/db/seed.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/passwords.js";
import { uid } from "../src/lib/ids.js";
import type { Role } from "@sag/shared";

export const ADMIN_PW = "test-admin-pass";

export async function makeApp(path = ":memory:") {
  const db = new Db(path);
  db.migrate();
  await seed(db, { adminPassword: ADMIN_PW });
  const { app, deps } = await buildApp({ db });
  await app.ready();
  return { app, db, deps };
}

export async function addUser(db: Db, username: string, role: Role, password = "pw-" + username) {
  const id = uid("usr");
  db.run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)",
    id, username, username, await hashPassword(password), new Date().toISOString());
  db.run("INSERT INTO user_roles VALUES (?, ?)", id, role);
  return { id, username, password };
}

type App = Awaited<ReturnType<typeof makeApp>>["app"];

export async function loginCookie(app: App, username: string, password: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  if (r.statusCode !== 200) throw new Error(`login failed ${r.statusCode} ${r.body}`);
  const c = r.cookies.find((x) => x.name === "sag_session");
  return `sag_session=${c!.value}`;
}

/** Small request helper bound to a session cookie. */
export function client(app: App, cookie: string) {
  const call = async (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as object, headers: { cookie } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p?: unknown) => call("POST", u, p ?? {}),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
  };
}

export async function adminClient(app: App) {
  return client(app, await loginCookie(app, "admin", ADMIN_PW));
}
