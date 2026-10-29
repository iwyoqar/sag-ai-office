// Telegram group integration via the official Bot API (long polling or webhook).
// Telegram is a user/notification channel only: agents coordinate inside the backend; the bot reports
// important steps to the group under labels like [MARKETING AGENT] — it never pretends to be several bots.
import type { OfficeEvent } from "@sag/shared";
import { timingSafeEqual } from "node:crypto";
import { now } from "../db/db.js";
import type { Ctx } from "../domain/context.js";
import { cancelTask, createTask, getTask, listTasks, type TaskDto } from "../domain/tasks.js";
import { decideApproval, getSetting } from "../domain/brain.js";
import { type Actor, audit } from "../lib/audit.js";

type FetchFn = typeof fetch;

export interface TelegramOptions {
  token: string;
  groupId: string;
  /** env defaults; The Brain settings override them */
  adminUserIds: number[];
  fetchImpl?: FetchFn;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  pollTimeoutSec?: number;
  /** "webhook": Telegram pushes updates to POST /api/telegram/webhook (needs a public HTTPS URL); default long polling */
  mode?: "polling" | "webhook";
  /** public base URL of this API, e.g. https://api.example.com */
  webhookUrl?: string;
  /** echoed by Telegram in X-Telegram-Bot-Api-Secret-Token; required in webhook mode */
  webhookSecret?: string;
  sendGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramSettings {
  adminUserIds: number[];
  /** may create tasks with /task (admins always can) */
  allowedUserIds: number[];
  /** "linked" = only tasks created from Telegram; "all" = every top-level task */
  notify: "linked" | "all";
  verbosity: "minimal" | "normal";
}

export interface TelegramStatus {
  configured: boolean;
  running: boolean;
  mode: "polling" | "webhook";
  webhook: { url: string; pendingUpdates: number; lastError: string | null } | null;
  bot: { id: number; username: string; name: string } | null;
  group: { id: string; title: string | null; memberStatus: string | null; canSend: boolean } | null;
  lastPollAt: string | null;
  lastError: string | null;
  tokenMasked: string;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
    text?: string;
  };
}

const API = "https://api.telegram.org";
const COMMANDS = ["start", "help", "office", "agents", "tasks", "task", "status", "approve", "reject", "cancel"] as const;
const PRIVILEGED = new Set(["approve", "reject", "cancel"]);
const SYSTEM_TG: Actor = { type: "system", id: null };

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const shortId = (id: string) => `#${id.slice(4, 10)}`;

export class TgError extends Error {
  constructor(message: string, readonly code: number, readonly retryAfter?: number) {
    super(message);
  }
}

export class TelegramBot {
  private running = false;
  private pollAbort: AbortController | null = null;
  private queue: { chatId: string; text: string; doc?: { name: string; content: string } }[] = [];
  private sending = false;
  private unsubscribe: (() => void) | null = null;
  private readonly fetch: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly status: TelegramStatus;

  constructor(private ctx: Ctx, private o: TelegramOptions) {
    this.fetch = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.status = {
      configured: true, running: false, mode: o.mode ?? "polling", webhook: null, bot: null, group: null, lastPollAt: null, lastError: null,
      tokenMasked: `${o.token.slice(0, 4)}…${o.token.slice(-4)}`,
    };
  }

  settings(): TelegramSettings {
    const s = getSetting<Partial<TelegramSettings>>(this.ctx, "telegram", {});
    return {
      adminUserIds: s.adminUserIds?.length ? s.adminUserIds : this.o.adminUserIds,
      allowedUserIds: s.allowedUserIds ?? [],
      notify: s.notify ?? "linked",
      verbosity: s.verbosity ?? "normal",
    };
  }

