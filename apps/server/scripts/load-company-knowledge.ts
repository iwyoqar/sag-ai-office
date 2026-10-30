// Loads the company profile into The Brain through the running API (so versioning, embeddings and audit apply):
//  - docs/company/kompaniya-haqida.md → global instruction "Kompaniya haqida" (given to every agent)
//  - the other docs/company/*.md      → company-wide knowledge documents (re-upload = new version)
// Usage: tsx scripts/load-company-knowledge.ts [apiBase]   (credentials: ADMIN_USERNAME / ADMIN_PASSWORD from .env)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const base = process.argv[2] ?? "http://127.0.0.1:4000";
const username = process.env.ADMIN_USERNAME ?? "admin";
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error("ADMIN_PASSWORD is not set");

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error(`login failed (${login.status}) — the admin password may have been changed in the app`);
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const dir = join(root, "docs/company");
const about = readFileSync(join(dir, "kompaniya-haqida.md"), "utf8").trim();
const ins = await fetch(`${base}/api/instructions`, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ scope: "GLOBAL", scopeId: null, title: "Kompaniya haqida", content: about }),
});
console.log("instruction 'Kompaniya haqida':", ins.status, ins.ok ? "saved" : await ins.text());

const titles: Record<string, string> = {
  "sag-holding-profili.md": "SAG Holding — kompaniya profili",
  "ishlab-chiqarish-va-uskunalar.md": "SAG gilam zavodi — ishlab chiqarish va uskunalar",
  "kolleksiyalar-va-dizayn.md": "SAG gilam kolleksiyalari va dizayn",
};
for (const f of readdirSync(dir).filter((x) => x.endsWith(".md") && x !== "kompaniya-haqida.md")) {
  const fd = new FormData();
  fd.append("title", titles[f] ?? f.replace(/\.md$/, ""));
  fd.append("file", new Blob([readFileSync(join(dir, f))], { type: "text/markdown" }), f);
  const r = await fetch(`${base}/api/knowledge`, { method: "POST", headers: { cookie }, body: fd });
  const body = (await r.json().catch(() => ({}))) as { document?: { chunks: number; version: number; duplicate?: boolean }; error?: { message: string } };
  console.log(`${f}:`, r.status, body.document ? `${body.document.chunks} chunks, v${body.document.version}${body.document.duplicate ? " (unchanged)" : ""}` : body.error?.message);
}
await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
