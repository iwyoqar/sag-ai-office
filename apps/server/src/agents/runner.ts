// Agent runtime: claims queued tasks, runs them through the LLM, stores deliverables, usage and status.
// Lifecycle per task: claim (lease) → load agent + instructions → prior results → LLM → deliverable → DONE
//                     (or retry with backoff → FAILED), with every call recorded in agent_runs / usage_records.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentStatus } from "@sag/shared";
import { json, now } from "../db/db.js";
import type { Ctx } from "../domain/context.js";
import { claimNextTask, createTask, getTask, listTasks, reportProgress, transitionTask, type TaskDto } from "../domain/tasks.js";
import { SYSTEM, audit } from "../lib/audit.js";
import { uid } from "../lib/ids.js";
import { LlmError, estimateCost, type LlmClient, type LlmRequest, type LlmResult, type Pricing } from "../llm/types.js";
import { buildSystemPrompt, buildTaskMessage, type Grounding, type PriorResult } from "./prompt.js";
import type { KnowledgeHit } from "../knowledge/service.js";
import { embedderOf, retrieve } from "../knowledge/semantic.js";
import { addMemory, approvedMemory, requestApproval } from "../domain/brain.js";
import type { ConnectorHub } from "../connectors/hub.js";
import type { LlmMessage } from "../llm/types.js";

export interface RunnerOptions {
  concurrency: number;
  pollMs: number;
  taskTimeoutMs: number;
  /** waits between task-level retries (the client already retries transient HTTP errors) */
  retryDelayMs?: number;
  /** how long COMPLETED / ERROR stays visible on the agent before it returns to IDLE */
  settleMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** connector tools for agents (omit = text only) */
  tools?: ConnectorHub;
}

const MAX_SUBTASKS = 6;
/** model ↔ tool round trips per task before a final answer is forced */
const MAX_TOOL_STEPS = 4;
const RUN_LEASE_MS = 15 * 60_000;

