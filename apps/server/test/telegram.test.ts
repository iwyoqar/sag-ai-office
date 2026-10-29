// Telegram bot against a fake Bot API (no network, no real token).
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";
import { TelegramBot } from "../src/telegram/bot.js";
import { createTask, getTask, transitionTask } from "../src/domain/tasks.js";
import { requestApproval, setSetting } from "../src/domain/brain.js";
import { SYSTEM } from "../src/lib/audit.js";

const GROUP = "-1004352159538";
const ADMIN = 111;
const MEMBER = 222;
const STRANGER = 333;
const TOKEN = "123456:SECRET-TOKEN-VALUE";

type Call = { method: string; body: Record<string, unknown> | FormData };

function fakeApi(opts: { memberStatus?: string; failSendOnce429?: boolean } = {}) {
  const calls: Call[] = [];
  let failed = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = init.body instanceof FormData ? init.body : JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    switch (method) {
      case "getMe": return ok({ id: 999, username: "sag_office_bot", first_name: "SAG Office" });
      case "getChat": return ok({ id: Number(GROUP), title: "SAG Team" });
      case "getChatMember": return ok({ status: opts.memberStatus ?? "administrator" });
      case "sendMessage":
      case "sendDocument":
        if (opts.failSendOnce429 && !failed) {
          failed = true;
          return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }), { status: 429 });
        }
        return ok({ message_id: calls.length });
      // behaves like a long poll: answers after a while, not instantly
      case "getUpdates": return new Promise<Response>((r) => setTimeout(() => r(ok([])), 20));
    }
    return new Response(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }), { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function setup(opts: Parameters<typeof fakeApi>[0] = {}) {
  const { deps } = await makeApp();
  const fake = fakeApi(opts);
  const waits: number[] = [];
  const logs: string[] = [];
  const bot = new TelegramBot(deps, {
    token: TOKEN, groupId: GROUP, adminUserIds: [ADMIN], fetchImpl: fake.fetchImpl, sendGapMs: 0,
    sleep: async (ms) => void waits.push(ms), log: (m, meta) => logs.push(`${m} ${JSON.stringify(meta)}`),
  });
  await bot.verify();
  return { deps, bot, ...fake, waits, logs };
}

let uid = 1000;
const msg = (from: number, text: string, chat = GROUP, type = "supergroup") => ({
  update_id: ++uid,
  message: { message_id: uid, chat: { id: Number(chat), type }, from: { id: from, username: `u${from}` }, text },
});
const sent = (calls: Call[]) => calls.filter((c) => c.method === "sendMessage").map((c) => (c.body as Record<string, string>).text);
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("telegram: connection", () => {
  it("verifies identity and group membership and marks the connector connected", async () => {
    const { bot, deps } = await setup();
    expect(bot.status).toMatchObject({ bot: { username: "sag_office_bot" }, group: { title: "SAG Team", canSend: true }, lastError: null });
    expect(deps.db.get("SELECT status, auth_status FROM connectors WHERE id = 'telegram'")).toEqual({ status: "connected", auth_status: "authenticated" });
    expect(bot.status.tokenMasked).not.toContain("SECRET");
  });

  it("reports a bot that cannot post in the group as an error, not as connected", async () => {
    const { bot, deps } = await setup({ memberStatus: "left" });
    expect(bot.status.lastError).toMatch(/xabar yubora olmaydi/);
    expect(deps.db.get<{ status: string }>("SELECT status FROM connectors WHERE id = 'telegram'")!.status).toBe("error");
  });
});

describe("telegram: commands", () => {
  it("creates a task for an admin, links it and replies with the id", async () => {
    const { bot, deps, calls } = await setup();
    expect(await bot.handleUpdate(msg(ADMIN, "/task Keyingi hafta uchun savdo hisobotini tayyorla"))).toBe("task_created");
    await flush();
    const link = deps.db.get<{ task_id: string }>("SELECT task_id FROM telegram_task_links")!;
    expect(getTask(deps, link.task_id).title).toBe("Keyingi hafta uchun savdo hisobotini tayyorla");
    expect(sent(calls).at(-1)).toContain("Vazifa qabul qilindi");
  });

  it("ignores a retried (duplicate) update — no second task", async () => {
    const { bot, deps } = await setup();
    const u = msg(ADMIN, "/task Raqobatchilar tahlili");
    await bot.handleUpdate(u);
    expect(await bot.handleUpdate(u)).toBe("duplicate");
    expect(deps.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")!.n).toBe(1);
    expect(deps.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'telegram.offset'")!.value).toBe(String(u.update_id + 1));
  });

  it("rejects unauthorized users and other chats", async () => {
    const { bot, deps, calls } = await setup();
    expect(await bot.handleUpdate(msg(STRANGER, "/task Menga pul o'tkaz"))).toBe("unauthorized");
    expect(await bot.handleUpdate(msg(MEMBER, "/cancel tsk_abc"))).toBe("unauthorized");
    expect(await bot.handleUpdate(msg(ADMIN, "/task boshqa guruh", "-100999"))).toBe("ignored_chat");
    expect(await bot.handleUpdate(msg(STRANGER, "/office", String(STRANGER), "private"))).toBe("ignored_chat");
    expect(await bot.handleUpdate(msg(ADMIN, "oddiy suhbat xabari"))).toBe("ignored");
    expect(deps.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks")!.n).toBe(0);
    await flush();
    expect(sent(calls).filter((t) => t.includes("⛔"))).toHaveLength(2);
    // allowed list from The Brain settings
    setSetting(deps, "telegram", { adminUserIds: [ADMIN], allowedUserIds: [MEMBER], notify: "linked", verbosity: "normal" }, SYSTEM);
    expect(await bot.handleUpdate(msg(MEMBER, "/task Mijozlar ro'yxatini yangilash"))).toBe("task_created");
  });

  it("answers /help, /office, /agents, /tasks and /status", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(msg(MEMBER, "/help@sag_office_bot"));
    await bot.handleUpdate(msg(MEMBER, "/office"));
    await bot.handleUpdate(msg(MEMBER, "/agents"));
    await bot.handleUpdate(msg(ADMIN, "/task Narxlar jadvalini tekshir"));
    await bot.handleUpdate(msg(MEMBER, "/tasks"));
    expect(await bot.handleUpdate(msg(MEMBER, "/help@other_bot"))).toBe("ignored");
    await flush();
    const out = sent(calls);
    expect(out.some((t) => t.includes("/task &lt;matn&gt;"))).toBe(true);
    expect(out.some((t) => t.includes("SAG AI Office") && t.includes("Vazifalar"))).toBe(true);
    expect(out.some((t) => t.includes("Faol vazifalar"))).toBe(true);
    const id = /#([a-z0-9]{6})/.exec(out.find((t) => t.includes("qabul qilindi"))!)![1];
    expect(await bot.handleUpdate(msg(MEMBER, `/status ${id}`))).toBe("ok");
  });

  it("/approve by an admin completes a task waiting for approval", async () => {
    const { bot, deps } = await setup();
    const t = createTask(deps, { title: "Taklif xati", agentId: "sales-shahnoza", requiresApproval: true }, SYSTEM);
    transitionTask(deps, t.id, "IN_PROGRESS", SYSTEM);
    transitionTask(deps, t.id, "WAITING_APPROVAL", SYSTEM);
    requestApproval(deps, t.id, "sales-shahnoza", "result_review", {});
    expect(await bot.handleUpdate(msg(MEMBER, `/approve ${t.id}`))).toBe("unauthorized");
    expect(await bot.handleUpdate(msg(ADMIN, `/approve #${t.id.slice(4, 10)}`))).toBe("approve");
    expect(getTask(deps, t.id).status).toBe("DONE");
    expect(deps.db.get("SELECT decided_via FROM approvals WHERE task_id = ?", t.id)).toEqual({ decided_via: "telegram" });
  });
});

describe("telegram: notifications", () => {
  it("posts progress for linked tasks and the final result as a document; retries 429", async () => {
    const { bot, deps, calls, waits } = await setup({ failSendOnce429: true });
    await bot.start();
    await bot.handleUpdate(msg(ADMIN, "/task Oylik moliyaviy xulosa"));
    const id = deps.db.get<{ task_id: string }>("SELECT task_id FROM telegram_task_links")!.task_id;
    const t = getTask(deps, id);
    transitionTask(deps, t.id, "IN_PROGRESS", SYSTEM);
    deps.db.run("INSERT INTO deliverables (id, task_id, agent_id, title, content, created_at) VALUES ('d1', ?, ?, 'Natija', '# Xulosa', ?)", t.id, t.agentId, new Date().toISOString());
    transitionTask(deps, t.id, "DONE", SYSTEM, { result: "Xulosa tayyor" });
    // an unrelated task created on the web is not posted (notify = linked)
    const other = createTask(deps, { title: "web task", agentId: "it-aziz" }, SYSTEM);
    transitionTask(deps, other.id, "IN_PROGRESS", SYSTEM);
    await new Promise((r) => setTimeout(r, 30));
    await bot.stop();
    expect(waits).toContain(3000); // honoured retry_after
    const docs = calls.filter((c) => c.method === "sendDocument");
    expect(docs).toHaveLength(1);
    expect(String((docs[0].body as FormData).get("caption"))).toContain("Bajarildi");
    expect(sent(calls).some((x) => x.includes("web task"))).toBe(false);
  });

  it("never puts the token into logs or errors", async () => {
    const { bot, logs } = await setup();
    const broken = new TelegramBot((bot as unknown as { ctx: never }).ctx, {
      token: TOKEN, groupId: GROUP, adminUserIds: [], sleep: async () => {}, sendGapMs: 0,
      fetchImpl: (async () => { throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/getMe`); }) as typeof fetch,
      log: (m, meta) => logs.push(`${m} ${JSON.stringify(meta)}`),
    });
    const st = await broken.verify();
    expect(st.lastError).not.toContain("SECRET");
    broken.send(GROUP, "x");
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.join("\n")).not.toContain("SECRET");
  });
});
