// Agent runtime: claims queued tasks, runs them through the LLM, stores deliverables, usage and status.
// Lifecycle per task: claim (lease) → load agent + instructions → prior results → LLM → deliverable → DONE
//                     (or retry with backoff → FAILED), with every call recorded in agent_runs / usage_records.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import type { AgentStatus } from "@sag/shared";
import { json, now } from "../db/db.js";
import type { Ctx } from "../domain/context.js";
import {
  LEASE_GUARD, claimNextTask, createTask, getTask, holdsLease, leaseParams, listTasks, recoverExpiredLeases, releaseLease, renewLease,
  transitionTask, type Lease, type TaskDto,
} from "../domain/tasks.js";
import { SYSTEM, audit } from "../lib/audit.js";
import { uid } from "../lib/ids.js";
import { LlmError, estimateCost, type LlmClient, type LlmRequest, type LlmResult, type Pricing } from "../llm/types.js";
import { buildSystemPrompt, buildTaskMessage, type Grounding, type PriorResult } from "./prompt.js";
import type { KnowledgeHit } from "../knowledge/service.js";
import { embedderOf, retrieve } from "../knowledge/semantic.js";
import { addMemory, approvedMemory, requestApproval } from "../domain/brain.js";
import type { ConnectorHub } from "../connectors/hub.js";
import type { LlmMessage } from "../llm/types.js";
import { directorAgent, directorSettings, selectAgent } from "../domain/workforce.js";
import { requestHireForAgent } from "../domain/marketplace.js";
import { notify } from "../domain/notifications.js";
import { agentKnowledgeDept, requesterOf } from "../domain/access.js";

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
  /** lease length; renewed by the heartbeat while the run works (default 90 s) */
  leaseMs?: number;
  /** heartbeat period: renews leases and the worker's liveness row (default leaseMs / 3) */
  heartbeatMs?: number;
  /** how long stop() waits for in-flight runs to wind down after aborting them (default 10 s) */
  stopTimeoutMs?: number;
}

const MAX_SUBTASKS = 6;
/** model ↔ tool round trips per task before a final answer is forced */
const MAX_TOOL_STEPS = 4;
/** A worker whose heartbeat is older than this many periods is considered gone. */
const DEAD_AFTER_BEATS = 3;