const PlanSchema = z.object({
  summary: z.string().max(2000).default(""),
  subtasks: z
    .array(
      z.object({
        key: z.string().min(1).max(20),
        title: z.string().min(1).max(200),
        description: z.string().max(4000).default(""),
        department: z.string(),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

class StaleTask extends Error {}
/** A task ceiling was reached — the task fails with a clear reason, no retry. */
class LimitError extends Error {}

export class AgentRunner {
  private timer: NodeJS.Timeout | null = null;
  private active = new Map<string, AbortController>();
  private settleTimers = new Set<NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  readonly workerId = `w-${randomUUID().slice(0, 8)}`;

  constructor(private ctx: Ctx, private llm: LlmClient, private pricing: Pricing, private o: RunnerOptions) {}

  get running() {
    return this.timer !== null;
  }

  get activeCount() {
    return this.active.size;
  }

  start() {
    if (this.timer) return;
    // A task moved away from IN_PROGRESS by a person (stop, cancel, reassign) aborts its LLM call.
    this.unsubscribe = this.ctx.bus.subscribe((e) => {
      if (e.type !== "task.status" || !e.taskId) return;
      const to = e.data.to;
      if (to !== "IN_PROGRESS" && to !== "WAITING_FOR_DEPENDENCY" && to !== "DONE") this.active.get(e.taskId)?.abort();
    });
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    for (const c of this.active.values()) c.abort();
    for (const t of this.settleTimers) clearTimeout(t);
  }

  /** Claims and starts as many tasks as free slots allow. Returns the started run promises (for tests). */
  tick(): Promise<void>[] {
    const started: Promise<void>[] = [];
    while (this.active.size < this.o.concurrency) {
      const task = claimNextTask(this.ctx, this.workerId, RUN_LEASE_MS);
      if (!task) break;
      const ctrl = new AbortController();
      this.active.set(task.id, ctrl);
      started.push(
        this.process(task, ctrl.signal)
          .catch((e) => this.o.log?.("runner crash", { taskId: task.id, err: String(e) }))
          .finally(() => this.active.delete(task.id)),
      );
    }
    return started;
  }

  // ---------------------------------------------------------------------------
  private async process(task: TaskDto, signal: AbortSignal) {
    const agentId = task.agentId!;
    try {
      if (task.kind === "orchestrate") {
        const subtasks = listTasks(this.ctx, { parentId: task.id });
        if (subtasks.length === 0) await this.plan(task, signal);
        else await this.synthesize(task, subtasks, signal);
      } else {
        await this.execute(task, signal);
      }
    } catch (e) {
      if (e instanceof StaleTask || signal.aborted) {
        this.setAgent(agentId, "IDLE");
        return;
      }
      this.fail(task, e instanceof Error ? e.message : String(e));
    }
  }

  /** Single task: one agent, one deliverable. */
  private async execute(task: TaskDto, signal: AbortSignal) {
    this.setAgent(task.agentId!, "THINKING");
    this.stage(task, "Kontekst tayyorlanmoqda");
    const parent = task.parentId ? getTask(this.ctx, task.parentId) : null;
    const g = await this.ground(task, parent ? `${parent.title} ${task.title}` : undefined);
    const message = buildTaskMessage(task, this.priorResults(task), parent, g.grounding);
    const system = buildSystemPrompt(this.ctx, task.agentId!);
    this.setAgent(task.agentId!, "WORKING");
    this.stage(task, g.hits.length ? `Natija yozilmoqda (${g.hits.length} ta hujjat parchasi bilan)` : "Natija yozilmoqda");
    const res = await this.withTools(task, system, message, signal);
    this.finish(task, withSources(res.text, g.hits) + res.actions, "Natija");
  }

  /**
   * Model ↔ tools loop: the model may call its tools a few times (read tools answer at once, write tools become
   * approval requests), then must write the deliverable. Every action is listed truthfully under the result.
   */
  private async withTools(task: TaskDto, system: string, message: string, signal: AbortSignal): Promise<{ text: string; actions: string }> {
    const hub = this.o.tools;
    const tools = hub ? hub.toolsFor(task.agentId!) : [];
    const specs = hub ? hub.specs(tools) : [];
    const messages: LlmMessage[] = [{ role: "user", text: message }];
    const log: string[] = [];
    for (let step = 0; ; step++) {
      const last = step >= MAX_TOOL_STEPS || !specs.length;
      const res = await this.call(task, { system, messages, ...(last ? {} : { tools: specs }) }, signal);
      if (!res.toolCalls?.length || last) {
        const text = res.text.trim() || "Natija yozilmadi.";
        return { text, actions: log.length ? `\n\n## Amallar\n${log.join("\n")}` : "" };
      }
      this.setAgent(task.agentId!, "COMMUNICATING");
      this.stage(task, `Vositalar: ${res.toolCalls.map((c) => c.name).join(", ")}`);
      const results = [];
      for (const c of res.toolCalls.slice(0, 5)) {
        const out = await hub!.invoke({ taskId: task.id, agentId: task.agentId!, runId: res.runId!, correlationId: res.runId! }, c);
        const def = tools.find((t) => t.name === c.name);
        const what = def ? def.summary((def.schema.safeParse(c.args).data ?? c.args) as Record<string, unknown>) : c.name;
        log.push(`- ${what} — ${out.error ? `xato: ${String(out.error)}` : out.status === "pending_approval" ? "tasdiqqa yuborildi (The Brain → Tasdiqlar)" : "bajarildi"}`);
        results.push({ name: c.name, response: out });
      }
      messages.push({ role: "model", text: "", toolCalls: res.toolCalls.slice(0, 5) }, { role: "user", text: "", toolResults: results });
      this.setAgent(task.agentId!, "WORKING");
      this.assertStillMine(task);
    }
  }

  /** Orchestrator step 1: split the job across departments, create subtasks + dependency graph. */
  private async plan(task: TaskDto, signal: AbortSignal) {
    const agentId = task.agentId!;
    this.setAgent(agentId, "THINKING");
    this.stage(task, "Topshiriq tahlil qilinmoqda");
    const deps = this.ctx.db.all<{ id: string; name: string; focus: string; n: number }>(
      `SELECT d.id, d.name, d.focus, (SELECT COUNT(*) FROM agents a WHERE a.department_id = d.id AND a.lifecycle = 'ACTIVE') n
       FROM departments d WHERE d.is_active = 1 AND d.id <> 'director' ORDER BY d.sort`,
    );
    const maxSub = Math.min(MAX_SUBTASKS, task.limits.maxAgents ?? MAX_SUBTASKS);
    const system = buildSystemPrompt(this.ctx, agentId, [
      "\n## Rejalashtiruvchi (orchestrator) vazifasi",
      `Topshiriqni bo'limlar o'rtasida 1–${maxSub} ta kichik vazifaga bo'l. Faqat haqiqatan kerakli bo'limlarni tanla.`,
      "Bog'liqlik: agar bir kichik vazifa boshqasining natijasidan foydalansa, dependsOn ga o'sha vazifaning key ini yoz (faqat o'zidan oldingilarini).",
      "Mustaqil vazifalar parallel bajariladi. Har vazifa tavsifida kutilayotgan natijani aniq yoz.",
      "Javob — faqat JSON obyekt: {\"summary\": string, \"subtasks\": [{\"key\": \"s1\", \"title\": string, \"description\": string, \"department\": \"<bo'lim id>\", \"dependsOn\": [\"s0\"]}]}",
      "Mavjud bo'limlar (id — nom — yo'nalishlar — faol agentlar):",
      ...deps.map((d) => `- ${d.id} — ${d.name} — ${json<string[]>(d.focus, []).join(", ")} — ${d.n}`),
    ]);
    const msg = buildTaskMessage(task, []);
    let plan: Plan | null = null;
    let lastError = "";
    for (let i = 0; i < 2 && !plan; i++) {
      const res = await this.call(task, {
        system,
        messages: [{ role: "user", text: i === 0 ? msg : `${msg}\n\nOldingi javob JSON talablariga mos kelmadi (${lastError}). Faqat to'g'ri JSON qaytar.` }],
        json: true, temperature: 0.3,
      }, signal);
      try {
        plan = validatePlan(PlanSchema.parse(JSON.parse(stripFence(res.text))), new Set(deps.filter((d) => d.n > 0).map((d) => d.id)), maxSub);
      } catch (e) {
        lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }
    if (!plan) throw new Error(`Reja tuzilmadi: ${lastError}`);

    this.assertStillMine(task);
    const ids = new Map<string, string>();
    const created: TaskDto[] = [];
    this.ctx.db.tx(() => {
      for (const s of plan!.subtasks) {
        const t = createTask(this.ctx, {
          title: s.title, description: s.description, departmentId: s.department, parentId: task.id,
          dependsOn: s.dependsOn.map((k) => ids.get(k)!).filter(Boolean),
          // subtasks inherit the job's limits (each piece gets the same ceilings; maxAgents only applies to planning)
          priority: task.priority, deadline: task.deadline, limits: { ...task.limits, maxAgents: undefined },
        }, SYSTEM);
        ids.set(s.key, t.id);
        created.push(t);
        this.ctx.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", task.id, t.id);
      }
      const planText = [
        `## Reja`, plan!.summary, "",
        ...plan!.subtasks.map((s, i) => `${i + 1}. **${s.title}** — ${s.department}${s.dependsOn.length ? ` (kutadi: ${s.dependsOn.join(", ")})` : ""}`),
      ].join("\n");
      this.saveDeliverable(task, agentId, "Ish rejasi", planText);
      audit(this.ctx.db, { type: "agent", id: agentId }, "orchestrator.plan", { type: "task", id: task.id }, { subtasks: created.map((c) => c.id) });
    });
    // Hand each piece to its agent (internal coordination, not a chat channel).
    this.setAgent(agentId, "COMMUNICATING");
    for (const t of created) this.message(task.id, agentId, t.agentId, "handoff", `Yangi vazifa: ${t.title}`);
    transitionTask(this.ctx, task.id, "WAITING_FOR_DEPENDENCY", SYSTEM, { reason: "subtasks created" });
    this.ctx.db.run("UPDATE tasks SET stage = ?, progress = 10 WHERE id = ?", `Bo'limlar ishlamoqda (0/${created.length})`, task.id);
    this.ctx.bus.emit("task.progress", { taskId: task.id, agentId, departmentId: task.departmentId }, { progress: 10, stage: `Bo'limlar ishlamoqda (0/${created.length})` });
    this.settle(agentId, "COMMUNICATING");
  }

  /** Orchestrator step 2: all subtasks are done — combine their results into the final deliverable. */
  private async synthesize(task: TaskDto, subtasks: TaskDto[], signal: AbortSignal) {
    const agentId = task.agentId!;
    this.setAgent(agentId, "THINKING");
    this.stage(task, "Natijalar birlashtirilmoqda");
    const prior = subtasks.map((s) => this.resultOf(s)).filter((p): p is PriorResult => !!p);
    const system = buildSystemPrompt(this.ctx, agentId, [
      "\n## Birlashtiruvchi vazifasi",
      "Bo'limlar natijalarini bitta izchil yakuniy hujjatga birlashtir: qisqa xulosa, asosiy bo'limlar, raqamlar (manbasi bilan), keyingi qadamlar.",
      "Natijalar orasida ziddiyat bo'lsa, buni ko'rsat. Yangi faktlar qo'shma.",
    ]);
    this.setAgent(agentId, "WORKING");
    const g = await this.ground(task);
    const res = await this.call(task, { system, messages: [{ role: "user", text: buildTaskMessage(task, prior, null, g.grounding) }] }, signal);
    this.finish(task, withSources(res.text, g.hits), "Yakuniy natija");
  }

  // ---------------------------------------------------------------------------
  /** LLM call with run/usage bookkeeping and task-level retries for transient errors. */
  private async call(task: TaskDto, req: Omit<LlmRequest, "correlationId">, signal: AbortSignal): Promise<LlmResult> {
    const maxAttempts = Math.max(1, task.maxAttempts);
    for (let attempt = 1; ; attempt++) {
      const budget = this.checkLimits(task);
      const runId = uid("run");
      const correlationId = randomUUID();
      const started = Date.now();
      this.ctx.db.run(
        "INSERT INTO agent_runs (id, task_id, agent_id, correlation_id, model, mode, status, started_at) VALUES (?,?,?,?,?,?, 'running', ?)",
        runId, task.id, task.agentId, correlationId, this.llm.model, this.llm.mode, now(),
      );
      try {
        const res = await this.llm.generate({
          ...req, correlationId, signal, timeoutMs: this.o.taskTimeoutMs,
          maxOutputTokens: Math.max(256, Math.min(req.maxOutputTokens ?? 6000, 8192, budget.tokensLeft)),
        });
        this.recordUsage(task, runId, res, Date.now() - started);
        return { ...res, runId };
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), "server", false);
        this.ctx.db.run(
          "UPDATE agent_runs SET status = ?, error = ?, latency_ms = ?, finished_at = ? WHERE id = ?",
          err.code === "aborted" ? "cancelled" : "failed", err.message, Date.now() - started, now(), runId,
        );
        if (err.code === "aborted") throw new StaleTask();
        if (!err.retryable || attempt >= maxAttempts) throw err;
        this.ctx.db.run("UPDATE tasks SET attempts = attempts + 1 WHERE id = ?", task.id);
        this.stage(task, `Qayta urinish ${attempt + 1}/${maxAttempts}: ${err.message}`);
        await sleep((this.o.retryDelayMs ?? 20_000) * attempt, signal);
        if (signal.aborted) throw new StaleTask();
      }
    }
  }

  /**
   * Hard ceilings per task (set when the task is created): total tokens, estimated cost, wall time, number of
   * AI calls. Checked before every call so a looping or verbose task stops instead of burning budget.
   */
  private checkLimits(task: TaskDto): { tokensLeft: number } {
    const l = task.limits;
    const u = this.ctx.db.get<{ tin: number; tout: number; cost: number; started_at: string | null }>(
      "SELECT tokens_in tin, tokens_out tout, cost_usd cost, started_at FROM tasks WHERE id = ?", task.id,
    )!;
    const calls = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_runs WHERE task_id = ?", task.id)!.n;
    const used = u.tin + u.tout;
    if (l.maxIterations && calls >= l.maxIterations) throw new LimitError(`AI chaqiruvlari limiti tugadi (${calls}/${l.maxIterations})`);
    if (l.maxTokens && used >= l.maxTokens) throw new LimitError(`Token limiti tugadi (${used}/${l.maxTokens})`);
    if (l.maxCostUsd && u.cost >= l.maxCostUsd) throw new LimitError(`Xarajat limiti tugadi ($${u.cost.toFixed(4)} / $${l.maxCostUsd})`);
    if (l.maxDurationMs && u.started_at && Date.now() - Date.parse(u.started_at) > l.maxDurationMs)
      throw new LimitError(`Vaqt limiti tugadi (${Math.round(l.maxDurationMs / 60000)} daqiqa)`);
    return { tokensLeft: l.maxTokens ? l.maxTokens - used : Infinity };
  }

  private recordUsage(task: TaskDto, runId: string, res: LlmResult, latency: number) {
    const cost = estimateCost(this.pricing, res.inputTokens, res.outputTokens);
    this.ctx.db.tx(() => {
      this.ctx.db.run(
        "UPDATE agent_runs SET status = 'succeeded', model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, latency_ms = ?, finished_at = ? WHERE id = ?",
        res.model, res.inputTokens, res.outputTokens, cost, latency, now(), runId,
      );
      this.ctx.db.run(
        `INSERT INTO usage_records (id, run_id, agent_id, department_id, task_id, model, input_tokens, output_tokens, cost_usd, is_estimate, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
        uid("use"), runId, task.agentId, task.departmentId, task.id, res.model, res.inputTokens, res.outputTokens, cost, now(),
      );
      this.ctx.db.run(
        "UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE id = ?",
        res.inputTokens, res.outputTokens, cost, task.id,
      );
    });
  }

  private finish(task: TaskDto, text: string, title: string) {
    this.assertStillMine(task);
    const needsApproval = task.requiresApproval;
    this.ctx.db.tx(() => {
      this.saveDeliverable(task, task.agentId!, title, text);
      if (needsApproval) {
        transitionTask(this.ctx, task.id, "WAITING_APPROVAL", SYSTEM, { result: summarize(text), reason: "result needs approval" });
        this.ctx.db.run("UPDATE tasks SET stage = 'Natija tasdiqlashni kutmoqda' WHERE id = ?", task.id);
        requestApproval(this.ctx, task.id, task.agentId!, "result_review", { title });
      } else {
        transitionTask(this.ctx, task.id, "DONE", SYSTEM, { result: summarize(text) });
      }
      // Proposed, not trusted: a person reviews it in The Brain before agents use it.
      // HQ memory only learns from HQ work; other units' results never enter it
      if (!task.parentId && task.businessUnitId === "hq")
        addMemory(this.ctx, { kind: "result", content: `${task.title}: ${summarize(text)}`, departmentId: task.departmentId, taskId: task.id },
          { type: "agent", id: task.agentId });
    });
    if (needsApproval) {
      this.setAgent(task.agentId!, "WAITING_APPROVAL");
      this.settle(task.agentId!, "WAITING_APPROVAL", 60 * 60_000);
      return;
    }
    this.setAgent(task.agentId!, "COMPLETED");
    this.settle(task.agentId!, "COMPLETED");
    this.afterSubtaskDone(task);
    // pass the result on to whoever was waiting for it
    for (const d of this.ctx.db.all<{ id: string; agent_id: string | null; title: string }>(
      "SELECT t.id, t.agent_id, t.title FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = ? AND t.kind = 'single'",
      task.id,
    ))
      this.message(d.id, task.agentId!, d.agent_id, "handoff", `"${task.title}" natijasi tayyor — "${d.title}" uchun kontekst sifatida ishlatiladi.`);
  }

  private fail(task: TaskDto, error: string) {
    const current = getTask(this.ctx, task.id);
    if (current.status === "IN_PROGRESS") transitionTask(this.ctx, task.id, "FAILED", SYSTEM, { error, reason: "agent run failed" });
    this.setAgent(task.agentId!, "ERROR");
    this.settle(task.agentId!, "ERROR", 15_000);
    // a failed piece blocks the combined job instead of leaving it waiting forever
    if (task.parentId) {
      const parent = getTask(this.ctx, task.parentId);
      if (parent.status === "WAITING_FOR_DEPENDENCY")
        transitionTask(this.ctx, parent.id, "BLOCKED", SYSTEM, { error: `Kichik vazifa bajarilmadi: ${task.title} — ${error}`, reason: "subtask failed" });
    }
    this.o.log?.("task failed", { taskId: task.id, error });
  }

  private afterSubtaskDone(task: TaskDto) {
    if (!task.parentId) return;
    const kids = listTasks(this.ctx, { parentId: task.parentId });
    const done = kids.filter((k) => k.status === "DONE").length;
    const parent = getTask(this.ctx, task.parentId);
    if (parent.status === "WAITING_FOR_DEPENDENCY" || parent.status === "QUEUED") {
      const stage = parent.status === "QUEUED" ? "Birlashtirish navbatda" : `Bo'limlar ishlamoqda (${done}/${kids.length})`;
      const progress = 10 + Math.round((done / kids.length) * 80);
      this.ctx.db.run("UPDATE tasks SET stage = ?, progress = ?, updated_at = ? WHERE id = ?", stage, progress, now(), parent.id);
      this.ctx.bus.emit("task.progress", { taskId: parent.id, agentId: parent.agentId, departmentId: parent.departmentId }, { progress, stage });
    }
  }

  // ---------------------------------------------------------------------------
  /** Company documents (only what the agent's department may see) + approved memory for this task. */
  private async ground(task: TaskDto, extraQuery?: string): Promise<{ grounding: Grounding; hits: KnowledgeHit[] }> {
    // Company documents and memory are HQ's; agents of other business units work without them (no unit knowledge base yet).
    if (task.businessUnitId !== "hq") return { hits: [], grounding: {} };
    const dept = this.ctx.db.get<{ department_id: string }>("SELECT department_id FROM agents WHERE id = ?", task.agentId)?.department_id ?? null;
    const { hits } = await retrieve(this.ctx, embedderOf(this.llm), `${extraQuery ?? task.title} ${task.description}`, {
      departmentId: dept, limit: 5, onError: (e) => this.o.log?.("semantic search fell back to full-text", { err: (e as Error).message }),
    });
    return { hits, grounding: { docs: hits.map((h) => ({ title: h.title, content: h.content })), memory: approvedMemory(this.ctx, dept) } };
  }

  private priorResults(task: TaskDto): PriorResult[] {
    return task.dependsOn.map((id) => this.resultOf(getTask(this.ctx, id))).filter((p): p is PriorResult => !!p);
  }

  private resultOf(t: TaskDto): PriorResult | null {
    const d = this.ctx.db.get<{ content: string }>("SELECT content FROM deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", t.id);
    if (!d) return null;
    const who = this.ctx.db.get<{ name: string; dep: string }>(
      "SELECT a.name, dp.name dep FROM agents a JOIN departments dp ON dp.id = a.department_id WHERE a.id = ?", t.agentId,
    );
    return { title: t.title, agent: who?.name ?? "agent", department: who?.dep ?? "", content: d.content };
  }

  private saveDeliverable(task: TaskDto, agentId: string, title: string, content: string) {
    this.ctx.db.run(
      "INSERT INTO deliverables (id, task_id, agent_id, title, content, format, created_at) VALUES (?,?,?,?,?, 'markdown', ?)",
      uid("dlv"), task.id, agentId, title, content, now(),
    );
  }

  private message(taskId: string, from: string, to: string | null, kind: "handoff" | "message", content: string) {
    if (!to || to === from) return;
    this.ctx.db.run(
      "INSERT INTO agent_messages (id, task_id, from_agent_id, to_agent_id, kind, content, created_at) VALUES (?,?,?,?,?,?,?)",
      uid("msg"), taskId, from, to, kind, content, now(),
    );
    this.ctx.bus.emit("agent.message", { taskId, agentId: from }, { from, to, kind, content });
  }

  private stage(task: TaskDto, stage: string) {
    try {
      reportProgress(this.ctx, task.id, { stage }, SYSTEM);
    } catch {
      throw new StaleTask();
    }
  }

  /** The task may have been stopped, cancelled or reassigned while the model was thinking. */
  private assertStillMine(task: TaskDto) {
    const t = getTask(this.ctx, task.id);
    if (t.status !== "IN_PROGRESS" || t.agentId !== task.agentId) throw new StaleTask();
  }

  private setAgent(agentId: string, status: AgentStatus) {
    const a = this.ctx.db.get<{ status: string; department_id: string }>("SELECT status, department_id FROM agents WHERE id = ?", agentId);
    if (!a || a.status === status) return;
    this.ctx.db.run("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?", status, now(), agentId);
    this.ctx.bus.emit("agent.status", { agentId, departmentId: a.department_id }, { status });
  }

  /** After a short visible moment, a finished/failed agent goes back to IDLE (unless it picked up new work). */
  private settle(agentId: string, from: AgentStatus, ms = this.o.settleMs ?? 8000) {
    const t = setTimeout(() => {
      this.settleTimers.delete(t);
      const busy = this.ctx.db.get("SELECT 1 FROM tasks WHERE agent_id = ? AND status = 'IN_PROGRESS'", agentId);
      const cur = this.ctx.db.get<{ status: string }>("SELECT status FROM agents WHERE id = ?", agentId);
      if (!busy && cur?.status === from) this.setAgent(agentId, "IDLE");
    }, ms);
    this.settleTimers.add(t);
  }
}

export function validatePlan(plan: Plan, departments: Set<string>, maxSub: number): Plan {
  if (plan.subtasks.length > maxSub) throw new Error(`Juda ko'p kichik vazifa: ${plan.subtasks.length} > ${maxSub}`);
  const seen = new Set<string>();
  for (const s of plan.subtasks) {
    if (!departments.has(s.department)) throw new Error(`Noma'lum yoki agentsiz bo'lim: ${s.department}`);
    if (seen.has(s.key)) throw new Error(`Takroriy key: ${s.key}`);
    // only earlier keys → the graph is acyclic by construction
    for (const d of s.dependsOn) if (!seen.has(d)) throw new Error(`"${s.key}" faqat oldingi vazifalarga bog'lanishi mumkin (${d})`);
    seen.add(s.key);
  }
  return plan;
}

/** Appends the documents the answer was grounded in (deduplicated by title). */
function withSources(text: string, hits: KnowledgeHit[]) {
  const titles = [...new Set(hits.map((h) => h.title))];
  return titles.length ? `${text}\n\n---\n**Manbalar (kompaniya hujjatlari):** ${titles.join("; ")}` : text;
}

function stripFence(s: string) {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}

function summarize(text: string) {
  const plain = text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 400 ? `${plain.slice(0, 400)}…` : plain;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
