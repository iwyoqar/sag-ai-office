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
import { ConnectorError, GOOGLE_SCOPES, GoogleAuth } from "./google.js";
import { SecretStore, parseKey } from "./secrets.js";
import { ALWAYS_ON, TOOLS, UNIT_INTERNAL, toolByName, type ToolDef, type ToolEnv } from "./tools.js";
import { ensureHqInstallations } from "./installations.js";
import { CredentialVault } from "./vault.js";
import { STORABLE_AUTH, definitionOf } from "./registry.js";
import { type Classified, HEALTH_CLASSES, READ_RETRY, RateLimiter, type RetryPolicy, classify, fetchWithTimeout, withRetry } from "./reliability.js";

/** Why a tool call was refused, in the order the checks run (connectors/hub.ts authorizeTool). */
export type DenyReason =
  | "agent_inactive" | "unit_mismatch" | "unknown_tool" | "not_assigned" | "tool_not_permitted" | "missing_scope"
  | "write_not_permitted" | "not_connected";
export type ToolAuthorization =
  | { ok: true; instanceId: string | null; mode: "auto" | "approval" }
  | { ok: false; reason: DenyReason };

interface InstanceRow { id: string; connector_id: string; scope_level: string; business_unit_id: string | null; status: string; enabled: number }

export interface HubReliability { toolTimeoutMs: number; readRetry: RetryPolicy; callsPerMinute: number; sleep?: (ms: number) => Promise<unknown> }
const DEFAULT_RELIABILITY: HubReliability = { toolTimeoutMs: 20_000, readRetry: READ_RETRY, callsPerMinute: 60 };

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
  readonly vault: CredentialVault;
  readonly google: GoogleAuth;
  private http: typeof fetch;
  private rel: HubReliability;
  private limiter: RateLimiter;

  constructor(
    private ctx: Ctx,
    private cfg: ConnectorConfig,
    private deps: { llm: () => LlmClient | null; telegram: () => Bot | undefined; http?: typeof fetch; reliability?: Partial<HubReliability> },
  ) {
    this.http = deps.http ?? fetch;
    this.rel = { ...DEFAULT_RELIABILITY, ...deps.reliability };
    this.limiter = new RateLimiter(this.rel.callsPerMinute);
    this.secrets = new SecretStore(ctx.db, parseKey(cfg.secretsKey));
    this.vault = new CredentialVault(ctx.db, parseKey(cfg.secretsKey));
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
    ensureHqInstallations(this.ctx.db);
    for (const c of this.status()) {
      if (c.id === "telegram" || !c.implemented) continue;
      this.ctx.db.run(
        "UPDATE connectors SET status = ?, auth_status = ?, last_health_at = ?, last_error = ? WHERE id = ?",
        c.connected ? "connected" : "disconnected", c.connected ? "authenticated" : c.setup.length ? "not_configured" : "configured",
        now(), c.connected ? null : c.reason, c.id,
      );
    }
    // credentials are server-wide today, so every unit's installation of a connector shares its health
    this.ctx.db.run(
      `UPDATE connector_installations SET status = (SELECT c.status FROM connectors c WHERE c.id = connector_id),
         last_error = (SELECT c.last_error FROM connectors c WHERE c.id = connector_id), last_health_at = ?`,
      now(),
    );
  }

  // ---------------------------------------------------------------- per agent

  /** Tools this agent may use right now — exactly those authorizeTool() would let it call. */
  toolsFor(agentId: string): ToolDef[] {
    return TOOLS.filter((t) => this.authorizeTool(agentId, null, t.name).ok);
  }

  /** The instance serving `connectorId` for a unit: its own enabled instance, else an assigned region/group one. */
  instanceFor(unitId: string, connectorId: string): InstanceRow | undefined {
    return this.ctx.db.get<InstanceRow>(
      `SELECT id, connector_id, scope_level, business_unit_id, status, enabled FROM connector_installations
       WHERE connector_id = ? AND enabled = 1 AND (business_unit_id = ?
         OR id IN (SELECT instance_id FROM connector_instance_assignments WHERE business_unit_id = ?))
       ORDER BY CASE scope_level WHEN 'UNIT' THEN 0 WHEN 'REGION' THEN 1 ELSE 2 END LIMIT 1`,
      connectorId, unitId, unitId,
    );
  }

  /** Secret for an instance: its own stored credential; HQ instances may still use the server environment. */
  private tokenFor(inst: InstanceRow | undefined, connectorId: "slack" | "notion"): string | undefined {
    if (!inst) return undefined;
    const stored = this.vault.resolve(inst.id, "API_KEY");
    if (stored) return stored;
    return inst.business_unit_id === "hq" ? (connectorId === "slack" ? this.cfg.slackToken : this.cfg.notionToken) : undefined;
  }

  private instanceConnected(inst: InstanceRow): boolean {
    const id = inst.connector_id;
    if (STORABLE_AUTH[id]) return !!this.tokenFor(inst, id as "slack" | "notion");
    // credentials of every other connector live in the server environment and belong to HQ
    if (inst.business_unit_id !== "hq" && id !== "web-search" && id !== "internal-api") return false;
    return this.availability(id).connected;
  }

  /**
   * Scopes the instance's account granted. Google via OAuth consent: exactly what Google returned (stored). Google
   * via an operator-provided GOOGLE_REFRESH_TOKEN: unknown to us, taken as the scopes this app requests
   * (GOOGLE_SCOPES) — documented limitation. Connectors without scopes need none.
   */
  private grantedScopes(inst: InstanceRow): string[] {
    if (!GOOGLE.has(inst.connector_id) || inst.business_unit_id !== "hq") return [];
    const stored = this.secrets.info("google");
    if (stored) return safeArray(stored.scopes);
    return this.cfg.google.refreshToken ? [...GOOGLE_SCOPES] : [];
  }

  /**
   * The only gate for agent tool calls, in a fixed order: 1 agent identity, 2 business-unit ownership of the task,
   * 3 connector assignment to the agent's unit, 4 tool permission (grant), 5 required scopes, 6 read/write
   * permission, then a live connection; 7 the approval policy decides how it runs (reads: at once, writes: approval).
   */
  authorizeTool(agentId: string, taskId: string | null, toolName: string): ToolAuthorization {
    const a = this.ctx.db.get<{ department_id: string; lifecycle: string; business_unit_id: string }>(
      "SELECT department_id, lifecycle, business_unit_id FROM agents WHERE id = ?", agentId,
    );
    if (!a || a.lifecycle !== "ACTIVE") return { ok: false, reason: "agent_inactive" };
    if (taskId) {
      const t = this.ctx.db.get<{ u: string }>("SELECT business_unit_id u FROM tasks WHERE id = ?", taskId);
      if (!t || t.u !== a.business_unit_id) return { ok: false, reason: "unit_mismatch" };
    }
    const tool = toolByName(toolName);
    if (!tool) return { ok: false, reason: "unknown_tool" };
    const hq = a.business_unit_id === "hq";
    if (ALWAYS_ON.has(tool.name)) return hq || UNIT_INTERNAL.has(tool.name) ? { ok: true, instanceId: null, mode: "auto" } : { ok: false, reason: "tool_not_permitted" };
    const inst = this.instanceFor(a.business_unit_id, tool.connector);
    if (!inst) return { ok: false, reason: "not_assigned" };
    const grant = this.ctx.db.get<{ allowed_actions: string }>(
      `SELECT p.allowed_actions FROM agent_connector_permissions p
       JOIN department_connectors dc ON dc.connector_id = p.connector_id AND dc.department_id = ?
       WHERE p.agent_id = ? AND p.connector_id = ?`, a.department_id, agentId, tool.connector,
    );
    if (!grant) return { ok: false, reason: "tool_not_permitted" };
    const needed = definitionOf(tool.connector)?.actions.find((x) => x.tool === tool.name)?.scopes ?? [];
    if (needed.length) {
      const granted = this.grantedScopes(inst);
      if (needed.some((sc) => !granted.includes(sc))) return { ok: false, reason: "missing_scope" };
    }
    const allowed = safeArray(grant.allowed_actions);
    if (!allowed.includes(tool.kind)) return { ok: false, reason: tool.kind === "write" ? "write_not_permitted" : "tool_not_permitted" };
    if (!this.instanceConnected(inst)) return { ok: false, reason: "not_connected" };
    return { ok: true, instanceId: inst.id, mode: tool.kind === "write" ? "approval" : "auto" };
  }

  /** Health bookkeeping after a real call: failures of the connection itself degrade, then take it down. */
  private noteHealth(instanceId: string | null, ok: boolean, c?: Classified) {
    if (!instanceId) return;
    if (ok) {
      this.ctx.db.run(
        "UPDATE connector_installations SET health_status = 'HEALTHY', consecutive_failures = 0, last_error = NULL, last_error_class = NULL, last_health_at = ? WHERE id = ?",
        now(), instanceId,
      );
      return;
    }
    if (!c || !HEALTH_CLASSES.includes(c.cls)) return;
    this.ctx.db.run(
      `UPDATE connector_installations SET consecutive_failures = consecutive_failures + 1,
         health_status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'DOWN' ELSE 'DEGRADED' END,
         last_error = ?, last_error_class = ?, last_health_at = ? WHERE id = ?`,
      c.message.slice(0, 300), c.cls, now(), instanceId,
    );
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
    const ag = this.ctx.db.get<{ department_id: string; business_unit_id: string }>("SELECT department_id, business_unit_id FROM agents WHERE id = ?", agentId);
    const dep = ag?.department_id ?? null;
    const unit = ag?.business_unit_id ?? "none";
    return {
      ctx: this.ctx, agentId, departmentId: dep, unitId: unit, taskId, correlationId, google: this.google,
      // every provider call has a deadline; credentials come from the instance serving the agent's unit
      http: fetchWithTimeout(this.http, this.rel.toolTimeoutMs),
      tokens: { slack: this.tokenFor(this.instanceFor(unit, "slack"), "slack"), notion: this.tokenFor(this.instanceFor(unit, "notion"), "notion") },
      llm: llm ? { searchWeb: llm.searchWeb?.bind(llm), mode: llm.mode } : null,
      telegram: this.deps.telegram() ?? null, embedder: embedderOf(llm), approver,
    };
  }

  private record(e: {
    runId: string; tool: ToolDef; input: unknown; status: string; taskId: string | null; agentId: string; approvalId?: string | null; output?: unknown;
    error?: string | null; idempotencyKey?: string; instanceId?: string | null; attempts?: number; errorClass?: string | null;
  }) {
    const id = uid("tex");
    this.ctx.db.run(
      `INSERT INTO tool_executions (id, run_id, tool, connector_id, input, output, status, error, started_at, finished_at, approval_id, agent_id, task_id, idempotency_key,
         instance_id, attempts, error_class)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, e.runId, e.tool.name, e.tool.connector, clip(JSON.stringify(e.input)), e.output === undefined ? null : clip(JSON.stringify(e.output)),
      e.status, e.error ?? null, now(), e.status === "pending_approval" || e.status === "running" ? null : now(), e.approvalId ?? null, e.agentId, e.taskId,
      e.idempotencyKey ?? null, e.instanceId ?? null, e.attempts ?? 1, e.errorClass ?? null,
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
    const auth = this.authorizeTool(c.agentId, c.taskId, call.name);
    if (!tool || !auth.ok) {
      const reason = auth.ok ? "unknown_tool" : auth.reason;
      if (tool) this.record({ ...c, tool, input: call.args, status: "denied", error: `not permitted: ${reason}`, errorClass: "permission" });
      return { error: "Bu vosita sizga ruxsat etilmagan yoki ulanmagan", reason };
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
        this.record({ ...c, tool, input: args, status: "pending_approval", approvalId, idempotencyKey, instanceId: auth.instanceId });
        audit(this.ctx.db, { type: "agent", id: c.agentId }, "tool.propose", { type: "approval", id: approvalId }, { tool: tool.name, summary });
      });
      this.ctx.bus.emit("approval.requested", { taskId: c.taskId, agentId: c.agentId }, { approvalId, action: `tool:${tool.name}`, title: summary });
      return { status: "pending_approval", approvalId, note: "Amal odam tasdiqlashini kutmoqda. Bajarildi deb yozma — 'tasdiqqa yuborildi' de." };
    }
    // reads: rate-limited per instance, deadline per call, retried only on transient failures
    if (auth.instanceId && !this.limiter.take(auth.instanceId)) {
      this.record({ ...c, tool, input: args, status: "failed", error: "rate limit", errorClass: "rate_limited", instanceId: auth.instanceId, attempts: 0 });
      return { error: "Connector chaqiruvlari limiti: birozdan keyin qayta urinib ko'ring", reason: "rate_limited" };
    }
    try {
      const env = this.env(c.agentId, c.taskId, c.correlationId);
      const { value: out, attempts } = await withRetry(() => tool.run(env, args), this.rel.readRetry, this.rel.sleep);
      this.record({ ...c, tool, input: args, status: "succeeded", output: out, instanceId: auth.instanceId, attempts });
      this.noteHealth(auth.instanceId, true);
      return out;
    } catch (e) {
      const cl = (e as { classified?: Classified }).classified ?? classify(e);
      const attempts = (e as { attempts?: number }).attempts ?? 1;
      this.record({ ...c, tool, input: args, status: "failed", error: cl.message, errorClass: cl.cls, instanceId: auth.instanceId, attempts });
      this.noteHealth(auth.instanceId, false, cl);
      return { error: cl.message, reason: cl.cls };
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
    // permissions may have changed while the request waited: authorise again at execution time
    const auth = decision === "approve" && a.agent_id ? this.authorizeTool(a.agent_id, a.task_id, tool.name) : null;
    if (auth && !auth.ok) throw conflict("not_permitted_now", `Amalni endi bajarib bo'lmaydi: ${auth.reason}`);
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
    const instanceId = auth && auth.ok ? auth.instanceId : null;
    // a write runs exactly once — never retried. If its outcome cannot be known (deadline, network), it is
    // recorded as "unknown" for a person to check in the external system.
    try {
      const out = await tool.run(this.env(a.agent_id ?? "", a.task_id, approvalId, user), JSON.parse(exec.input));
      this.ctx.db.run("UPDATE tool_executions SET status = 'succeeded', output = ?, finished_at = ?, instance_id = ? WHERE id = ?", clip(JSON.stringify(out)), now(), instanceId, exec.id);
      audit(this.ctx.db, { type: "user", id: user.id }, "tool.execute", { type: "tool_execution", id: exec.id }, { tool: tool.name, ok: true });
      this.noteHealth(instanceId, true);
    } catch (e) {
      const cl = classify(e);
      const status = cl.cls === "timeout" || cl.cls === "network" ? "unknown" : "failed";
      const msg = status === "unknown" ? `natija noma'lum (${cl.cls}): tashqi tizimda tekshiring — qayta yuborilmaydi` : cl.message;
      this.ctx.db.run("UPDATE tool_executions SET status = ?, error = ?, error_class = ?, finished_at = ?, instance_id = ? WHERE id = ?", status, msg, cl.cls, now(), instanceId, exec.id);
      audit(this.ctx.db, { type: "user", id: user.id }, "tool.execute", { type: "tool_execution", id: exec.id }, { tool: tool.name, ok: false, error: msg, errorClass: cl.cls });
      this.noteHealth(instanceId, false, cl);
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

  /**
   * Health check of one instance, recorded in connector_runs: Slack/Notion with the instance's own credential,
   * HQ instances of the other connectors with the existing live checks, Gemini through the AI provider.
   */
  async checkInstance(instanceId: string): Promise<{ ok: boolean; detail: string; errorClass: string | null }> {
    const inst = this.ctx.db.get<InstanceRow>("SELECT id, connector_id, scope_level, business_unit_id, status, enabled FROM connector_installations WHERE id = ?", instanceId);
    if (!inst) throw notFound("Connector");
    const def = definitionOf(inst.connector_id);
    if (!def || def.status !== "AVAILABLE" || !def.healthCheck) throw badRequest("Bu connector uchun tekshiruv mavjud emas");
    const runId = uid("crun");
    const started = Date.now();
    this.ctx.db.run("INSERT INTO connector_runs (id, instance_id, kind, status, started_at) VALUES (?, ?, 'HEALTH', 'RUNNING', ?)", runId, instanceId, now());
    let ok = false;
    let detail = "";
    let cls: string | null = null;
    try {
      const http = fetchWithTimeout(this.http, this.rel.toolTimeoutMs);
      if (inst.connector_id === "slack" || inst.connector_id === "notion") {
        const token = this.tokenFor(inst, inst.connector_id);
        if (!token) throw new ConnectorError("kalit yo'q", 0);
        const r = inst.connector_id === "slack"
          ? await http("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${token}` } })
          : await http("https://api.notion.com/v1/users/me", { headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28" } });
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; team?: string; error?: string; name?: string; message?: string };
        ok = inst.connector_id === "slack" ? !!d.ok : r.ok;
        detail = ok ? `${def.name}: ${d.team ?? d.name ?? "ulangan"}` : `${def.name}: ${d.error ?? d.message ?? r.status}`;
        if (!ok) cls = r.status === 429 ? "rate_limited" : r.status >= 500 ? "provider" : "auth";
      } else if (inst.connector_id === "gemini") {
        const llm = this.deps.llm();
        if (!llm || llm.provider !== "gemini") throw new ConnectorError("Gemini sozlanmagan", 0);
        const h = await llm.health();
        ok = h.ok;
        detail = h.ok ? `Gemini: ${h.model}` : `Gemini: ${h.detail ?? "xato"}`;
        if (!ok) cls = /key|ruxsat|auth/i.test(h.detail ?? "") ? "auth" : "provider";
      } else if (inst.business_unit_id === "hq") {
        const r = await this.verify(inst.connector_id);
        ok = r.ok;
        detail = r.detail;
        if (!ok) cls = "auth";
      } else throw new ConnectorError("bu connectorning kaliti faqat HQ serverida", 0);
    } catch (e) {
      const c = classify(e);
      ok = false;
      detail = c.message;
      cls = c.cls;
    }
    this.ctx.db.tx(() => {
      this.ctx.db.run("UPDATE connector_runs SET status = ?, error_class = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?",
        ok ? "SUCCEEDED" : "FAILED", cls, ok ? null : detail.slice(0, 300), now(), Date.now() - started, runId);
      this.ctx.db.run("UPDATE connector_installations SET status = ?, updated_at = ? WHERE id = ?", ok ? "connected" : "error", now(), instanceId);
      if (ok) this.noteHealth(instanceId, true);
      else this.noteHealth(instanceId, false, { cls: (cls ?? "provider") as Classified["cls"], retryable: false, message: detail });
    });
    return { ok, detail, errorClass: cls };
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