const PlanSchema = z.object({
  summary: z.string().max(2000).default(""),
  objective: z.string().max(2000).default(""),
  context: z.string().max(4000).default(""),
  expectedOutcome: z.string().max(2000).default(""),
  requiredSkills: z.array(z.string().max(80)).max(30).default([]),
  approvalRequirements: z.string().max(1000).default(""),
  subtasks: z
    .array(
      z.object({
        key: z.string().min(1).max(20),
        title: z.string().min(1).max(200),
        description: z.string().max(4000).default(""),
        department: z.string(),
        skills: z.array(z.string().max(80)).max(10).default([]),
        deliverable: z.string().max(1000).default(""),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  missingSkills: z.array(z.object({ skill: z.string().min(1).max(120), department: z.string(), reason: z.string().max(500).default("") })).max(10).default([]),
});

const EvalSchema = z.object({
  verdict: z.enum(["ACCEPTED", "NEEDS_REVISION", "REJECTED", "NEEDS_HUMAN_REVIEW"]),
  issues: z.array(z.string().max(500)).max(20).default([]),
  feedback: z.string().max(4000).default(""),
});
type Verdict = z.infer<typeof EvalSchema>["verdict"];
export type Plan = z.infer<typeof PlanSchema>;

class StaleTask extends Error {}
/** A task ceiling was reached — the task fails with a clear reason, no retry. */
class LimitError extends Error {}

export class AgentRunner {
  private timer: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private active = new Map<string, AbortController>();
  /** fencing tokens of the runs in flight: every write for a task must still hold its lease */
  private leases = new Map<string, Lease>();
  private inflight = new Set<Promise<void>>();
  private settleTimers = new Set<NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  readonly workerId = `w-${randomUUID().slice(0, 8)}`;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;

  constructor(private ctx: Ctx, private llm: LlmClient, private pricing: Pricing, private o: RunnerOptions) {
    this.leaseMs = o.leaseMs ?? 90_000;
    this.heartbeatMs = o.heartbeatMs ?? Math.max(10, Math.floor(this.leaseMs / 3));
  }

  get running() {
    return this.timer !== null;
  }

  get activeCount() {
    return this.active.size;
  }

  start() {
    if (this.timer) return;
    this.registerWorker();
    this.recoverOnStart();
    // A task moved away from IN_PROGRESS by a person (stop, cancel, reassign) aborts its LLM call.
    this.unsubscribe = this.ctx.bus.subscribe((e) => {
      if (e.type !== "task.status" || !e.taskId) return;
      const to = e.data.to;
      if (to !== "IN_PROGRESS" && to !== "WAITING_FOR_DEPENDENCY" && to !== "DONE") this.active.get(e.taskId)?.abort();
    });
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
    this.beat = setInterval(() => this.heartbeat(), this.heartbeatMs);
  }

  /**
   * Graceful stop (deploy, SIGTERM): stop claiming, hand every leased task back to the queue at once (no attempt
   * counted), abort the in-flight calls, wait a bounded time for them to wind down. Their late writes are fenced off.
   * Idempotent.
   */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.beat) clearInterval(this.beat);
    this.timer = this.beat = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [taskId, lease] of this.leases) {
      releaseLease(this.ctx, lease, "worker stopped");
      this.active.get(taskId)?.abort();
    }
    for (const t of this.settleTimers) clearTimeout(t);
    const wait = Promise.allSettled([...this.inflight]);
    const limit = new Promise((res) => setTimeout(res, this.o.stopTimeoutMs ?? 10_000).unref());
    await Promise.race([wait, limit]);
    this.ctx.db.run("DELETE FROM worker_heartbeats WHERE worker_id = ?", this.workerId);
  }

  // ---------------------------------------------------------------------------
  // worker liveness and recovery

  private registerWorker() {
    const t = now();
    this.ctx.db.run(
      `INSERT INTO worker_heartbeats (worker_id, pid, host, started_at, heartbeat_at) VALUES (?,?,?,?,?)
       ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
      this.workerId, process.pid, hostname(), t, t,
    );
  }

  /** Workers (other than this one) that stopped heart-beating: their leases are void now, not when they expire. */
  private deadOwner = (owner: string | null) => {
    if (!owner || owner === this.workerId) return false;
    const cutoff = new Date(Date.now() - DEAD_AFTER_BEATS * this.heartbeatMs).toISOString();
    return !this.ctx.db.get("SELECT 1 FROM worker_heartbeats WHERE worker_id = ? AND heartbeat_at >= ?", owner, cutoff);
  };

  /**
   * Startup: work abandoned by a crashed or stopped worker goes back to the queue immediately (a deploy no longer
   * leaves an agent's queue stalled until an old lease runs out), and agents shown as busy with nothing running
   * return to IDLE.
   */
  private recoverOnStart() {
    const cutoff = new Date(Date.now() - DEAD_AFTER_BEATS * this.heartbeatMs).toISOString();
    this.ctx.db.run("DELETE FROM worker_heartbeats WHERE heartbeat_at < ? AND worker_id <> ?", cutoff, this.workerId);
    const recovered = recoverExpiredLeases(this.ctx, { deadOwner: this.deadOwner });
    if (recovered.length) this.o.log?.("recovered abandoned tasks", { recovered });
    const stuck = this.ctx.db.all<{ id: string }>(
      `SELECT a.id FROM agents a WHERE a.status IN ('THINKING','WORKING','COMMUNICATING')
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'IN_PROGRESS')`,
    );
    for (const a of stuck) this.setAgent(a.id, "IDLE");
  }

  /** Renews this worker's liveness and every lease it holds; a lease that cannot be renewed aborts its run. */
  private heartbeat() {
    this.ctx.db.run("UPDATE worker_heartbeats SET heartbeat_at = ? WHERE worker_id = ?", now(), this.workerId);
    for (const [taskId, lease] of this.leases) {
      if (!renewLease(this.ctx, lease, this.leaseMs)) {
        this.o.log?.("lease lost — run aborted", { taskId, epoch: lease.epoch });
        this.lost.add(taskId);
        this.active.get(taskId)?.abort();
      }
    }
    recoverExpiredLeases(this.ctx, { deadOwner: this.deadOwner });
  }

  private lost = new Set<string>();

  /** Claims and starts as many tasks as free slots allow. Returns the started run promises (for tests). */
  tick(): Promise<void>[] {
    const started: Promise<void>[] = [];
    while (this.active.size < this.o.concurrency) {
      const task = claimNextTask(this.ctx, this.workerId, this.leaseMs);
      if (!task) break;
      const ctrl = new AbortController();
      this.active.set(task.id, ctrl);
      this.leases.set(task.id, { taskId: task.id, workerId: this.workerId, epoch: task.leaseEpoch });
      const run: Promise<void> = this.process(task, ctrl.signal)
        .catch((e) => this.o.log?.("runner crash", { taskId: task.id, err: String(e) }))
        .finally(() => {
          this.active.delete(task.id);
          this.leases.delete(task.id);
          this.lost.delete(task.id);
          this.inflight.delete(run);
        });
      this.inflight.add(run);
      started.push(run);
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

  private leaseOf(task: TaskDto): Lease {
    const l = this.leases.get(task.id);
    if (!l) throw new StaleTask();
    return l;
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
      this.stage(task, `Vositalar: ${res.toolCalls.map((c) => c.name).join(", ")}`); // also proves the lease is still ours
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

  /**
   * AI Director step 1 — understand, plan, staff, delegate. The model writes a structured plan (objective, expected
   * outcome, skills, subtasks with dependencies and deliverables); the platform picks the agents (skills, department,
   * load — HQ agents only), records one handoff per subtask, and asks the Marketplace for a hire where nobody fits.
   */
  private async plan(task: TaskDto, signal: AbortSignal) {
    const agentId = task.agentId!;
    this.setAgent(agentId, "THINKING");
    this.stage(task, "Topshiriq tahlil qilinmoqda");
    const settings = directorSettings(this.ctx, task.businessUnitId);
    const deps = this.ctx.db.all<{ id: string; name: string; focus: string; n: number }>(
      `SELECT d.id, d.name, d.focus, (SELECT COUNT(*) FROM agents a WHERE a.department_id = d.id AND a.lifecycle = 'ACTIVE') n
       FROM departments d WHERE d.is_active = 1 AND d.id <> 'director' AND d.business_unit_id = ? ORDER BY d.sort`, task.businessUnitId,
    );
    const roster = this.ctx.db.all<{ department_id: string; role: string; n: number }>(
      "SELECT department_id, role, COUNT(*) n FROM agents WHERE business_unit_id = ? AND lifecycle = 'ACTIVE' AND department_id <> 'director' GROUP BY 1, 2 ORDER BY 1",
      task.businessUnitId,
    );
    const maxSub = Math.min(settings.maxSubtasks, MAX_SUBTASKS, task.limits.maxAgents ?? MAX_SUBTASKS);
    const system = buildSystemPrompt(this.ctx, agentId, [
      "\n## Rejalashtiruvchi (orchestrator) vazifasi — AI Direktor",
      `Topshiriqni tushun, uni 1–${maxSub} ta kichik vazifaga bo'l va har biriga kerakli ko'nikmalarni yoz. Faqat haqiqatan kerakli ishlarni rejala.`,
      "Bog'liqlik: agar bir kichik vazifa boshqasining natijasidan foydalansa, dependsOn ga o'sha vazifaning key ini yoz (faqat o'zidan oldingilarini).",
      "Har vazifa uchun kutilayotgan natijani (deliverable) aniq yoz. Hisob-kitob bo'lsa, taxminlarni ko'rsatishni talab qil.",
      "Agar biror ko'nikma uchun quyidagi ro'yxatda mos agent bo'lmasa, uni missingSkills ga yoz (yangi agent yollash so'rovi uchun).",
      "Javob — faqat JSON obyekt: {\"objective\": string, \"context\": string, \"expectedOutcome\": string, \"requiredSkills\": [string],",
      " \"approvalRequirements\": string, \"subtasks\": [{\"key\": \"s1\", \"title\": string, \"description\": string, \"department\": \"<bo'lim id>\",",
      " \"skills\": [string], \"deliverable\": string, \"dependsOn\": [\"s0\"]}], \"missingSkills\": [{\"skill\": string, \"department\": \"<bo'lim id>\", \"reason\": string}]}",
      "Mavjud bo'limlar (id — nom — yo'nalishlar — faol agentlar):",
      ...deps.map((d) => `- ${d.id} — ${d.name} — ${json<string[]>(d.focus, []).join(", ")} — ${d.n}`),
      "Faol agentlar (bo'lim — rol — soni):",
      ...roster.map((r) => `- ${r.department_id} — ${r.role} — ${r.n}`),
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
        plan = validatePlan(PlanSchema.parse(JSON.parse(stripFence(res.text))), new Set(deps.map((d) => d.id)), maxSub);
      } catch (e) {
        lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }
    if (!plan) throw new Error(`Reja tuzilmadi: ${lastError}`);

    // staffing: the platform chooses agents (skills, department, load); nobody suitable → the piece waits for a hire
    const planned = new Map<string, number>();
    const choices = plan.subtasks.map((s) => {
      const c = selectAgent(this.ctx, { unitId: task.businessUnitId, departmentId: s.department, skills: s.skills, title: s.title, planned });
      if (c) planned.set(c.agentId, (planned.get(c.agentId) ?? 0) + 1);
      return c;
    });
    const ids = new Map<string, string>();
    const created: TaskDto[] = [];
    const unstaffed: string[] = [];
    this.ctx.db.tx(() => {
      this.assertStillMine(task); // checked inside the write transaction: no other worker can slip in between
      plan!.subtasks.forEach((s, i) => {
        const choice = choices[i];
        const t = createTask(this.ctx, {
          title: s.title, description: [s.description, s.deliverable ? `\nKutilayotgan natija: ${s.deliverable}` : ""].join(""),
          departmentId: s.department, agentId: choice?.agentId ?? null, backlog: !choice, parentId: task.id,
          dependsOn: s.dependsOn.map((k) => ids.get(k)!).filter(Boolean),
          // subtasks inherit the job's limits (each piece gets the same ceilings; maxAgents only applies to planning)
          priority: task.priority, deadline: task.deadline, limits: { ...task.limits, maxAgents: undefined },
        }, SYSTEM);
        if (!choice) {
          unstaffed.push(s.title);
          this.ctx.db.run("UPDATE tasks SET stage = ? WHERE id = ?", `Mos agent yo'q (${s.skills.join(", ") || s.department}) — yollash so'rovi`, t.id);
        }
        ids.set(s.key, t.id);
        created.push(t);
        this.ctx.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", task.id, t.id);
        this.ctx.db.run(
          `INSERT INTO task_handoffs (id, parent_task_id, task_id, business_unit_id, from_agent_id, to_agent_id, input, output_format, created_at)
           VALUES (?,?,?,?,?,?,?, 'markdown', ?)`,
          uid("hof"), task.id, t.id, task.businessUnitId, agentId, choice?.agentId ?? null,
          JSON.stringify({ objective: plan!.objective, title: s.title, description: s.description, skills: s.skills, deliverable: s.deliverable,
            dependsOn: s.dependsOn, selection: choice?.reason ?? null }), now(),
        );
      });
      this.ctx.db.run("UPDATE tasks SET plan = ? WHERE id = ?", JSON.stringify(plan), task.id);
      const who = (i: number) => (choices[i] ? this.ctx.db.get<{ name: string }>("SELECT name FROM agents WHERE id = ?", choices[i]!.agentId)?.name ?? "" : "agent yo'q");
      const planText = [
        "## Reja", plan!.objective || plan!.summary, "",
        ...(plan!.expectedOutcome ? [`**Kutilayotgan natija:** ${plan!.expectedOutcome}`, ""] : []),
        ...(plan!.requiredSkills.length ? [`**Kerakli ko'nikmalar:** ${plan!.requiredSkills.join(", ")}`, ""] : []),
        ...plan!.subtasks.map((s, i) => `${i + 1}. **${s.title}** — ${s.department} → ${who(i)}${s.dependsOn.length ? ` (kutadi: ${s.dependsOn.join(", ")})` : ""}${s.deliverable ? `\n   Natija: ${s.deliverable}` : ""}`),
        ...(plan!.approvalRequirements ? ["", `**Tasdiq talablari:** ${plan!.approvalRequirements}`] : []),
      ].join("\n");
      this.saveDeliverable(task, agentId, "Ish rejasi", planText);
      audit(this.ctx.db, { type: "agent", id: agentId }, "orchestrator.plan", { type: "task", id: task.id }, { subtasks: created.map((c) => c.id), unstaffed });
    });

    // skills nobody has: the Marketplace hiring request (policy, limits and approvals apply; never a bypass)
    const hires: string[] = [];
    const wanted = [
      ...plan.missingSkills,
      ...plan.subtasks.filter((_, i) => !choices[i]).map((s) => ({ skill: [s.title, ...s.skills].join(" "), department: s.department, reason: `"${s.title}" uchun agent yo'q` })),
    ];
    for (const m of wanted.slice(0, settings.maxAiHireRequests)) {
      if (!deps.some((d) => d.id === m.department)) continue;
      const r = requestHireForAgent(this.ctx, agentId, {
        skill: m.skill, departmentId: m.department, reason: `${task.title}: ${m.reason}`,
        directorOf: (u) => directorAgent(this.ctx, u), maxPending: settings.maxAiHireRequests,
      });
      hires.push(`${m.skill}: ${"request" in r ? `${r.status} (${r.request.templateName})` : `${r.status} — ${r.detail}`}`);
    }
    if (hires.length) this.saveDeliverable(task, agentId, "Yollash so'rovlari", hires.map((h) => `- ${h}`).join("\n"));
    if (unstaffed.length) this.alert(task, "project.blocked", `Mos agent yo'q: ${unstaffed.join(", ")}`, "Yollash so'rovi yuborildi; agent paydo bo'lgach vazifani unga biriktiring.");

    // Hand each piece to its agent (internal coordination, not a chat channel).
    this.setAgent(agentId, "COMMUNICATING");
    for (const t of created) this.message(task.id, agentId, t.agentId, "handoff", `Yangi vazifa: ${t.title}`);
    transitionTask(this.ctx, task.id, "WAITING_FOR_DEPENDENCY", SYSTEM, { reason: "subtasks created" });
    this.ctx.db.run("UPDATE tasks SET stage = ?, progress = 10 WHERE id = ?", `Agentlar ishlamoqda (0/${created.length})`, task.id);
    this.ctx.bus.emit("task.progress", { taskId: task.id, agentId, departmentId: task.departmentId }, { progress: 10, stage: `Agentlar ishlamoqda (0/${created.length})` });
    this.settle(agentId, "COMMUNICATING");
  }

  /**
   * AI Director step 2 — every piece is back. First each new result is evaluated (a missing deliverable fails the
   * deterministic check; otherwise the director's model judges completeness, missing information, contradictions,
   * assumptions and sources). NEEDS_REVISION returns the piece to its agent as a new revision subtask (earlier
   * versions stay) within the revision limit; REJECTED blocks the job; NEEDS_HUMAN_REVIEW sends the final result to a
   * person. Only then are the accepted results combined.
   */
  private async synthesize(task: TaskDto, subtasks: TaskDto[], signal: AbortSignal) {
    const agentId = task.agentId!;
    const settings = directorSettings(this.ctx, task.businessUnitId);
    const superseded = new Set(subtasks.map((s) => s.revisionOf).filter((x): x is string => !!x));
    const current = subtasks.filter((s) => !superseded.has(s.id));
    const verdicts = new Map(this.ctx.db.all<{ task_id: string; verdict: Verdict }>(
      "SELECT task_id, verdict FROM task_evaluations WHERE parent_task_id = ?", task.id,
    ).map((r) => [r.task_id, r.verdict]));
    this.setAgent(agentId, "THINKING");
    const results = current.map((s) => this.resultOf(s)).filter((p): p is PriorResult => !!p);
    const revisions: TaskDto[] = [];
    for (const s of current) {
      if (verdicts.has(s.id)) continue;
      this.stage(task, `Natija baholanmoqda: ${s.title}`);
      const e = await this.evaluate(task, s, results.filter((r) => r.title !== s.title), signal);
      const round = this.roundOf(s);
      let verdict = e.verdict;
      if (verdict === "NEEDS_REVISION" && round >= settings.maxRevisions) verdict = "NEEDS_HUMAN_REVIEW"; // no endless loops
      this.ctx.db.tx(() => {
        this.assertStillMine(task);
        let revisionId: string | null = null;
        if (verdict === "NEEDS_REVISION") {
          const rev = createTask(this.ctx, {
            title: `${s.title} (qayta ishlash ${round + 1})`,
            description: `${s.description}\n\n## AI Direktor izohi (qayta ishlash ${round + 1}/${settings.maxRevisions})\n${e.feedback}\n${e.issues.map((x) => `- ${x}`).join("\n")}\n\nOldingi versiya kontekst sifatida berilgan; uni to'ldirib, to'liq yangi natija yoz.`,
            agentId: s.agentId!, parentId: task.id, dependsOn: [s.id], priority: task.priority, deadline: task.deadline,
            limits: { ...task.limits, maxAgents: undefined },
          }, { type: "agent", id: agentId });
          this.ctx.db.run("UPDATE tasks SET revision_of = ? WHERE id = ?", s.id, rev.id);
          this.ctx.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", task.id, rev.id);
          this.ctx.db.run(
            `INSERT INTO task_handoffs (id, parent_task_id, task_id, business_unit_id, from_agent_id, to_agent_id, input, output_format, created_at)
             VALUES (?,?,?,?,?,?,?, 'markdown', ?)`,
            uid("hof"), task.id, rev.id, task.businessUnitId, agentId, s.agentId, JSON.stringify({ revisionOf: s.id, feedback: e.feedback, issues: e.issues }), now(),
          );
          revisionId = rev.id;
          revisions.push(rev);
        }
        const dlv = this.ctx.db.get<{ id: string }>("SELECT id FROM deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", s.id);
        this.ctx.db.run(
          `INSERT INTO task_evaluations (id, parent_task_id, task_id, deliverable_id, round, verdict, issues, feedback, revision_task_id, evaluator, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          uid("evl"), task.id, s.id, dlv?.id ?? null, round, verdict, JSON.stringify(e.issues), e.feedback, revisionId, e.by === "checks" ? "checks" : agentId, now(),
        );
        audit(this.ctx.db, { type: "agent", id: agentId }, "orchestrator.evaluate", { type: "task", id: s.id }, { verdict, round, revision: revisionId });
      });
      verdicts.set(s.id, verdict);
      if (verdict === "REJECTED") {
        const why = `Natija rad etildi: ${s.title} — ${e.feedback || e.issues.join("; ")}`;
        transitionTask(this.ctx, task.id, "BLOCKED", SYSTEM, { error: why, reason: "subtask result rejected" });
        this.alert(task, "project.blocked", `Loyiha to'xtadi: ${task.title}`, why);
        this.settle(agentId, "THINKING");
        return;
      }
    }
    if (revisions.length) {
      for (const r of revisions) this.message(task.id, agentId, r.agentId, "handoff", `Qayta ishlash: ${r.title}`);
      transitionTask(this.ctx, task.id, "WAITING_FOR_DEPENDENCY", SYSTEM, { reason: "revisions requested" });
      this.ctx.db.run("UPDATE tasks SET stage = ? WHERE id = ?", `Qayta ishlash kutilmoqda (${revisions.length})`, task.id);
      this.settle(agentId, "THINKING");
      return;
    }
    // combine the accepted (and human-review) results; superseded versions are kept but not used
    this.stage(task, "Natijalar birlashtirilmoqda");
    const human = current.filter((s) => verdicts.get(s.id) === "NEEDS_HUMAN_REVIEW").map((s) => s.title);
    const system = buildSystemPrompt(this.ctx, agentId, [
      "\n## Birlashtiruvchi vazifasi",
      "Bo'limlar natijalarini bitta izchil yakuniy hujjatga birlashtir: qisqa xulosa, asosiy bo'limlar, raqamlar (manbasi bilan), keyingi qadamlar.",
      "Natijalar orasida ziddiyat bo'lsa, buni ko'rsat. Yangi faktlar qo'shma.",
    ]);
    this.setAgent(agentId, "WORKING");
    const g = await this.ground(task);
    const res = await this.call(task, { system, messages: [{ role: "user", text: buildTaskMessage(task, results, null, g.grounding) }] }, signal);
    const note = human.length ? `\n\n> Inson ko'rib chiqishi kerak: ${human.join(", ")} (qayta ishlash limiti tugadi yoki baholash aniq emas).` : "";
    this.finish(task, withSources(res.text, g.hits) + note, "Yakuniy natija", human.length > 0);
  }

  /** Revision round of a subtask: 0 for the first result, n for the n-th redo. */
  private roundOf(t: TaskDto): number {
    let n = 0;
    let cur: string | null = t.revisionOf ?? null;
    while (cur && n < 20) {
      n++;
      cur = this.ctx.db.get<{ revision_of: string | null }>("SELECT revision_of FROM tasks WHERE id = ?", cur)?.revision_of ?? null;
    }
    return n;
  }

  /** One result's verdict: deterministic checks first, then the director's model (strict JSON; unparsable → human). */
  private async evaluate(task: TaskDto, s: TaskDto, others: PriorResult[], signal: AbortSignal): Promise<{ verdict: Verdict; issues: string[]; feedback: string; by: "checks" | "model" }> {
    const mine = this.resultOf(s);
    if (!mine || mine.content.trim().length < 40 || /^Natija yozilmadi\.?$/.test(mine.content.trim()))
      return { verdict: "NEEDS_REVISION", issues: ["Natija (deliverable) yo'q yoki juda qisqa"], feedback: "Talab qilingan natijani to'liq yozing.", by: "checks" };
    const system = buildSystemPrompt(this.ctx, task.agentId!, [
      "\n## Baholovchi vazifasi — AI Direktor",
      "Kichik vazifa natijasini bahola: vazifa bajarilganmi, kutilgan natija bormi, muhim ma'lumot yetishmaydimi,",
      "boshqa agentlar natijalariga zid emasmi, hisob-kitoblarda taxminlar ko'rsatilganmi, kerak joyda manba yoki dalil bormi.",
      "verdict: ACCEPTED (yetarli), NEEDS_REVISION (agent tuzata oladi — aniq izoh yoz), REJECTED (vazifaga umuman mos emas),",
      "NEEDS_HUMAN_REVIEW (inson qarori kerak: masalan yuridik/moliyaviy risk yoki ma'lumot yo'q).",
      "Javob — faqat JSON: {\"verdict\": \"ACCEPTED|NEEDS_REVISION|REJECTED|NEEDS_HUMAN_REVIEW\", \"issues\": [string], \"feedback\": string}",
    ]);
    const text = [
      `## Umumiy topshiriq\n${task.title}\n${task.description}`,
      `## Kichik vazifa\n${s.title}\n${s.description}`,
      `## Natija (${mine.agent})\n<result>\n${mine.content.slice(0, 12000)}\n</result>`,
      others.length ? `## Boshqa natijalar (qisqa)\n${others.map((o) => `### ${o.title}\n${o.content.slice(0, 1500)}`).join("\n")}` : "",
    ].join("\n\n");
    const res = await this.call(task, { system, messages: [{ role: "user", text }], json: true, temperature: 0.1 }, signal);
    const parsed = EvalSchema.safeParse((() => { try { return JSON.parse(stripFence(res.text)); } catch { return null; } })());
    if (!parsed.success) return { verdict: "NEEDS_HUMAN_REVIEW", issues: ["Baholash javobi tushunarsiz bo'ldi"], feedback: "", by: "model" };
    return { ...parsed.data, by: "model" };
  }

  /** Notification to the task's creator and the unit's admins (deduplicated per task and kind). */
  private alert(task: TaskDto, kind: string, title: string, body: string) {
    const people = new Set<string>([...(task.createdBy ? [task.createdBy] : []), ...this.ctx.db.all<{ id: string }>(
      `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE rp.permission_id = 'users:manage' AND u.status = 'active' AND u.home_unit_id = ?`, task.businessUnitId,
    ).map((r) => r.id)]);
    for (const userId of people) notify(this.ctx, { userId, kind, taskId: task.id, title, body, dedupeKey: `${kind}:${task.id}:${userId}` });
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
      const lease = this.leaseOf(task);
      const route = this.routeFor(task);
      this.ctx.db.run(
        `INSERT INTO agent_runs (id, task_id, agent_id, correlation_id, model, mode, status, started_at, worker_id, lease_epoch, provider)
         VALUES (?,?,?,?,?,?, 'running', ?, ?, ?, ?)`,
        runId, task.id, task.agentId, correlationId, route.model ?? this.llm.model, this.llm.mode, now(), lease.workerId, lease.epoch, route.provider ?? null,
      );
      try {
        const res = await this.llm.generate({
          ...req, correlationId, signal, timeoutMs: this.o.taskTimeoutMs, route,
          maxOutputTokens: Math.max(256, Math.min(req.maxOutputTokens ?? 6000, 8192, budget.tokensLeft)),
        });
        this.recordUsage(task, runId, res, Date.now() - started);
        return { ...res, runId };
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), "server", false);
        const aborted = err.code === "aborted" || signal.aborted;
        const reason = this.lost.has(task.id) ? "lost_lease" : aborted ? "aborted" : err.retryable && attempt < maxAttempts ? "retryable_error" : "final_error";
        this.ctx.db.run(
          "UPDATE agent_runs SET status = ?, error = ?, latency_ms = ?, finished_at = ?, end_reason = COALESCE(end_reason, ?) WHERE id = ?",
          aborted ? "cancelled" : "failed", err.message, Date.now() - started, now(), reason, runId,
        );
        if (aborted) throw new StaleTask();
        if (!err.retryable || attempt >= maxAttempts) throw err;
        this.ctx.db.run(`UPDATE tasks SET attempts = attempts + 1 WHERE ${LEASE_GUARD}`, ...leaseParams(this.leaseOf(task)));
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
    // the whole job (plan + every subtask + revisions) spends from the job's token and cost ceilings
    const rootId = task.parentId ?? task.id;
    const root = task.parentId ? getTask(this.ctx, task.parentId) : task;
    if (root.limits.maxCostUsd || root.limits.maxTokens) {
      const fam = this.ctx.db.get<{ tok: number; cost: number }>(
        "SELECT COALESCE(SUM(tokens_in + tokens_out), 0) tok, COALESCE(SUM(cost_usd), 0) cost FROM tasks WHERE id = ? OR parent_id = ?", rootId, rootId,
      )!;
      if (root.limits.maxTokens && fam.tok >= root.limits.maxTokens) throw new LimitError(`Loyiha token limiti tugadi (${fam.tok}/${root.limits.maxTokens})`);
      if (root.limits.maxCostUsd && fam.cost >= root.limits.maxCostUsd) throw new LimitError(`Loyiha xarajat limiti tugadi ($${fam.cost.toFixed(4)} / $${root.limits.maxCostUsd})`);
      const pct = directorSettings(this.ctx, task.businessUnitId).budgetAlertPct / 100;
      if (root.limits.maxCostUsd && fam.cost >= root.limits.maxCostUsd * pct)
        this.alert(root, "budget.threshold", `Byudjet ${Math.round(pct * 100)}% ga yetdi: ${root.title}`, `$${fam.cost.toFixed(4)} / $${root.limits.maxCostUsd}`);
    }
    return { tokensLeft: l.maxTokens ? l.maxTokens - used : Infinity };
  }

  /** Provider and model of this call: the AI Director's settings for orchestrated jobs, else the agent's own. */
  private routeFor(task: TaskDto): { provider: "gemini" | "anthropic" | null; model: string | null } {
    const a = this.ctx.db.get<{ provider: "gemini" | "anthropic" | null; model: string | null }>("SELECT provider, model FROM agents WHERE id = ?", task.agentId);
    if (task.kind === "orchestrate") {
      const s = directorSettings(this.ctx, task.businessUnitId);
      if (s.provider || s.model) return { provider: s.provider ?? a?.provider ?? null, model: s.model ?? (s.provider ? null : a?.model ?? null) };
    }
    return { provider: a?.provider ?? null, model: a?.model ?? null };
  }

  private recordUsage(task: TaskDto, runId: string, res: LlmResult, latency: number) {
    // provider-reported tokens; cost is an estimate at the answering provider's configured price
    const cost = res.costUsd ?? estimateCost(this.pricing, res.inputTokens, res.outputTokens);
    const provider = res.provider ?? (this.llm.provider === "router" ? null : this.llm.provider);
    this.ctx.db.tx(() => {
      this.ctx.db.run(
        "UPDATE agent_runs SET status = 'succeeded', end_reason = 'succeeded', model = ?, provider = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, latency_ms = ?, finished_at = ? WHERE id = ?",
        res.model, provider, res.inputTokens, res.outputTokens, cost, latency, now(), runId,
      );
      this.ctx.db.run(
        `INSERT INTO usage_records (id, run_id, agent_id, department_id, task_id, model, input_tokens, output_tokens, cost_usd, is_estimate, created_at, provider)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
        uid("use"), runId, task.agentId, task.departmentId, task.id, res.model, res.inputTokens, res.outputTokens, cost, now(), provider,
      );
      this.ctx.db.run(
        "UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE id = ?",
        res.inputTokens, res.outputTokens, cost, task.id,
      );
    });
  }

  private finish(task: TaskDto, text: string, title: string, humanReview = false) {
    const needsApproval = task.requiresApproval || humanReview;
    this.ctx.db.tx(() => {
      // fenced: a run that lost its lease (and was re-run elsewhere) must not add a second result
      this.assertStillMine(task);
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
    if (task.kind === "orchestrate")
      this.alert(task, needsApproval ? "project.approval" : "project.completed",
        needsApproval ? `Tasdiq kutilmoqda: ${task.title}` : `Loyiha tayyor: ${task.title}`, summarize(text));
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
    const lease = this.leases.get(task.id);
    const mine = this.ctx.db.tx(() => {
      if (!lease || !holdsLease(this.ctx, lease)) return false; // lost the lease: the next run decides the outcome
      transitionTask(this.ctx, task.id, "FAILED", SYSTEM, { error, reason: "agent run failed" });
      return true;
    });
    if (!mine) return;
    this.setAgent(task.agentId!, "ERROR");
    this.settle(task.agentId!, "ERROR", 15_000);
    // a failed piece blocks the combined job instead of leaving it waiting forever
    if (task.parentId) {
      const parent = getTask(this.ctx, task.parentId);
      if (parent.status === "WAITING_FOR_DEPENDENCY") {
        transitionTask(this.ctx, parent.id, "BLOCKED", SYSTEM, { error: `Kichik vazifa bajarilmadi: ${task.title} — ${error}`, reason: "subtask failed" });
        this.alert(parent, "project.blocked", `Loyiha to'xtadi: ${parent.title}`, `Kichik vazifa bajarilmadi: ${task.title} — ${error}`);
      }
    } else if (task.kind === "orchestrate") this.alert(task, "project.failed", `Loyiha bajarilmadi: ${task.title}`, error);
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
  /**
   * Documents of the task's own business unit (knowledge/scope.ts: HQ → HQ, branch → own + HQ documents shared with
   * branches, franchise → own only) for the agent's department, plus approved memory (HQ's only — other units have
   * no memory store yet).
   */
  private async ground(task: TaskDto, extraQuery?: string): Promise<{ grounding: Grounding; hits: KnowledgeHit[] }> {
    const a = this.ctx.db.get<{ department_id: string; business_unit_id: string }>("SELECT department_id, business_unit_id FROM agents WHERE id = ?", task.agentId);
    // the agent works for one unit; a task outside it (should not exist — DB triggers) gets no documents at all
    if (!a || a.business_unit_id !== task.businessUnitId) return { hits: [], grounding: {} };
    const hq = task.businessUnitId === "hq";
    // the department's private documents and memory only when the person the work is for may read them
    const dept = hq ? agentKnowledgeDept(this.ctx, a.department_id, requesterOf(this.ctx, task.id)) : null;
    const { hits } = await retrieve(this.ctx, embedderOf(this.llm), `${extraQuery ?? task.title} ${task.description}`, {
      unitId: task.businessUnitId, departmentId: hq ? dept : undefined, limit: 5,
      onError: (e) => this.o.log?.("semantic search fell back to full-text", { err: (e as Error).message }),
    });
    return { hits, grounding: { docs: hits.map((h) => ({ title: h.title, content: h.content })), ...(hq ? { memory: approvedMemory(this.ctx, dept) } : {}) } };
  }

  private priorResults(task: TaskDto): PriorResult[] {
    // prerequisites share the task's unit (createTask + DB trigger); re-checked here so no other unit's result is read
    return task.dependsOn.map((id) => getTask(this.ctx, id)).filter((t) => t.businessUnitId === task.businessUnitId)
      .map((t) => this.resultOf(t)).filter((p): p is PriorResult => !!p);
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

  /** Progress text, written only while this run still holds the task's lease. */
  private stage(task: TaskDto, stage: string) {
    const l = this.leaseOf(task);
    const ok = this.ctx.db.run(`UPDATE tasks SET stage = ?, updated_at = ? WHERE ${LEASE_GUARD} AND agent_id IS ?`, stage, now(), ...leaseParams(l), task.agentId).changes;
    if (!ok) throw new StaleTask();
    this.ctx.bus.emit("task.progress", { taskId: task.id, agentId: task.agentId, departmentId: task.departmentId }, { progress: null, stage }, null);
  }

  /**
   * The task may have been stopped, cancelled, reassigned, or re-queued after this run lost its lease (and possibly
   * claimed by another worker). Call inside the write transaction whose writes it protects.
   */
  private assertStillMine(task: TaskDto) {
    const l = this.leaseOf(task);
    if (!this.ctx.db.get(`SELECT 1 FROM tasks WHERE ${LEASE_GUARD} AND agent_id IS ?`, ...leaseParams(l), task.agentId)) throw new StaleTask();
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
