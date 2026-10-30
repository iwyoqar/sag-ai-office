// What agents can do through connectors. Every tool validates its arguments (zod) before anything leaves the
// server. "read" tools run immediately; "write" tools (send, post, create, append) only run after a person approves
// that exact call in The Brain — the agent is told it is waiting for approval and must not claim it happened.
import { z, type ZodTypeAny } from "zod";
import type { ToolSpec } from "../llm/types.js";
import type { Ctx } from "../domain/context.js";
import { addMemory } from "../domain/brain.js";
import { embedderOf, retrieve } from "../knowledge/semantic.js";
import { createWork } from "../domain/work.js";
import type { AuthUser } from "../lib/auth.js";
import { ConnectorError, type GoogleAuth } from "./google.js";

export interface ToolEnv {
  ctx: Ctx;
  agentId: string;
  departmentId: string | null;
  taskId: string | null;
  correlationId: string;
  google: GoogleAuth;
  http: typeof fetch;
  tokens: { slack?: string; notion?: string };
  llm: { searchWeb?(q: string, id: string): Promise<{ text: string; sources: { title: string; url: string }[] }>; mode: string } | null;
  telegram: { postToGroup(text: string): void; active: boolean } | null;
  embedder: ReturnType<typeof embedderOf>;
  /** the person who approved a write action (their rights apply, e.g. for creating employee tasks) */
  approver?: AuthUser;
}

