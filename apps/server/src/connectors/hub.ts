// Connector hub: real connection state, which tools an agent may use, running read tools, turning write tools into
// approval requests, and executing them once a person approves. Every call is recorded in tool_executions.
import { createHash } from "node:crypto";
import type { ToolCall, ToolSpec, LlmClient } from "../llm/types.js";
import type { Ctx } from "../domain/context.js";
import { now } from "../db/db.js";
import type { AuthUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { embedderOf } from "../knowledge/semantic.js";
import { ConnectorError, GoogleAuth } from "./google.js";
import { SecretStore, parseKey } from "./secrets.js";
import { ALWAYS_ON, TOOLS, toolByName, type ToolDef, type ToolEnv } from "./tools.js";

export interface ConnectorConfig {
  /** public base URL of the web app (OAuth redirect goes to <publicUrl>/api/connectors/google/callback) */
  publicUrl: string;
  secretsKey?: string;
  google: { clientId?: string; clientSecret?: string; refreshToken?: string };
  slackToken?: string;
  notionToken?: string;
}

export interface ConnectorState {
  id: string;
  name: string;
  implemented: boolean;
  connected: boolean;
  reason: string | null;
  account: string | null;
  /** environment variables / steps still needed */
  setup: string[];
  tools: { name: string; kind: "read" | "write"; description: string }[];
}

interface Bot { postToGroup(text: string): void; active: boolean }

const GOOGLE = new Set(["gmail", "drive", "sheets", "calendar"]);
const MAX_OUTPUT = 6000;

export class ConnectorHub {
  readonly secrets: SecretStore;
  readonly google: GoogleAuth;
  private http: typeof fetch;

  constructor(
    private ctx: Ctx,
    private cfg: ConnectorConfig,
    private deps: { llm: () => LlmClient | null; telegram: () => Bot | undefined; http?: typeof fetch },
  ) {
    this.http = deps.http ?? fetch;
    this.secrets = new SecretStore(ctx.db, parseKey(cfg.secretsKey));
    this.google = new GoogleAuth(
      { ...cfg.google, redirectUri: `${cfg.publicUrl.replace(/\/+$/, "")}/api/connectors/google/callback` },
      this.secrets, this.http,
    );
  }

  // ---------------------------------------------------------------- state

  availability(id: string): { implemented: boolean; connected: boolean; reason: string | null; account: string | null; setup: string[] } {
    const llm = this.deps.llm();
    if (id === "internal-api") return { implemented: true, connected: true, reason: null, account: "SAG AI Office", setup: [] };
    if (id === "web-search") {
      const ok = !!llm?.searchWeb;
      return { implemented: true, connected: ok, reason: ok ? (llm!.mode === "mock" ? "MOCK rejim — haqiqiy qidiruv emas" : null) : "AI provayder ulanmagan", account: ok ? `${llm!.provider} · google_search` : null, setup: ok ? [] : ["GEMINI_API_KEY"] };
    }
    if (id === "telegram") {
      const bot = this.deps.telegram();
      return { implemented: true, connected: !!bot?.active, reason: bot?.active ? null : "Telegram bot ishlamayapti", account: null, setup: bot ? [] : ["TELEGRAM_BOT_TOKEN", "TELEGRAM_GROUP_ID"] };
    }
    if (GOOGLE.has(id)) {
      if (!this.google.configured)
        return { implemented: true, connected: false, reason: "Google OAuth ilovasi sozlanmagan", account: null, setup: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_URL", "SECRETS_KEY"] };
      if (!this.google.connected)
        return {
          implemented: true, connected: false, reason: "Google hisobi ulanmagan — “Google bilan ulash” tugmasini bosing", account: null,
          setup: this.secrets.enabled ? [] : ["SECRETS_KEY (tokenni shifrlab saqlash uchun)"],
        };
      return { implemented: true, connected: true, reason: null, account: this.google.account, setup: [] };
    }
    if (id === "slack")
      return { implemented: true, connected: !!this.cfg.slackToken, reason: this.cfg.slackToken ? null : "Slack bot tokeni yo'q", account: null, setup: this.cfg.slackToken ? [] : ["SLACK_BOT_TOKEN"] };
    if (id === "notion")
      return { implemented: true, connected: !!this.cfg.notionToken, reason: this.cfg.notionToken ? null : "Notion integratsiya tokeni yo'q", account: null, setup: this.cfg.notionToken ? [] : ["NOTION_TOKEN"] };
    return {
      implemented: false, connected: false, account: null, setup: [],
      reason: "Integratsiya hali yozilmagan: qaysi tizim ishlatilishini (masalan Bitrix24, amoCRM, 1C, SAP) aniqlash kerak",
    };
  }

  status(): ConnectorState[] {
    return this.ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM connectors ORDER BY name").map((c) => ({
      id: c.id, name: c.name, ...this.availability(c.id),
      tools: TOOLS.filter((t) => t.connector === c.id).map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
    }));
  }

  /** Mirror the real state into the connectors table (shown everywhere in the UI). Telegram keeps its own check. */
  sync() {
    for (const c of this.status()) {
      if (c.id === "telegram" || !c.implemented) continue;
      this.ctx.db.run(
        "UPDATE connectors SET status = ?, auth_status = ?, last_health_at = ?, last_error = ? WHERE id = ?",
        c.connected ? "connected" : "disconnected", c.connected ? "authenticated" : c.setup.length ? "not_configured" : "configured",
        now(), c.connected ? null : c.reason, c.id,
      );
    }
  }

  // ---------------------------------------------------------------- per agent

  /** Tools this agent may use right now: always-on internal reads + granted connectors that are connected. */
  toolsFor(agentId: string): ToolDef[] {
    const a = this.ctx.db.get<{ department_id: string; lifecycle: string; business_unit_id: string }>("SELECT department_id, lifecycle, business_unit_id FROM agents WHERE id = ?", agentId);
    if (!a || a.lifecycle !== "ACTIVE") return [];
    // Connectors and the internal tools (company documents, people, memory) belong to HQ. Agents of other units get
    // none until per-unit connector installations exist (SAG World W2).
    if (a.business_unit_id !== "hq") return [];
    const grants = new Map(
      this.ctx.db.all<{ connector_id: string; allowed_actions: string }>(
        `SELECT p.connector_id, p.allowed_actions FROM agent_connector_permissions p
         JOIN department_connectors dc ON dc.connector_id = p.connector_id AND dc.department_id = ?
         WHERE p.agent_id = ?`, a.department_id, agentId,
      ).map((g) => [g.connector_id, safeArray(g.allowed_actions)]),
    );
    const up = new Map<string, boolean>();
    const connected = (id: string) => {
      if (!up.has(id)) up.set(id, this.availability(id).connected);
      return up.get(id)!;
    };
    return TOOLS.filter((t) => {
      if (ALWAYS_ON.has(t.name)) return true;
      const g = grants.get(t.connector);
      return !!g && g.includes(t.kind) && connected(t.connector);
    });
  }

  specs(tools: ToolDef[]): ToolSpec[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.kind === "write" ? `${t.description} [YOZISH: odam tasdiqlaguncha bajarilmaydi]` : t.description,
      parameters: t.parameters,
    }));
  }

  private env(agentId: string, taskId: string | null, correlationId: string, approver?: AuthUser): ToolEnv {
    const llm = this.deps.llm();
    const dep = this.ctx.db.get<{ department_id: string }>("SELECT department_id FROM agents WHERE id = ?", agentId)?.department_id ?? null;
    return {
      ctx: this.ctx, agentId, departmentId: dep, taskId, correlationId, google: this.google, http: this.http,
      tokens: { slack: this.cfg.slackToken, notion: this.cfg.notionToken },
      llm: llm ? { searchWeb: llm.searchWeb?.bind(llm), mode: llm.mode } : null,
      telegram: this.deps.telegram() ?? null, embedder: embedderOf(llm), approver,
    };
  }

  private record(e: { runId: string; tool: ToolDef; input: unknown; status: string; taskId: string | null; agentId: string; approvalId?: string | null; output?: unknown; error?: string | null; idempotencyKey?: string }) {
    const id = uid("tex");
    this.ctx.db.run(
      `INSERT INTO tool_executions (id, run_id, tool, connector_id, input, output, status, error, started_at, finished_at, approval_id, agent_id, task_id, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, e.runId, e.tool.name, e.tool.connector, clip(JSON.stringify(e.input)), e.output === undefined ? null : clip(JSON.stringify(e.output)),
      e.status, e.error ?? null, now(), e.status === "pending_approval" || e.status === "running" ? null : now(), e.approvalId ?? null, e.agentId, e.taskId,
      e.idempotencyKey ?? null,
    );
    return id;
  }

  /**
   * An approved external action that was cut off mid-call (process crash or deploy) has an unknown outcome: the
   * e-mail may or may not have gone out. It is marked `unknown` for a person to check — never retried
   * automatically. Call once at startup of the process that runs approved actions.
   */
  markInterrupted(): number {
    return this.ctx.db.run(
      `UPDATE tool_executions SET status = 'unknown', finished_at = ?,
         error = 'Bajarilish uzildi (server to''xtadi): natija noma''lum — tashqi tizimda tekshiring, avtomatik qayta urinilmaydi'
       WHERE status = 'running'`,
      now(),
    ).changes;
  }

  /**
   * One tool call from the model. Returns what the model sees next. Never throws for tool problems —
   * the model gets the error text and can adapt (or explain it in the deliverable).
   */
  async invoke(c: { taskId: string | null; agentId: string; runId: string; correlationId: string }, call: ToolCall): Promise<Record<string, unknown>> {
    const tool = toolByName(call.name);
    if (!tool || !this.toolsFor(c.agentId).some((t) => t.name === tool.name)) {
      if (tool) this.record({ ...c, tool, input: call.args, status: "denied", error: "not permitted" });
      return { error: "Bu vosita sizga ruxsat etilmagan yoki ulanmagan" };
    }
    const parsed = tool.schema.safeParse(call.args ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
      this.record({ ...c, tool, input: call.args, status: "failed", error: `validation: ${msg}` });
      return { error: `Noto'g'ri argumentlar: ${msg}` };
    }
    const args = parsed.data as Record<string, unknown>;
    this.ctx.bus.emit("connector.activity", { taskId: c.taskId, agentId: c.agentId }, { connector: tool.connector, tool: tool.name, kind: tool.kind });
    if (tool.kind === "write") {
      // The same action proposed again (a retried or re-run step) joins the request already waiting for a person.
      const idempotencyKey = `${c.taskId ?? "-"}:${tool.name}:${createHash("sha256").update(stableJson(args)).digest("hex")}`;
      const waiting = this.ctx.db.get<{ approval_id: string }>(
        "SELECT approval_id FROM tool_executions WHERE idempotency_key = ? AND status = 'pending_approval'", idempotencyKey,
      );
      if (waiting)
        return { status: "pending_approval", approvalId: waiting.approval_id, note: "Bu amal allaqachon tasdiqqa yuborilgan — qayta yuborilmadi." };
      const approvalId = uid("apr");
      const summary = tool.summary(args);
      this.ctx.db.tx(() => {
        this.ctx.db.run(
          "INSERT INTO approvals (id, task_id, agent_id, action, payload, status, requested_at) VALUES (?,?,?,?,?, 'PENDING', ?)",
          approvalId, c.taskId, c.agentId, `tool:${tool.name}`, JSON.stringify({ tool: tool.name, connector: tool.connector, summary, args }), now(),
        );
        this.record({ ...c, tool, input: args, status: "pending_approval", approvalId, idempotencyKey });
        audit(this.ctx.db, { type: "agent", id: c.agentId }, "tool.propose", { type: "approval", id: approvalId }, { tool: tool.name, summary });
      });
      this.ctx.bus.emit("approval.requested", { taskId: c.taskId, agentId: c.agentId }, { approvalId, action: `tool:${tool.name}`, title: summary });
      return { status: "pending_approval", approvalId, note: "Amal odam tasdiqlashini kutmoqda. Bajarildi deb yozma — 'tasdiqqa yuborildi' de." };
    }
    try {
      const out = await tool.run(this.env(c.agentId, c.taskId, c.correlationId), args);
      this.record({ ...c, tool, input: args, status: "succeeded", output: out });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.record({ ...c, tool, input: args, status: "failed", error: msg });
      return { error: msg };
    }
  }

  /**
   * A person decides on an agent's write action. Approve → the action runs now, with the approver's rights where
   * they matter (e.g. creating an employee task). The approval row is claimed atomically, so it can run only once.
   */
  async decide(approvalId: string, decision: "approve" | "reject", reason: string | undefined, user: AuthUser) {
    const a = this.ctx.db.get<{ id: string; action: string; status: string; agent_id: string | null; task_id: string | null; payload: string }>(
      "SELECT id, action, status, agent_id, task_id, payload FROM approvals WHERE id = ?", approvalId,
    );
    if (!a || !a.action.startsWith("tool:")) throw notFound("Amal so'rovi");
    if (a.status !== "PENDING") throw conflict("approval_decided", "Bu so'rov allaqachon hal qilingan");
    if (decision === "reject" && !reason?.trim()) throw badRequest("Rad etish sababini yozing");
    const exec = this.ctx.db.get<{ id: string; tool: string; input: string }>("SELECT id, tool, input FROM tool_executions WHERE approval_id = ?", approvalId);
    const tool = exec && toolByName(exec.tool);
    if (!exec || !tool) throw notFound("Amal");
    const claimed = this.ctx.db.run(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ?, decided_via = 'web' WHERE id = ? AND status = 'PENDING'",
      decision === "approve" ? "APPROVED" : "REJECTED", user.id, now(), reason ?? null, approvalId,
    );
    if (claimed.changes !== 1) throw conflict("approval_decided", "Bu so'rov allaqachon hal qilingan");
    audit(this.ctx.db, { type: "user", id: user.id }, "tool.decide", { type: "approval", id: approvalId }, { decision, tool: tool.name, reason });
    if (decision === "reject") {
      this.ctx.db.run("UPDATE tool_executions SET status = 'denied', error = ?, finished_at = ? WHERE id = ?", `rad etildi: ${reason}`, now(), exec.id);
      this.ctx.bus.emit("connector.activity", { taskId: a.task_id, agentId: a.agent_id }, { connector: tool.connector, tool: tool.name, status: "denied" });
      return this.execution(exec.id);
    }
    this.ctx.db.run("UPDATE tool_executions SET status = 'running' WHERE id = ?", exec.id);
    try {
      const out = await tool.run(this.env(a.agent_id ?? "", a.task_id, approvalId, user), JSON.parse(exec.input));
      this.ctx.db.run("UPDATE tool_executions SET status = 'succeeded', output = ?, finished_at = ? WHERE id = ?", clip(JSON.stringify(out)), now(), exec.id);
      audit(this.ctx.db, { type: "user", id: user.id }, "tool.execute", { type: "tool_execution", id: exec.id }, { tool: tool.name, ok: true });
    } catch (e) {
      const msg = e instanceof ConnectorError || e instanceof Error ? e.message : String(e);
      this.ctx.db.run("UPDATE tool_executions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", msg, now(), exec.id);
      audit(this.ctx.db, { type: "user", id: user.id }, "tool.execute", { type: "tool_execution", id: exec.id }, { tool: tool.name, ok: false, error: msg });
    }
    this.ctx.bus.emit("connector.activity", { taskId: a.task_id, agentId: a.agent_id }, { connector: tool.connector, tool: tool.name, status: "executed" });
    return this.execution(exec.id);
  }

  execution(id: string) {
    const r = this.ctx.db.get<Record<string, unknown>>(
      `SELECT id, tool, connector_id connectorId, input, output, status, error, started_at startedAt, finished_at finishedAt, approval_id approvalId,
              agent_id agentId, task_id taskId FROM tool_executions WHERE id = ?`, id,
    )!;
    return { ...r, input: safeJson(r.input), output: safeJson(r.output) };
  }

  /** Activity log for The Brain (newest first). */
  activity(limit = 50) {
    return this.ctx.db.all<Record<string, unknown>>(
      `SELECT e.id, e.tool, e.connector_id connectorId, e.status, e.error, e.started_at startedAt, e.finished_at finishedAt, e.approval_id approvalId,
              e.agent_id agentId, a.name agentName, e.task_id taskId, t.title taskTitle, e.input, e.output
       FROM tool_executions e LEFT JOIN agents a ON a.id = e.agent_id LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.agent_id IS NOT NULL AND a.business_unit_id = 'hq' ORDER BY e.started_at DESC LIMIT ?`, limit,
    ).map((r) => ({ ...r, input: safeJson(r.input), output: safeJson(r.output) }));
  }

  /** Live check of a connector's credentials (Google token refresh, Slack auth.test, Notion users/me). */
  async verify(id: string): Promise<{ ok: boolean; detail: string }> {
    try {
      if (GOOGLE.has(id)) {
        await this.google.token();
        return this.finishVerify(id, true, `Google ulangan: ${this.google.account ?? "hisob"}`);
      }
      if (id === "slack") {
        const r = await this.http("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${this.cfg.slackToken ?? ""}` } });
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; team?: string; error?: string };
        return this.finishVerify(id, !!d.ok, d.ok ? `Slack: ${d.team}` : `Slack: ${d.error ?? r.status}`);
      }
      if (id === "notion") {
        const r = await this.http("https://api.notion.com/v1/users/me", { headers: { authorization: `Bearer ${this.cfg.notionToken ?? ""}`, "notion-version": "2022-06-28" } });
        const d = (await r.json().catch(() => ({}))) as { name?: string; message?: string };
        return this.finishVerify(id, r.ok, r.ok ? `Notion: ${d.name ?? "integratsiya"}` : `Notion: ${d.message ?? r.status}`);
      }
      const s = this.availability(id);
      return { ok: s.connected, detail: s.reason ?? "ulangan" };
    } catch (e) {
      return this.finishVerify(id, false, e instanceof Error ? e.message : String(e));
    }
  }

  private finishVerify(id: string, ok: boolean, detail: string) {
    this.ctx.db.run(
      "UPDATE connectors SET status = ?, auth_status = ?, last_health_at = ?, last_error = ? WHERE id = ?",
      ok ? "connected" : "error", ok ? "authenticated" : "error", now(), ok ? null : detail, id,
    );
    return { ok, detail };
  }
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function safeJson(v: unknown) {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
/** JSON with sorted keys, so equal arguments always hash the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}…` : s);