  /** Bot API call. The token is only in the request path — never in errors or logs. */
  async api<T>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${API}/bot${this.o.token}/${method}`, {
        method: "POST",
        ...(params instanceof FormData ? { body: params } : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new TgError("aborted", 0);
      throw new TgError(`Telegram tarmoq xatosi: ${(e as Error).name}`, 0);
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!data.ok) throw new TgError(`Telegram: ${data.description ?? `HTTP ${res.status}`}`, data.error_code ?? res.status, data.parameters?.retry_after);
    return data.result as T;
  }

  /** Identity + group membership check; also updates the Telegram connector record in The Brain. */
  async verify(): Promise<TelegramStatus> {
    try {
      const me = await this.api<{ id: number; username: string; first_name: string }>("getMe");
      this.status.bot = { id: me.id, username: me.username, name: me.first_name };
      try {
        const chat = await this.api<{ id: number; title?: string }>("getChat", { chat_id: this.o.groupId });
        const member = await this.api<{ status: string; can_send_messages?: boolean }>("getChatMember", { chat_id: this.o.groupId, user_id: me.id });
        const canSend = ["administrator", "creator"].includes(member.status) || (member.status === "member" && member.can_send_messages !== false) || member.status === "restricted" && !!member.can_send_messages;
        this.status.group = { id: this.o.groupId, title: chat.title ?? null, memberStatus: member.status, canSend };
        if (!canSend) throw new TgError(`Bot guruhda xabar yubora olmaydi (holat: ${member.status})`, 403);
      } catch (e) {
        this.status.group = this.status.group ?? { id: this.o.groupId, title: null, memberStatus: null, canSend: false };
        throw e;
      }
      this.status.lastError = null;
      this.ctx.db.run(
        "UPDATE connectors SET status = 'connected', auth_status = 'authenticated', last_health_at = ?, last_error = NULL WHERE id = 'telegram'", now(),
      );
    } catch (e) {
      this.status.lastError = (e as Error).message;
      this.ctx.db.run("UPDATE connectors SET status = 'error', auth_status = ?, last_health_at = ?, last_error = ? WHERE id = 'telegram'",
        e instanceof TgError && e.code === 401 ? "error" : "configured", now(), this.status.lastError);
    }
    this.ctx.bus.emit("connector.activity", {}, { connector: "telegram", status: this.status.lastError ? "error" : "connected" });
    return this.status;
  }

  get webhookPath() {
    return "/api/telegram/webhook";
  }

  async start() {
    if (this.running) return;
    await this.verify();
    this.running = true;
    this.status.running = true;
    this.unsubscribe = this.ctx.bus.subscribe((e) => this.onEvent(e));
    if (this.status.mode === "webhook") await this.registerWebhook();
    else {
      // a webhook left over from an earlier webhook deployment makes getUpdates fail with 409
      await this.api("deleteWebhook", { drop_pending_updates: false }).catch(() => undefined);
      void this.pollLoop();
    }
  }

  /** Points Telegram at this server. Idempotent; the secret makes forged POSTs to the webhook useless. */
  async registerWebhook() {
    const { webhookUrl, webhookSecret } = this.o;
    if (!webhookUrl || !webhookSecret || webhookSecret.length < 16) {
      this.status.lastError = "Webhook rejimi uchun TELEGRAM_WEBHOOK_URL va kamida 16 belgili TELEGRAM_WEBHOOK_SECRET kerak";
      return;
    }
    const url = `${webhookUrl.replace(/\/+$/, "")}${this.webhookPath}`;
    try {
      await this.api("setWebhook", { url, secret_token: webhookSecret, allowed_updates: ["message"], max_connections: 10 });
      await this.webhookInfo();
    } catch (e) {
      this.status.lastError = (e as Error).message;
      this.o.log?.("telegram setWebhook failed", { error: this.status.lastError });
    }
  }

  async webhookInfo() {
    const info = await this.api<{ url: string; pending_update_count: number; last_error_message?: string }>("getWebhookInfo");
    this.status.webhook = { url: info.url, pendingUpdates: info.pending_update_count, lastError: info.last_error_message ?? null };
    return this.status.webhook;
  }

  /** Constant-time check of the secret header Telegram sends with every webhook call. */
  acceptsWebhook(secretHeader: string | undefined): boolean {
    const want = this.o.webhookSecret;
    if (this.status.mode !== "webhook" || !this.running || !want || want.length < 16 || !secretHeader) return false;
    const a = Buffer.from(secretHeader);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Webhook delivery: same exactly-once path as polling. */
  async receive(u: TgUpdate): Promise<string> {
    this.status.lastPollAt = now();
    return this.handleUpdate(u);
  }

  async stop() {
    this.running = false;
    this.status.running = false;
    this.pollAbort?.abort();
    this.unsubscribe?.();
  }

  private async pollLoop() {
    let failures = 0;
    while (this.running) {
      try {
        const offset = getSetting<number>(this.ctx, "telegram.offset", 0);
        this.pollAbort = new AbortController();
        const started = Date.now();
        const updates = await this.api<TgUpdate[]>(
          "getUpdates", { offset: offset || undefined, timeout: this.o.pollTimeoutSec ?? 25, allowed_updates: ["message"] }, this.pollAbort.signal,
        );
        this.status.lastPollAt = now();
        failures = 0;
        for (const u of updates) await this.handleUpdate(u);
        // A long poll that returns empty almost instantly (proxy, misconfiguration) must not spin the CPU.
        if (!updates.length && Date.now() - started < 300) await this.sleep(1000);
      } catch (e) {
        if (!this.running) break;
        failures++;
        this.status.lastError = (e as Error).message;
        this.o.log?.("telegram poll error", { error: this.status.lastError, failures });
        // 409 = another getUpdates consumer (or a webhook) is active — back off hard instead of fighting it.
        const wait = e instanceof TgError && e.retryAfter ? e.retryAfter * 1000 : e instanceof TgError && e.code === 409 ? 60_000 : Math.min(60_000, 2000 * 2 ** failures);
        await this.sleep(wait);
      }
    }
  }

  /** Processes one update exactly once (update_id is the idempotency key, the offset is persisted after). */
  async handleUpdate(u: TgUpdate): Promise<string> {
    const m = u.message;
    const first = this.ctx.db.run(
      "INSERT OR IGNORE INTO telegram_updates (update_id, chat_id, user_id, username, text, received_at) VALUES (?,?,?,?,?,?)",
      u.update_id, m?.chat.id ?? null, m?.from?.id ?? null, m?.from?.username ?? null, m?.text?.slice(0, 4000) ?? null, now(),
    );
    this.saveOffset(u.update_id + 1);
    if (first.changes === 0) return "duplicate";
    const outcome = await this.route(u).catch((e) => {
      this.o.log?.("telegram handler error", { error: (e as Error).message, update: u.update_id });
      return `error: ${(e as Error).message}`.slice(0, 200);
    });
    this.ctx.db.run("UPDATE telegram_updates SET outcome = ? WHERE update_id = ?", outcome, u.update_id);
    return outcome;
  }

  private saveOffset(next: number) {
    const cur = getSetting<number>(this.ctx, "telegram.offset", 0);
    if (next > cur)
      this.ctx.db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES ('telegram.offset', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        String(next), now(),
      );
  }

  private async route(u: TgUpdate): Promise<string> {
    const m = u.message;
    if (!m?.text || !m.from || m.from.is_bot) return "ignored";
    const parsed = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(m.text.trim());
    if (!parsed) return "ignored"; // ordinary group chatter is not for the bot
    const [, rawCmd, mention, rawArgs] = parsed;
    if (mention && this.status.bot && mention.toLowerCase() !== this.status.bot.username.toLowerCase()) return "ignored";
    const cmd = rawCmd.toLowerCase();
    const args = (rawArgs ?? "").trim();
    this.ctx.db.run("UPDATE telegram_updates SET command = ? WHERE update_id = ?", cmd, u.update_id);

    const s = this.settings();
    const isAdmin = s.adminUserIds.includes(m.from.id);
    const inGroup = String(m.chat.id) === String(this.o.groupId);
    // Only the configured group, or a private chat with an admin.
    if (!inGroup && !(m.chat.type === "private" && isAdmin)) return "ignored_chat";
    const chatId = String(m.chat.id);
    const reply = (text: string) => this.send(chatId, text);

    if (!(COMMANDS as readonly string[]).includes(cmd)) {
      reply("Noma'lum buyruq. /help");
      return "unknown_command";
    }
    if (PRIVILEGED.has(cmd) && !isAdmin) {
      reply("⛔ Bu buyruq faqat administratorlar uchun.");
      this.auditTg("telegram.denied", m.from.id, { cmd });
      return "unauthorized";
    }

    switch (cmd) {
      case "start":
      case "help":
        reply(helpText(this.status.bot?.username));
        return "ok";
      case "office":
        reply(this.officeText());
        return "ok";
      case "agents":
        reply(this.agentsText());
        return "ok";
      case "tasks":
        reply(this.tasksText());
        return "ok";
      case "task": {
        if (!isAdmin && !s.allowedUserIds.includes(m.from.id)) {
          reply("⛔ Vazifa berish uchun ruxsatingiz yo'q. Administrator sizni The Brain → Telegram sozlamalarida qo'shishi kerak.");
          this.auditTg("telegram.denied", m.from.id, { cmd });
          return "unauthorized";
        }
        if (args.length < 5) {
          reply("Foydalanish: /task <topshiriq matni>");
          return "bad_args";
        }
        const task = createTask(this.ctx, { title: args.split("\n")[0].slice(0, 200), description: args }, SYSTEM_TG);
        this.ctx.db.run(
          "INSERT OR IGNORE INTO telegram_task_links (task_id, chat_id, message_id, user_id, created_at) VALUES (?,?,?,?,?)",
          task.id, m.chat.id, m.message_id, m.from.id, now(),
        );
        this.ctx.db.run("UPDATE telegram_updates SET task_id = ? WHERE update_id = ?", task.id, u.update_id);
        this.auditTg("telegram.task_create", m.from.id, { taskId: task.id });
        reply(
          `✅ Vazifa qabul qilindi: <b>${shortId(task.id)}</b>\n${esc(task.title)}\n` +
            (task.kind === "orchestrate" ? "Director AI uni bo'limlarga taqsimlaydi." : `Mas'ul: ${esc(this.agentLabel(task.agentId))}`) +
            `\nHolat: /status ${shortId(task.id).slice(1)}`,
        );
        return "task_created";
      }
      case "status": {
        const t = this.findTask(args);
        if (!t) {
          reply("Vazifa topilmadi. Foydalanish: /status <id>");
          return "not_found";
        }
        reply(this.statusText(t));
        return "ok";
      }
      case "approve":
      case "reject": {
        const [idArg, ...rest] = args.split(/\s+/);
        const t = this.findTask(idArg ?? "");
        const apr = t && this.ctx.db.get<{ id: string }>("SELECT id FROM approvals WHERE task_id = ? AND status = 'PENDING' ORDER BY requested_at DESC LIMIT 1", t.id);
        if (!t || !apr) {
          reply("Tasdiq kutayotgan vazifa topilmadi.");
          return "not_found";
        }
        const reason = rest.join(" ").trim();
        if (cmd === "reject" && !reason) {
          reply("Foydalanish: /reject <id> <sabab>");
          return "bad_args";
        }
        decideApproval(this.ctx, apr.id, cmd === "approve" ? "approve" : "reject", reason || `Telegram: ${m.from.username ?? m.from.id}`, SYSTEM_TG, "telegram");
        this.auditTg(`telegram.${cmd}`, m.from.id, { taskId: t.id });
        reply(cmd === "approve" ? `✅ ${shortId(t.id)} tasdiqlandi.` : `↩️ ${shortId(t.id)} qayta ishlashga qaytarildi.`);
        return cmd;
      }
      case "cancel": {
        const t = this.findTask(args);
        if (!t) {
          reply("Vazifa topilmadi.");
          return "not_found";
        }
        cancelTask(this.ctx, t.id, SYSTEM_TG, `Telegram: ${m.from.username ?? m.from.id}`);
        this.auditTg("telegram.cancel", m.from.id, { taskId: t.id });
        reply(`🛑 ${shortId(t.id)} bekor qilindi.`);
        return "cancelled";
      }
    }
    return "ignored";
  }

  private auditTg(action: string, tgUserId: number, meta: Record<string, unknown>) {
    audit(this.ctx.db, SYSTEM_TG, action, { type: "telegram_user", id: String(tgUserId) }, meta);
  }

  /** Accepts the full id, "#abc123" or "abc123" (first 6 chars after tsk_). */
  findTask(arg: string): TaskDto | null {
    const a = arg.trim().replace(/^#/, "");
    if (!/^[a-z0-9_]{4,40}$/i.test(a)) return null;
    const rows = this.ctx.db.all<{ id: string }>(
      "SELECT id FROM tasks WHERE id = ? OR id LIKE ? ORDER BY created_at DESC LIMIT 2", a, `tsk_${a.toLowerCase()}%`,
    );
    return rows.length === 1 || rows[0]?.id === a ? getTask(this.ctx, rows[0].id) : null;
  }

  private agentLabel(agentId: string | null) {
    const a = agentId && this.ctx.db.get<{ name: string; dep: string }>(
      "SELECT a.name, d.short dep FROM agents a JOIN departments d ON d.id = a.department_id WHERE a.id = ?", agentId,
    );
    return a ? `[${a.dep.toUpperCase()} AGENT] ${a.name}` : "—";
  }

  // ---------------------------------------------------------------- texts
  private officeText() {
    const n = (sql: string) => this.ctx.db.get<{ n: number }>(sql)!.n;
    return [
      "🏢 <b>SAG AI Office</b>",
      `Agentlar: ${n("SELECT COUNT(*) n FROM agents WHERE lifecycle = 'ACTIVE'")} faol, ishlayotgan: ${n("SELECT COUNT(*) n FROM agents WHERE status IN ('WORKING','THINKING','COMMUNICATING')")}`,
      `Vazifalar: jarayonda ${n("SELECT COUNT(*) n FROM tasks WHERE status = 'IN_PROGRESS'")}, navbatda ${n("SELECT COUNT(*) n FROM tasks WHERE status = 'QUEUED'")}, tasdiq kutmoqda ${n("SELECT COUNT(*) n FROM tasks WHERE status = 'WAITING_APPROVAL'")}`,
      `Bugun bajarildi: ${n(`SELECT COUNT(*) n FROM tasks WHERE status = 'DONE' AND completed_at >= '${new Date(Date.now() - 86_400_000).toISOString()}'`)}`,
    ].join("\n");
  }

  private agentsText() {
    const rows = this.ctx.db.all<{ dep: string; name: string; status: string; title: string | null }>(
      `SELECT d.short dep, a.name, a.status, (SELECT t.title FROM tasks t WHERE t.agent_id = a.id AND t.status = 'IN_PROGRESS' LIMIT 1) title
       FROM agents a JOIN departments d ON d.id = a.department_id WHERE a.lifecycle = 'ACTIVE' AND a.status <> 'IDLE' ORDER BY d.sort, a.name`,
    );
    const idle = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE lifecycle = 'ACTIVE' AND status = 'IDLE'")!.n;
    if (!rows.length) return `👥 Hozir hamma agent bo'sh (${idle}).`;
    return ["👥 <b>Band agentlar</b>", ...rows.map((r) => `[${esc(r.dep.toUpperCase())}] ${esc(r.name)} — ${r.status}${r.title ? `: ${esc(r.title)}` : ""}`), `Bo'sh: ${idle}`].join("\n");
  }

  private tasksText() {
    const ts = listTasks(this.ctx, { status: ["QUEUED", "IN_PROGRESS", "WAITING_FOR_DEPENDENCY", "WAITING_APPROVAL", "BLOCKED"], parentId: null, limit: 10 });
    if (!ts.length) return "📋 Faol vazifa yo'q.";
    return ["📋 <b>Faol vazifalar</b>", ...ts.map((t) => `${shortId(t.id)} — ${esc(t.title)} · ${t.status}${t.stage ? ` · ${esc(t.stage)}` : ""}`)].join("\n");
  }

  private statusText(t: TaskDto) {
    const kids = listTasks(this.ctx, { parentId: t.id });
    return [
      `<b>${shortId(t.id)}</b> ${esc(t.title)}`,
      `Holat: ${t.status}${t.progress !== null ? ` · ${t.progress}%` : ""}${t.stage ? ` · ${esc(t.stage)}` : ""}`,
      t.kind === "single" ? `Mas'ul: ${esc(this.agentLabel(t.agentId))}` : "",
      ...kids.map((k) => `  • ${esc(this.agentLabel(k.agentId))}: ${esc(k.title)} — ${k.status}`),
      t.error ? `Xato: ${esc(t.error)}` : "",
      t.status === "DONE" && t.result ? `\n${esc(t.result)}` : "",
    ].filter(Boolean).join("\n");
  }

  // ---------------------------------------------------------------- notifications
  /** Which group gets updates about a task: its Telegram origin (or its parent's), or all tasks if configured. */
  private targetFor(taskId: string): string | null {
    const t = this.ctx.db.get<{ id: string; parent_id: string | null }>("SELECT id, parent_id FROM tasks WHERE id = ?", taskId);
    if (!t) return null;
    const root = t.parent_id ?? t.id;
    const link = this.ctx.db.get<{ chat_id: number }>("SELECT chat_id FROM telegram_task_links WHERE task_id = ?", root);
    if (link) return String(link.chat_id);
    return this.settings().notify === "all" ? this.o.groupId : null;
  }

  onEvent(e: OfficeEvent) {
    // People's work is never posted to the group (it may be confidential); employees get personal notices instead.
    if (!this.running || !e.taskId || e.data?.human) return;
    const chat = this.targetFor(e.taskId);
    if (!chat) return;
    const t = getTask(this.ctx, e.taskId);
    const verbose = this.settings().verbosity === "normal";
    const top = !t.parentId;

    if (e.type === "approval.requested") {
      const d = this.lastDeliverable(t.id);
      this.send(chat, `🟡 <b>Tasdiq kerak</b> ${shortId(t.id)}: ${esc(t.title)}\n${esc(this.agentLabel(t.agentId))}\n\n${esc((t.result ?? "").slice(0, 700))}\n\n/approve ${shortId(t.id).slice(1)}  yoki  /reject ${shortId(t.id).slice(1)} &lt;sabab&gt;`,
        d ? { name: `${t.id}.md`, content: d } : undefined);
      return;
    }
    if (e.type !== "task.status") return;
    const to = e.data.to as string;
    if (top && to === "WAITING_FOR_DEPENDENCY" && t.kind === "orchestrate" && e.data.reason === "subtasks created") {
      const kids = listTasks(this.ctx, { parentId: t.id });
      this.send(chat, [`🧭 <b>Reja tayyor</b> ${shortId(t.id)}: ${kids.length} qism`, ...kids.map((k) => `  • ${esc(this.agentLabel(k.agentId))}: ${esc(k.title)}`)].join("\n"));
    } else if (top && to === "IN_PROGRESS" && e.data.from === "QUEUED" && t.kind === "single" && verbose) {
      this.send(chat, `▶️ ${shortId(t.id)} ish boshlandi — ${esc(this.agentLabel(t.agentId))}`);
    } else if (!top && to === "DONE" && verbose) {
      this.send(chat, `${esc(this.agentLabel(t.agentId))}: «${esc(t.title)}» tayyor — natija keyingi bosqichga uzatildi.`);
    } else if (top && to === "DONE") {
      const d = this.lastDeliverable(t.id);
      this.send(chat, `✅ <b>Bajarildi</b> ${shortId(t.id)}: ${esc(t.title)}\n\n${esc((t.result ?? "").slice(0, 900))}${d ? "\n\nTo'liq natija ilova faylda." : ""}`,
        d ? { name: `${t.id}.md`, content: d } : undefined);
    } else if (to === "FAILED" || to === "BLOCKED") {
      this.send(chat, `❌ ${shortId(t.id)} ${to === "FAILED" ? "bajarilmadi" : "to'xtab qoldi"}: ${esc(t.title)}\n${esc(t.error ?? "")}`);
    }
  }

  private lastDeliverable(taskId: string) {
    return this.ctx.db.get<{ content: string }>("SELECT content FROM deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", taskId)?.content ?? null;
  }

  /** Queued, spaced sends (group limit ≈ 20 msg/min) with 429 retry_after handling. */
  send(chatId: string, text: string, doc?: { name: string; content: string }) {
    this.queue.push({ chatId, text: text.slice(0, 4000), doc });
    void this.drain();
  }

  private async drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const m = this.queue[0];
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            if (m.doc) {
              const fd = new FormData();
              fd.set("chat_id", m.chatId);
              fd.set("caption", m.text.slice(0, 1000));
              fd.set("parse_mode", "HTML");
              fd.set("document", new Blob([m.doc.content], { type: "text/markdown" }), m.doc.name);
              await this.api("sendDocument", fd);
            } else {
              await this.api("sendMessage", { chat_id: m.chatId, text: m.text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
            }
            this.ctx.bus.emit("connector.activity", {}, { connector: "telegram", action: m.doc ? "sendDocument" : "sendMessage" });
            break;
          } catch (e) {
            const err = e as TgError;
            this.o.log?.("telegram send failed", { attempt: attempt + 1, error: err.message });
            if (attempt === 3 || (err.code >= 400 && err.code < 500 && err.code !== 429)) break;
            await this.sleep(err.retryAfter ? err.retryAfter * 1000 : 1500 * (attempt + 1));
          }
        }
        this.queue.shift();
        await this.sleep(this.o.sendGapMs ?? 1100);
      }
    } finally {
      this.sending = false;
    }
  }

  get pending() {
    return this.queue.length;
  }
}

function helpText(username?: string) {
  return [
    `🤖 <b>SAG AI Office</b>${username ? ` (@${esc(username)})` : ""}`,
    "Kompaniya AI agentlariga vazifa berish va natijalarni kuzatish.",
    "",
    "/office — umumiy holat",
    "/agents — band agentlar",
    "/tasks — faol vazifalar",
    "/task &lt;matn&gt; — yangi vazifa (ruxsat berilganlar)",
    "/status &lt;id&gt; — vazifa holati",
    "/approve &lt;id&gt; — natijani tasdiqlash (admin)",
    "/reject &lt;id&gt; &lt;sabab&gt; — qayta ishlashga qaytarish (admin)",
    "/cancel &lt;id&gt; — bekor qilish (admin)",
  ].join("\n");
}
