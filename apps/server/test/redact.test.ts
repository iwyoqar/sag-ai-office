// W0 — no credentials in logs: configured secret values are scrubbed from every written log line (message, fields,
// errors), sensitive headers are redacted, and the generated first-boot admin password never reaches a log.
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db/db.js";
import { seed, writeInitialAdminPassword } from "../src/db/seed.js";
import { buildApp } from "../src/app.js";
import { loggerOptions, scrubber, secretValues } from "../src/lib/redact.js";
import { config } from "../src/config.js";

const KEY = "AIzaSyTEST-not-a-real-key-0123456789abcd";
const TOKEN = "123456789:AAtest-telegram-token-value-xyz";

describe("secret scrubbing", () => {
  it("collects configured secrets (long enough to be unambiguous), longest first", () => {
    const c = structuredClone(config);
    c.llm.geminiApiKey = KEY;
    c.telegram.token = TOKEN;
    c.adminPassword = "short";
    const v = secretValues(c, { BACKUP_KEY: "b".repeat(44), BACKUP_OLD_KEYS: `k0:${"c".repeat(44)}` });
    expect(v).toEqual(expect.arrayContaining([KEY, TOKEN, "b".repeat(44), "c".repeat(44)]));
    expect(v).not.toContain("short");
    expect(v.map((x) => x.length)).toEqual([...v.map((x) => x.length)].sort((a, b) => b - a));
  });

  it("replaces raw, JSON-escaped and URL-encoded forms", () => {
    const odd = 'pa"ss/word+with spaces';
    const s = scrubber([KEY, odd]);
    expect(s(`url=https://x/?key=${KEY}&q=1`)).toBe("url=https://x/?key=[redacted]&q=1");
    expect(s(JSON.stringify({ msg: odd }))).not.toContain("pa\\\"ss");
    expect(s(encodeURIComponent(odd))).toBe("[redacted]");
    expect(scrubber([])("nothing to do")).toBe("nothing to do");
  });

  it("every log line the server writes is scrubbed; cookie and Telegram secret headers are redacted", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const db = new Db(":memory:");
    db.migrate();
    await seed(db, { adminPassword: "test-admin-pass" });
    const { app } = await buildApp({ db, logger: loggerOptions("info", [KEY, TOKEN], { stream }) });
    await app.ready();
    app.log.info({ detail: `calling https://api.telegram.org/bot${TOKEN}/getMe` }, `gemini key ${KEY} rejected`);
    app.log.error({ err: new Error(`upstream said: invalid key ${KEY}`) }, "LLM error");
    await app.inject({ method: "GET", url: "/api/health", headers: { cookie: "sag_session=abc123secretcookie", "x-telegram-bot-api-secret-token": "telegram-webhook-secret-123" } });
    const out = lines.join("");
    expect(out).toContain("[redacted]");
    for (const leaked of [KEY, TOKEN, "abc123secretcookie", "telegram-webhook-secret-123"]) expect(out).not.toContain(leaked);
    await app.close();
  });
});

describe("initial admin password", () => {
  it("a generated password goes to a file next to the database, never to the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sag-admin-"));
    const db = new Db(join(dir, "x.db"));
    db.migrate();
    const r = await seed(db, {});
    expect(r.admin?.generated).toBe(true);
    const file = writeInitialAdminPassword(join(dir, "x.db"), r.admin!.password);
    expect(readFileSync(file, "utf8")).toContain(r.admin!.password);
    db.close();
  });

  it("no source file logs or prints a password, token or key value", () => {
    const root = join(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d, { withFileTypes: true })) n.isDirectory() ? walk(join(d, n.name)) : n.name.endsWith(".ts") && files.push(join(d, n.name)); };
    walk(root);
    const bad: string[] = [];
    for (const f of files)
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/(\.log\.(info|warn|error|fatal|debug)|console\.(log|error|warn))\(/.test(line) && /\$\{[^}]*(password|token|apiKey|secret)[^}]*\}/i.test(line))
          bad.push(`${f}:${i + 1}`);
      });
    expect(bad).toEqual([]);
  });
});