export interface ToolDef {
  name: string;
  connector: string;
  kind: "read" | "write";
  description: string;
  parameters: ToolSpec["parameters"];
  schema: ZodTypeAny;
  /** one line for the approval card / activity log */
  summary(args: Record<string, unknown>): string;
  run(env: ToolEnv, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const str = (description: string) => ({ type: "string", description });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function tool<S extends ZodTypeAny>(d: Omit<ToolDef, "schema" | "run" | "summary"> & {
  schema: S; summary(a: z.infer<S>): string; run(env: ToolEnv, a: z.infer<S>): Promise<Record<string, unknown>>;
}): ToolDef {
  return d as unknown as ToolDef;
}

// ---------------------------------------------------------------- internal (no credentials)

const searchKnowledgeTool = tool({
  name: "search_company_knowledge", connector: "internal-api", kind: "read",
  description: "SAG bilimlar bazasidan (hujjatlar) qidirish. Faktlar, raqamlar, uskunalar, kolleksiyalar haqida savollar uchun.",
  parameters: { type: "object", properties: { query: str("Qidiruv so'rovi") }, required: ["query"] },
  schema: z.object({ query: z.string().trim().min(2).max(300) }),
  summary: (a) => `Bilimlar bazasidan qidirish: “${a.query}”`,
  async run(env, a) {
    const { hits, mode } = await retrieve(env.ctx, env.embedder, a.query, { departmentId: env.departmentId, limit: 5 });
    return { mode, results: hits.map((h) => ({ source: h.title, text: clip(h.content, 900) })) };
  },
});

const listPeopleTool = tool({
  name: "list_company_people", connector: "internal-api", kind: "read",
  description: "Bo'limlar va xodimlar ro'yxati (ism, lavozim, bo'lim). Kimga vazifa berish mumkinligini bilish uchun.",
  parameters: { type: "object", properties: { department_id: str("Bo'lim id (ixtiyoriy)") } },
  schema: z.object({ department_id: z.string().max(40).optional() }),
  summary: (a) => `Xodimlar ro'yxati${a.department_id ? `: ${a.department_id}` : ""}`,
  async run(env, a) {
    const deps = env.ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM departments WHERE is_active = 1 AND business_unit_id = 'hq' ORDER BY sort");
    const people = env.ctx.db.all<{ display_name: string; job_title: string; department_id: string | null }>(
      `SELECT display_name, job_title, department_id FROM users WHERE status = 'active' AND home_unit_id = 'hq' AND department_id IS NOT NULL ${a.department_id ? "AND department_id = ?" : ""} ORDER BY display_name LIMIT 200`,
      ...(a.department_id ? [a.department_id] : []),
    );
    return { departments: deps, people: people.map((p) => ({ name: p.display_name, title: p.job_title, department: p.department_id })) };
  },
});

const proposeMemoryTool = tool({
  name: "propose_company_memory", connector: "internal-api", kind: "read",
  description: "Muhim faktni kompaniya xotirasiga taklif qilish. Odam The Brain'da tasdiqlaguncha ishlatilmaydi.",
  parameters: {
    type: "object",
    properties: { kind: { type: "string", enum: ["decision", "lesson", "rule"], description: "decision — qaror, lesson — saboq, rule — qoida/fakt" }, content: str("Qisqa va aniq matn") },
    required: ["kind", "content"],
  },
  schema: z.object({ kind: z.enum(["decision", "lesson", "rule"]), content: z.string().trim().min(5).max(600) }),
  summary: (a) => `Xotiraga taklif: ${clip(a.content, 80)}`,
  async run(env, a) {
    const m = addMemory(env.ctx, { kind: a.kind, content: a.content, departmentId: env.departmentId, taskId: env.taskId }, { type: "agent", id: env.agentId });
    return { status: "pending_review", memoryId: m.id, note: "Odam tasdiqlagach ishlatiladi" };
  },
});

const createEmployeeTaskTool = tool({
  name: "create_employee_task", connector: "internal-api", kind: "write",
  description: "Inson xodimga vazifa yaratish (odam tasdiqlagandan keyin, tasdiqlovchi nomidan yaratiladi).",
  parameters: {
    type: "object",
    properties: {
      title: str("Vazifa sarlavhasi"), description: str("Nima qilish kerak, kutilgan natija"),
      assignee_name: str("Xodimning to'liq ismi (list_company_people dan)"), deadline: str("Muddat, ISO 8601 (ixtiyoriy)"),
      priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
    },
    required: ["title", "assignee_name"],
  },
  schema: z.object({
    title: z.string().trim().min(3).max(200), description: z.string().max(5000).default(""), assignee_name: z.string().trim().min(2).max(80),
    deadline: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO sana").optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  }),
  summary: (a) => `Xodimga vazifa: “${a.title}” → ${a.assignee_name}`,
  async run(env, a) {
    if (!env.approver) throw new ConnectorError("Tasdiqlovchi aniqlanmadi");
    const p = env.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE status = 'active' AND home_unit_id = 'hq' AND lower(display_name) = lower(?)", a.assignee_name);
    if (!p) throw new ConnectorError(`Xodim topilmadi: ${a.assignee_name}`);
    const t = createWork(env.ctx, env.approver, {
      title: a.title, description: `${a.description}\n\n(AI agent taklifi, ${env.approver.displayName} tasdiqlagan)`.trim(),
      assigneeId: p.id, deadline: a.deadline ?? null, priority: a.priority,
    });
    return { taskId: t.id, status: t.status };
  },
});

const webSearchTool = tool({
  name: "web_search", connector: "web-search", kind: "read",
  description: "Internetdan qidirish (Google qidiruviga asoslangan, manbalar bilan). Bozor, raqobatchilar, yangiliklar uchun.",
  parameters: { type: "object", properties: { query: str("Qidiruv so'rovi") }, required: ["query"] },
  schema: z.object({ query: z.string().trim().min(2).max(300) }),
  summary: (a) => `Internetdan qidirish: “${a.query}”`,
  async run(env, a) {
    if (!env.llm?.searchWeb) throw new ConnectorError("Internet qidiruvi mavjud emas");
    const r = await env.llm.searchWeb(a.query, env.correlationId);
    return { summary: clip(r.text, 3000), sources: r.sources, ...(env.llm.mode === "mock" ? { note: "MOCK — haqiqiy qidiruv emas" } : {}) };
  },
});

const telegramPostTool = tool({
  name: "telegram_post_group", connector: "telegram", kind: "write",
  description: "Kompaniyaning Telegram guruhiga xabar yuborish (odam tasdiqlagandan keyin).",
  parameters: { type: "object", properties: { text: str("Xabar matni") }, required: ["text"] },
  schema: z.object({ text: z.string().trim().min(1).max(3500) }),
  summary: (a) => `Telegram guruhiga xabar: “${clip(a.text, 90)}”`,
  async run(env, a) {
    if (!env.telegram?.active) throw new ConnectorError("Telegram bot ishlamayapti");
    env.telegram.postToGroup(a.text);
    return { status: "queued" };
  },
});

// ---------------------------------------------------------------- Google Workspace

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const mimeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const EMAIL = z.string().trim().email().max(200);

const gmailSearchTool = tool({
  name: "gmail_search", connector: "gmail", kind: "read",
  description: "Kompaniya pochtasidan xatlarni qidirish (Gmail qidiruv sintaksisi). Mavzu, jo'natuvchi va qisqa matn qaytadi.",
  parameters: { type: "object", properties: { query: str("Masalan: from:diler@x.uz newer_than:7d"), max_results: { type: "integer", description: "1–10" } }, required: ["query"] },
  schema: z.object({ query: z.string().trim().min(1).max(300), max_results: z.number().int().min(1).max(10).default(5) }),
  summary: (a) => `Pochtadan qidirish: “${a.query}”`,
  async run(env, a) {
    const g = env.google;
    const list = await g.call<{ messages?: { id: string }[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: a.query, maxResults: String(a.max_results) })}`);
    const out = [];
    for (const m of list.messages ?? []) {
      const msg = await g.call<{ snippet?: string; payload?: { headers?: { name: string; value: string }[] } }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      );
      const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
      out.push({ id: m.id, subject: h("Subject"), from: h("From"), date: h("Date"), snippet: clip(msg.snippet ?? "", 300) });
    }
    return { messages: out };
  },
});

const gmailSendTool = tool({
  name: "gmail_send", connector: "gmail", kind: "write",
  description: "Kompaniya pochtasidan email yuborish (odam tasdiqlagandan keyin).",
  parameters: { type: "object", properties: { to: str("Qabul qiluvchi email"), subject: str("Mavzu"), body: str("Matn (oddiy matn)") }, required: ["to", "subject", "body"] },
  schema: z.object({ to: EMAIL, subject: z.string().trim().min(1).max(200), body: z.string().min(1).max(20_000) }),
  summary: (a) => `Email → ${a.to}: “${a.subject}”`,
  async run(env, a) {
    const raw = [
      `To: ${a.to}`, `Subject: ${mimeWord(a.subject.replace(/[\r\n]/g, " "))}`, "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(a.body, "utf8").toString("base64"),
    ].join("\r\n");
    const r = await env.google.call<{ id: string; threadId: string }>("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: { raw: b64url(raw) } });
    return { messageId: r.id, threadId: r.threadId };
  },
});

const driveSearchTool = tool({
  name: "drive_search", connector: "drive", kind: "read",
  description: "Google Drive'dan fayllarni nomi bo'yicha qidirish.",
  parameters: { type: "object", properties: { query: str("Fayl nomidagi so'z") }, required: ["query"] },
  schema: z.object({ query: z.string().trim().min(1).max(120) }),
  summary: (a) => `Drive'dan qidirish: “${a.query}”`,
  async run(env, a) {
    const q = `name contains '${a.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`;
    const r = await env.google.call<{ files?: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[] }>(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, pageSize: "10", fields: "files(id,name,mimeType,modifiedTime,webViewLink)" })}`,
    );
    return { files: r.files ?? [] };
  },
});

const driveCreateTool = tool({
  name: "drive_create_document", connector: "drive", kind: "write",
  description: "Google Drive'da yangi Google Docs hujjat yaratish (odam tasdiqlagandan keyin).",
  parameters: { type: "object", properties: { name: str("Hujjat nomi"), content: str("Matn") }, required: ["name", "content"] },
  schema: z.object({ name: z.string().trim().min(1).max(200), content: z.string().min(1).max(100_000) }),
  summary: (a) => `Drive'da hujjat: “${a.name}” (${a.content.length} belgi)`,
  async run(env, a) {
    const boundary = `sag${Date.now().toString(36)}`;
    const body = [
      `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "",
      JSON.stringify({ name: a.name, mimeType: "application/vnd.google-apps.document" }),
      `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", a.content, `--${boundary}--`, "",
    ].join("\r\n");
    const r = await env.google.call<{ id: string; name: string; webViewLink?: string }>(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
      { method: "POST", raw: body, contentType: `multipart/related; boundary=${boundary}` },
    );
    return { fileId: r.id, name: r.name, link: r.webViewLink ?? null };
  },
});

const SHEET_ID = z.string().trim().regex(/^[A-Za-z0-9_-]{10,100}$/, "spreadsheet id");
const RANGE = z.string().trim().min(1).max(100);

const sheetsReadTool = tool({
  name: "sheets_read", connector: "sheets", kind: "read",
  description: "Google Sheets jadvalidan qiymatlarni o'qish (A1 diapazon).",
  parameters: { type: "object", properties: { spreadsheet_id: str("Jadval id (URL dagi /d/<id>/)"), range: str("Masalan: Sotuv!A1:F50") }, required: ["spreadsheet_id", "range"] },
  schema: z.object({ spreadsheet_id: SHEET_ID, range: RANGE }),
  summary: (a) => `Jadvalni o'qish: ${a.range}`,
  async run(env, a) {
    const r = await env.google.call<{ range: string; values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheet_id}/values/${encodeURIComponent(a.range)}`,
    );
    return { range: r.range, rows: (r.values ?? []).slice(0, 200), truncated: (r.values?.length ?? 0) > 200 };
  },
});

const sheetsAppendTool = tool({
  name: "sheets_append", connector: "sheets", kind: "write",
  description: "Google Sheets jadvaliga qatorlar qo'shish (odam tasdiqlagandan keyin).",
  parameters: {
    type: "object",
    properties: {
      spreadsheet_id: str("Jadval id"), range: str("Masalan: Sotuv!A:F"),
      rows: { type: "array", description: "Qatorlar", items: { type: "array", items: { type: "string" } } },
    },
    required: ["spreadsheet_id", "range", "rows"],
  },
  schema: z.object({ spreadsheet_id: SHEET_ID, range: RANGE, rows: z.array(z.array(z.union([z.string().max(2000), z.number()])).max(50)).min(1).max(200) }),
  summary: (a) => `Jadvalga ${a.rows.length} qator: ${a.range}`,
  async run(env, a) {
    const r = await env.google.call<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheet_id}/values/${encodeURIComponent(a.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: { values: a.rows } },
    );
    return { updatedRange: r.updates?.updatedRange ?? null, updatedRows: r.updates?.updatedRows ?? a.rows.length };
  },
});

const ISO = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO sana");

const calendarListTool = tool({
  name: "calendar_list_events", connector: "calendar", kind: "read",
  description: "Kompaniya kalendaridagi tadbirlar (oraliq bo'yicha).",
  parameters: { type: "object", properties: { time_min: str("Boshlanish, ISO 8601"), time_max: str("Tugash, ISO 8601") }, required: ["time_min", "time_max"] },
  schema: z.object({ time_min: ISO, time_max: ISO }),
  summary: (a) => `Kalendar: ${a.time_min.slice(0, 10)} – ${a.time_max.slice(0, 10)}`,
  async run(env, a) {
    const r = await env.google.call<{ items?: { id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string }[] }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({
        timeMin: new Date(a.time_min).toISOString(), timeMax: new Date(a.time_max).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "25",
      })}`,
    );
    return { events: (r.items ?? []).map((e) => ({ id: e.id, summary: e.summary ?? "", start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, location: e.location ?? null })) };
  },
});

const calendarCreateTool = tool({
  name: "calendar_create_event", connector: "calendar", kind: "write",
  description: "Kalendarga tadbir qo'shish; qatnashchilarga taklif yuboriladi (odam tasdiqlagandan keyin).",
  parameters: {
    type: "object",
    properties: {
      summary: str("Nomi"), start: str("Boshlanish, ISO 8601"), end: str("Tugash, ISO 8601"), description: str("Tavsif"),
      attendees: { type: "array", items: { type: "string" }, description: "Qatnashchilar emaili" },
    },
    required: ["summary", "start", "end"],
  },
  schema: z.object({
    summary: z.string().trim().min(1).max(200), start: ISO, end: ISO, description: z.string().max(5000).default(""),
    attendees: z.array(EMAIL).max(30).default([]),
  }).refine((e) => Date.parse(e.end) > Date.parse(e.start), "Tugash boshlanishdan keyin bo'lsin"),
  summary: (a) => `Tadbir: “${a.summary}” ${a.start.slice(0, 16)}${a.attendees.length ? ` (${a.attendees.length} qatnashchi)` : ""}`,
  async run(env, a) {
    const r = await env.google.call<{ id: string; htmlLink?: string }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${a.attendees.length ? "all" : "none"}`,
      {
        method: "POST",
        body: {
          summary: a.summary, description: a.description,
          start: { dateTime: new Date(a.start).toISOString(), timeZone: "Asia/Tashkent" }, end: { dateTime: new Date(a.end).toISOString(), timeZone: "Asia/Tashkent" },
          attendees: a.attendees.map((email) => ({ email })),
        },
      },
    );
    return { eventId: r.id, link: r.htmlLink ?? null };
  },
});

// ---------------------------------------------------------------- Slack, Notion

async function slack<T>(env: ToolEnv, method: string, body?: unknown): Promise<T> {
  if (!env.tokens.slack) throw new ConnectorError("SLACK_BOT_TOKEN sozlanmagan");
  const res = await env.http(`https://slack.com/api/${method}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${env.tokens.slack}`, ...(body ? { "content-type": "application/json; charset=utf-8" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!data.ok) throw new ConnectorError(`Slack: ${data.error ?? res.status}`, res.status);
  return data;
}

const slackChannelsTool = tool({
  name: "slack_list_channels", connector: "slack", kind: "read",
  description: "Slack kanallari ro'yxati.",
  parameters: { type: "object", properties: {} },
  schema: z.object({}).passthrough(),
  summary: () => "Slack kanallari",
  async run(env) {
    const r = await slack<{ channels?: { id: string; name: string; is_member?: boolean }[] }>(env, "conversations.list?types=public_channel&limit=200&exclude_archived=true");
    return { channels: (r.channels ?? []).map((c) => ({ id: c.id, name: c.name, member: !!c.is_member })) };
  },
});

const slackPostTool = tool({
  name: "slack_post_message", connector: "slack", kind: "write",
  description: "Slack kanaliga xabar yuborish (odam tasdiqlagandan keyin).",
  parameters: { type: "object", properties: { channel: str("Kanal id yoki #nomi"), text: str("Xabar") }, required: ["channel", "text"] },
  schema: z.object({ channel: z.string().trim().min(2).max(80), text: z.string().trim().min(1).max(4000) }),
  summary: (a) => `Slack ${a.channel}: “${clip(a.text, 90)}”`,
  async run(env, a) {
    const r = await slack<{ ts: string; channel: string }>(env, "chat.postMessage", { channel: a.channel, text: a.text });
    return { channel: r.channel, ts: r.ts };
  },
});

async function notion<T>(env: ToolEnv, path: string, body: unknown): Promise<T> {
  if (!env.tokens.notion) throw new ConnectorError("NOTION_TOKEN sozlanmagan");
  const res = await env.http(`https://api.notion.com/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.tokens.notion}`, "notion-version": "2022-06-28", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new ConnectorError(`Notion: ${data.message ?? res.status}`, res.status);
  return data;
}

const notionSearchTool = tool({
  name: "notion_search", connector: "notion", kind: "read",
  description: "Notion sahifalari va bazalaridan qidirish.",
  parameters: { type: "object", properties: { query: str("Qidiruv so'zi") }, required: ["query"] },
  schema: z.object({ query: z.string().trim().min(1).max(200) }),
  summary: (a) => `Notion'dan qidirish: “${a.query}”`,
  async run(env, a) {
    const r = await notion<{ results?: { id: string; object: string; url?: string; properties?: Record<string, { title?: { plain_text: string }[] }> }[] }>(env, "search", { query: a.query, page_size: 10 });
    return {
      results: (r.results ?? []).map((p) => ({
        id: p.id, type: p.object, url: p.url ?? null,
        title: Object.values(p.properties ?? {}).find((x) => x.title)?.title?.map((t) => t.plain_text).join("") ?? "",
      })),
    };
  },
});

const notionCreateTool = tool({
  name: "notion_create_page", connector: "notion", kind: "write",
  description: "Notion'da sahifa yaratish (odam tasdiqlagandan keyin).",
  parameters: { type: "object", properties: { parent_page_id: str("Ota sahifa id"), title: str("Sarlavha"), content: str("Matn") }, required: ["parent_page_id", "title", "content"] },
  schema: z.object({ parent_page_id: z.string().trim().regex(/^[0-9a-fA-F-]{32,36}$/, "Notion page id"), title: z.string().trim().min(1).max(200), content: z.string().min(1).max(100_000) }),
  summary: (a) => `Notion sahifa: “${a.title}”`,
  async run(env, a) {
    const paras = a.content.split(/\n{2,}/).flatMap((p) => p.match(/[\s\S]{1,1900}/g) ?? []).slice(0, 100);
    const r = await notion<{ id: string; url?: string }>(env, "pages", {
      parent: { page_id: a.parent_page_id },
      properties: { title: { title: [{ text: { content: a.title } }] } },
      children: paras.map((t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: t } }] } })),
    });
    return { pageId: r.id, url: r.url ?? null };
  },
});

export const TOOLS: ToolDef[] = [
  searchKnowledgeTool, listPeopleTool, proposeMemoryTool, createEmployeeTaskTool,
  webSearchTool, telegramPostTool,
  gmailSearchTool, gmailSendTool, driveSearchTool, driveCreateTool, sheetsReadTool, sheetsAppendTool, calendarListTool, calendarCreateTool,
  slackChannelsTool, slackPostTool, notionSearchTool, notionCreateTool,
];

/** Internal read tools every agent has (they only read company data the agent may already see, or propose). */
export const ALWAYS_ON = new Set(["search_company_knowledge", "list_company_people", "propose_company_memory"]);

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
