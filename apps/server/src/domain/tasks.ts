import type { TaskPriority, TaskStatus } from "@sag/shared";
import { OPEN_TASK_STATUSES, TERMINAL_TASK_STATUSES, allowedTaskTransitions, canTransitionTask } from "@sag/shared";
import { json, now } from "../db/db.js";
import { type Actor, audit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import type { Ctx } from "./context.js";
import { getDepartment } from "./org.js";

export type { TaskDto, TaskLimits } from "@sag/shared";
import type { TaskDto, TaskLimits } from "@sag/shared";

interface TaskRow {
  revision_of?: string | null;
  id: string; title: string; description: string; created_by: string | null; parent_id: string | null;
  department_id: string | null; agent_id: string | null; priority: TaskPriority; deadline: string | null;
  status: TaskStatus; progress: number | null; stage: string | null; result: string | null; error: string | null;
  attempts: number; max_attempts: number; lease_owner: string | null; lease_until: string | null; limits: string;
  started_at: string | null; completed_at: string | null; tokens_in: number; tokens_out: number; cost_usd: number;
  created_at: string; updated_at: string; kind: "single" | "orchestrate" | "human"; requires_approval: number; scheduled_for: string | null;
  assignee_user_id: string | null; assigned_by: string | null; reviewer_user_id: string | null; estimate_hours: number | null;
  actual_hours: number | null; is_optional: number; weight: number; decline_reason: string | null; accepted_at: string | null;
  submitted_at: string | null; business_unit_id: string;
}

const OPEN = OPEN_TASK_STATUSES.map((s) => `'${s}'`).join(",");
const PRIORITY_RANK = "CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END";

export type { TaskRow };

export function toDto(ctx: Ctx, r: TaskRow): TaskDto {
  const deps = ctx.db.all<{ depends_on_id: string }>("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", r.id);
  return {
    id: r.id, kind: r.kind, requiresApproval: !!r.requires_approval, scheduledFor: r.scheduled_for, title: r.title, description: r.description, createdBy: r.created_by, parentId: r.parent_id, revisionOf: r.revision_of ?? null,
    departmentId: r.department_id, agentId: r.agent_id, priority: r.priority, deadline: r.deadline, status: r.status,
    progress: r.progress, stage: r.stage, result: r.result, error: r.error, attempts: r.attempts, maxAttempts: r.max_attempts,
    limits: json(r.limits, {}), dependsOn: deps.map((d) => d.depends_on_id),
    startedAt: r.started_at, completedAt: r.completed_at, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    createdAt: r.created_at, updatedAt: r.updated_at, businessUnitId: r.business_unit_id,
    ...(r.kind === "human"
      ? {
          assigneeUserId: r.assignee_user_id, assignedBy: r.assigned_by, reviewerUserId: r.reviewer_user_id,
          estimateHours: r.estimate_hours, actualHours: r.actual_hours, isOptional: !!r.is_optional, weight: r.weight,
          declineReason: r.decline_reason, acceptedAt: r.accepted_at, submittedAt: r.submitted_at,
        }
      : {}),
  };
}

function row(ctx: Ctx, id: string): TaskRow {
  const r = ctx.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  if (!r) throw notFound("Vazifa");
  return r;
}

export const getTask = (ctx: Ctx, id: string) => toDto(ctx, row(ctx, id));

export interface TaskFilter {
  status?: TaskStatus[]; departmentId?: string; agentId?: string; parentId?: string | null; limit?: number;
  /** owning unit; HQ routes pass 'hq', internal callers (runner) may omit it */
  unitId?: string;
  /** only agent (non-human) tasks */
  aiOnly?: boolean;
  /** access predicate over alias `t` (from `visibleTaskSql`); omitted = internal callers (runner, scheduler) */
  visible?: { sql: string; params: string[] };
}

export function listTasks(ctx: Ctx, f: TaskFilter = {}): TaskDto[] {
  const where = ["1=1"];
  const p: (string | number)[] = [];
  if (f.status?.length) {
    where.push(`status IN (${f.status.map(() => "?").join(",")})`);
    p.push(...f.status);
  }
  if (f.departmentId) { where.push("department_id = ?"); p.push(f.departmentId); }
  if (f.agentId) { where.push("agent_id = ?"); p.push(f.agentId); }
  if (f.unitId) { where.push("business_unit_id = ?"); p.push(f.unitId); }
  if (f.parentId === null) where.push("parent_id IS NULL");
  else if (f.parentId) { where.push("parent_id = ?"); p.push(f.parentId); }
  if (f.aiOnly) where.push("kind <> 'human'");
  if (f.visible) { where.push(f.visible.sql); p.push(...f.visible.params); }
  p.push(Math.min(f.limit ?? 200, 500));
  return ctx.db
    .all<TaskRow>(`SELECT t.* FROM tasks t WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC LIMIT ?`, ...p)
    .map((r) => toDto(ctx, r));
}

/** Full detail for the task modal: subtasks, deps, activity, messages, deliverables, approvals, runs, tools. */
export function getTaskDetail(ctx: Ctx, id: string) {
  const task = getTask(ctx, id);
  const { db } = ctx;
  return {
    task,
    subtasks: listTasks(ctx, { parentId: id }),
    dependents: db.all<{ task_id: string }>("SELECT task_id FROM task_dependencies WHERE depends_on_id = ?", id).map((r) => r.task_id),
    events: ctx.bus.forTask(id),
    messages: db.all("SELECT id, from_agent_id fromAgentId, to_agent_id toAgentId, kind, content, created_at createdAt FROM agent_messages WHERE task_id = ? ORDER BY created_at", id),
    deliverables: db.all("SELECT id, agent_id agentId, title, content, format, created_at createdAt FROM deliverables WHERE task_id = ? ORDER BY created_at", id),
    approvals: db.all("SELECT id, agent_id agentId, action, payload, status, requested_at requestedAt, decided_by decidedBy, decided_at decidedAt, reason FROM approvals WHERE task_id = ? ORDER BY requested_at", id),
    runs: db.all("SELECT id, agent_id agentId, correlation_id correlationId, model, mode, status, input_tokens inputTokens, output_tokens outputTokens, cost_usd costUsd, latency_ms latencyMs, error, started_at startedAt, finished_at finishedAt FROM agent_runs WHERE task_id = ? ORDER BY started_at", id),
    tools: db.all(
      `SELECT te.id, te.run_id runId, te.tool, te.connector_id connectorId, te.status, te.error, te.started_at startedAt, te.finished_at finishedAt
       FROM tool_executions te JOIN agent_runs r ON r.id = te.run_id WHERE r.task_id = ? ORDER BY te.started_at`, id,
    ),
  };
}

// ---------- assignment ----------

/** Least-loaded active agent in a department (ties → oldest agent). */
export function pickAgent(ctx: Ctx, departmentId: string): string | null {
  const r = ctx.db.get<{ id: string }>(
    `SELECT a.id FROM agents a
     LEFT JOIN tasks t ON t.agent_id = a.id AND t.status IN (${OPEN})
     WHERE a.department_id = ? AND a.lifecycle = 'ACTIVE'
     GROUP BY a.id ORDER BY COUNT(t.id), a.created_at LIMIT 1`,
    departmentId,
  );
  return r?.id ?? null;
}

function activeAgent(ctx: Ctx, agentId: string) {
  const a = ctx.db.get<{ id: string; department_id: string; lifecycle: string }>("SELECT id, department_id, lifecycle FROM agents WHERE id = ?", agentId);
  if (!a) throw notFound("Agent");
  if (a.lifecycle !== "ACTIVE") throw badRequest(`Agent ${a.lifecycle === "PAUSED" ? "to'xtatilgan (paused)" : "arxivlangan"} — vazifa bera olmaysiz`);
  return a;
}

// ---------- dependencies ----------

function depsSatisfied(ctx: Ctx, taskId: string): boolean {
  return !ctx.db.get(
    `SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ? AND t.status <> 'DONE' LIMIT 1`,
    taskId,
  );
}

/** Rejects a dependency set that would create a cycle (DFS over existing edges). */
export function assertNoCycle(ctx: Ctx, taskId: string, dependsOn: string[]) {
  const edges = new Map<string, string[]>();
  for (const e of ctx.db.all<{ task_id: string; depends_on_id: string }>("SELECT * FROM task_dependencies"))
    edges.set(e.task_id, [...(edges.get(e.task_id) ?? []), e.depends_on_id]);
  edges.set(taskId, [...(edges.get(taskId) ?? []), ...dependsOn]);
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === taskId) throw badRequest("Bog'liqliklar halqa hosil qiladi (cycle)");
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(edges.get(n) ?? []));
  }
}

// ---------- create / update ----------

export interface CreateTaskInput {
  title: string; description?: string; departmentId?: string | null; agentId?: string | null;
  priority?: TaskPriority; deadline?: string | null; parentId?: string | null; dependsOn?: string[];
  limits?: TaskLimits; maxAttempts?: number; backlog?: boolean; requiresApproval?: boolean;
  /** ISO time; in the future → the task waits in BACKLOG and the scheduler queues it then */
  scheduledFor?: string | null;
  /** owning unit (default 'hq'); the database refuses departments, agents or parents of another unit */
  unitId?: string;
}

/** Department whose agent plans and combines multi-department work. */
export const ORCHESTRATOR_DEPARTMENT = "director";

export function createTask(ctx: Ctx, input: CreateTaskInput, actor: Actor): TaskDto {
  const id = uid("tsk");
  const t = now();
  let departmentId = input.departmentId ?? null;
  let agentId = input.agentId ?? null;
  let stage: string | null = null;
  let kind: "single" | "orchestrate" = "single";

  if (agentId) {
    const a = activeAgent(ctx, agentId);
    if (departmentId && departmentId !== a.department_id) throw badRequest("Agent tanlangan bo'limga tegishli emas");
    departmentId = a.department_id;
  } else if (departmentId) {
    getDepartment(ctx, departmentId);
    agentId = input.backlog ? null : pickAgent(ctx, departmentId);
    if (!agentId && !input.backlog) stage = "Bo'limda faol agent yo'q";
  } else if (!input.parentId && !input.backlog && (agentId = pickAgent(ctx, ORCHESTRATOR_DEPARTMENT))) {
    // No department chosen: the Director agent plans it, splits it across departments and combines the results.
    kind = "orchestrate";
    departmentId = ORCHESTRATOR_DEPARTMENT;
    stage = "Rejalashtirish navbatda";
  } else {
    agentId = null;
    stage = "Yo'naltirishni kutmoqda";
  }
  if (input.parentId) row(ctx, input.parentId);
  const deps = [...new Set(input.dependsOn ?? [])];
  for (const d of deps) row(ctx, d);

  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO tasks (business_unit_id, id, kind, title, description, created_by, parent_id, department_id, agent_id, priority, deadline, status, stage, limits, max_attempts, created_at, updated_at, requires_approval)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'BACKLOG', ?,?,?,?,?,?)`,
      input.unitId ?? (input.parentId ? row(ctx, input.parentId).business_unit_id : "hq"), id, kind, input.title, input.description ?? "", actor.type === "user" ? actor.id : null, input.parentId ?? null,
      departmentId, agentId, input.priority ?? "MEDIUM", input.deadline ?? null, stage,
      JSON.stringify(input.limits ?? {}), input.maxAttempts ?? 3, t, t, input.requiresApproval ? 1 : 0,
    );
    if (deps.length) {
      assertNoCycle(ctx, id, deps);
      for (const d of deps) ctx.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", id, d);
    }
    const later = input.scheduledFor && Date.parse(input.scheduledFor) > Date.now();
    if (later) {
      ctx.db.run("UPDATE tasks SET scheduled_for = ?, stage = 'Rejalashtirilgan' WHERE id = ?", new Date(input.scheduledFor!).toISOString(), id);
    } else if (agentId) {
      const to: TaskStatus = depsSatisfied(ctx, id) ? "QUEUED" : "WAITING_FOR_DEPENDENCY";
      ctx.db.run("UPDATE tasks SET status = ? WHERE id = ?", to, id);
    }
    audit(ctx.db, actor, "task.create", { type: "task", id }, { title: input.title, departmentId, agentId, parentId: input.parentId ?? null });
  });
  const task = getTask(ctx, id);
  ctx.bus.emit("task.created", { taskId: id, agentId, departmentId }, { title: task.title, status: task.status, parentId: task.parentId }, actor.id);
  return task;
}

export function updateTask(
  ctx: Ctx, id: string,
  patch: { title?: string; description?: string; priority?: TaskPriority; deadline?: string | null; limits?: TaskLimits },
  actor: Actor,
): TaskDto {
  const r = row(ctx, id);
  if (TERMINAL_TASK_STATUSES.includes(r.status)) throw conflict("task_closed", "Yakunlangan vazifani tahrirlab bo'lmaydi");
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  for (const k of ["title", "description", "priority", "deadline"] as const) {
    if (k in patch) { sets.push(`${k} = ?`); vals.push((patch[k] as string | null) ?? null); }
  }
  if (patch.limits) { sets.push("limits = ?"); vals.push(JSON.stringify(patch.limits)); }
  if (!sets.length) return getTask(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...vals, now(), id);
    audit(ctx.db, actor, "task.update", { type: "task", id }, patch);
  });
  ctx.bus.emit("task.updated", { taskId: id, agentId: r.agent_id, departmentId: r.department_id }, { fields: Object.keys(patch) }, actor.id);
  return getTask(ctx, id);
}

// ---------- status lifecycle ----------

/**
 * Atomic, validated status change. The UPDATE is guarded by the current status, so two concurrent writers
 * cannot both move the same task (the loser gets 409).
 */
export function transitionTask(
  ctx: Ctx, id: string, to: TaskStatus, actor: Actor,
  extra: { reason?: string; error?: string | null; result?: string | null } = {},
): TaskDto {
  const r = row(ctx, id);
  if (!canTransitionTask(r.status, to))
    throw conflict("invalid_transition", `${r.status} → ${to} o'tishi mumkin emas`, { from: r.status, to, allowed: allowedTaskTransitions(r.status) });
  if ((to === "QUEUED" || to === "IN_PROGRESS") && !r.agent_id) throw badRequest("Vazifaga agent biriktirilmagan");
  const t = now();
  const released = ctx.db.tx(() => {
    const res = ctx.db.run(
      `UPDATE tasks SET status = ?, updated_at = ?,
         started_at = CASE WHEN ? = 'IN_PROGRESS' AND started_at IS NULL THEN ? ELSE started_at END,
         completed_at = CASE WHEN ? IN ('DONE','FAILED','CANCELLED') THEN ? ELSE NULL END,
         progress = CASE WHEN ? = 'DONE' THEN 100 ELSE progress END,
         stage = CASE WHEN ? IN ('DONE','CANCELLED') THEN NULL ELSE stage END,
         lease_owner = CASE WHEN ? = 'IN_PROGRESS' THEN lease_owner ELSE NULL END,
         lease_until = CASE WHEN ? = 'IN_PROGRESS' THEN lease_until ELSE NULL END,
         error = CASE WHEN ? IS NOT NULL THEN ? WHEN ? = 'QUEUED' THEN NULL ELSE error END,
         result = COALESCE(?, result)
       WHERE id = ? AND status = ?`,
      to, t, to, t, to, t, to, to, to, to, extra.error ?? null, extra.error ?? null, to, extra.result ?? null, id, r.status,
    );
    if (res.changes !== 1) throw conflict("concurrent_update", "Vazifa holati boshqa jarayon tomonidan o'zgartirildi");
    audit(ctx.db, actor, "task.transition", { type: "task", id }, { from: r.status, to, reason: extra.reason });
    if (to === "CANCELLED") cancelSubtasks(ctx, id, t);
    return to === "DONE" ? releaseDependents(ctx, id, t) : [];
  });
  ctx.bus.emit("task.status", { taskId: id, agentId: r.agent_id, departmentId: r.department_id }, { from: r.status, to, reason: extra.reason ?? null }, actor.id);
  for (const d of released)
    ctx.bus.emit("task.status", { taskId: d.id, agentId: d.agent_id, departmentId: d.department_id }, { from: "WAITING_FOR_DEPENDENCY", to: "QUEUED", reason: "dependencies done" }, null);
  return getTask(ctx, id);
}

function cancelSubtasks(ctx: Ctx, parentId: string, t: string) {
  const kids = ctx.db.all<{ id: string }>(`SELECT id FROM tasks WHERE parent_id = ? AND status IN (${OPEN})`, parentId);
  for (const k of kids) {
    ctx.db.run("UPDATE tasks SET status = 'CANCELLED', completed_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?", t, t, k.id);
    cancelSubtasks(ctx, k.id, t);
  }
}

/** When a task finishes, dependents whose prerequisites are now all DONE move to QUEUED. */
function releaseDependents(ctx: Ctx, id: string, t: string) {
  const waiting = ctx.db.all<{ id: string; agent_id: string | null; department_id: string | null }>(
    `SELECT t.id, t.agent_id, t.department_id FROM tasks t JOIN task_dependencies d ON d.task_id = t.id
     WHERE d.depends_on_id = ? AND t.status = 'WAITING_FOR_DEPENDENCY'`, id,
  );
  const released = waiting.filter((w) => w.agent_id && depsSatisfied(ctx, w.id));
  for (const w of released) ctx.db.run("UPDATE tasks SET status = 'QUEUED', updated_at = ? WHERE id = ? AND status = 'WAITING_FOR_DEPENDENCY'", t, w.id);
  return released;
}

export const cancelTask = (ctx: Ctx, id: string, actor: Actor, reason?: string) => transitionTask(ctx, id, "CANCELLED", actor, { reason });

export function retryTask(ctx: Ctx, id: string, actor: Actor): TaskDto {
  const r = row(ctx, id);
  if (r.status !== "FAILED" && r.status !== "BLOCKED") throw conflict("not_retryable", "Faqat FAILED yoki BLOCKED vazifani qayta ishga tushirish mumkin");
  if (r.agent_id) activeAgent(ctx, r.agent_id);
  return transitionTask(ctx, id, "QUEUED", actor, { reason: "retry" });
}

export function reassignTask(ctx: Ctx, id: string, agentId: string, actor: Actor): TaskDto {
  const r = row(ctx, id);
  if (TERMINAL_TASK_STATUSES.includes(r.status)) throw conflict("task_closed", "Yakunlangan vazifani qayta biriktirib bo'lmaydi");
  const a = activeAgent(ctx, agentId);
  const t = now();
  ctx.db.tx(() => {
    // In-flight work restarts from the queue under the new owner.
    const nextStatus = ["IN_PROGRESS", "WAITING_APPROVAL", "BLOCKED", "BACKLOG"].includes(r.status)
      ? depsSatisfied(ctx, id) ? "QUEUED" : "WAITING_FOR_DEPENDENCY"
      : r.status;
    const res = ctx.db.run(
      `UPDATE tasks SET agent_id = ?, department_id = ?, status = ?, stage = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
      a.id, a.department_id, nextStatus, t, id, r.status,
    );
    if (res.changes !== 1) throw conflict("concurrent_update", "Vazifa holati boshqa jarayon tomonidan o'zgartirildi");
    audit(ctx.db, actor, "task.reassign", { type: "task", id }, { from: r.agent_id, to: a.id });
  });
  ctx.bus.emit("task.updated", { taskId: id, agentId: a.id, departmentId: a.department_id }, { change: "reassigned", from: r.agent_id }, actor.id);
  return getTask(ctx, id);
}

/** Progress reported by a running agent: real stage names, percentage only when it is known. */
export function reportProgress(ctx: Ctx, id: string, p: { progress?: number | null; stage?: string | null }, actor: Actor) {
  const r = row(ctx, id);
  if (r.status !== "IN_PROGRESS") throw conflict("not_running", "Vazifa bajarilmayapti");
  ctx.db.run(
    "UPDATE tasks SET progress = COALESCE(?, progress), stage = COALESCE(?, stage), updated_at = ? WHERE id = ?",
    p.progress ?? null, p.stage ?? null, now(), id,
  );
  ctx.bus.emit("task.progress", { taskId: id, agentId: r.agent_id, departmentId: r.department_id }, { progress: p.progress ?? null, stage: p.stage ?? null }, actor.id);
}

// ---------- worker claim (used by the agent runner) ----------

/**
 * Atomically claims the next runnable task: QUEUED, owner ACTIVE, all dependencies DONE.
 * The guarded UPDATE ... WHERE status = 'QUEUED' means a task can only ever be claimed once.
 */
export interface Claimed extends TaskDto {
  /** fencing token: only writes carrying this epoch (and the claiming worker) are accepted for the task */
  leaseEpoch: number;
}

export function claimNextTask(ctx: Ctx, workerId: string, leaseMs: number): Claimed | null {
  const t = now();
  const until = new Date(Date.now() + leaseMs).toISOString();
  const claimed = ctx.db.get<TaskRow & { lease_epoch: number }>(
    `UPDATE tasks SET status = 'IN_PROGRESS', lease_owner = ?, lease_until = ?, attempts = attempts + 1,
       lease_epoch = lease_epoch + 1, started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = (
       SELECT t.id FROM tasks t JOIN agents a ON a.id = t.agent_id
       WHERE t.status = 'QUEUED' AND a.lifecycle = 'ACTIVE'
         -- one task at a time per agent
         AND NOT EXISTS (SELECT 1 FROM tasks b WHERE b.agent_id = t.agent_id AND b.status = 'IN_PROGRESS')
         AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_id
                         WHERE d.task_id = t.id AND p.status <> 'DONE')
       ORDER BY ${PRIORITY_RANK.replace(/priority/g, "t.priority")}, t.created_at LIMIT 1
     ) AND status = 'QUEUED'
     RETURNING *`,
    workerId, until, t, t,
  );
  if (!claimed) return null;
  ctx.bus.emit("task.status", { taskId: claimed.id, agentId: claimed.agent_id, departmentId: claimed.department_id }, { from: "QUEUED", to: "IN_PROGRESS", worker: workerId }, null);
  return { ...toDto(ctx, claimed), leaseEpoch: claimed.lease_epoch };
}

export interface Lease { taskId: string; workerId: string; epoch: number }

/** SQL guard for writes made on behalf of a lease (append to a WHERE clause; params: id, owner, epoch). */
export const LEASE_GUARD = "id = ? AND status = 'IN_PROGRESS' AND lease_owner = ? AND lease_epoch = ?";
export const leaseParams = (l: Lease) => [l.taskId, l.workerId, l.epoch] as const;

/** Does `l` still own its task? */
export function holdsLease(ctx: Ctx, l: Lease): boolean {
  return !!ctx.db.get(`SELECT 1 FROM tasks WHERE ${LEASE_GUARD}`, ...leaseParams(l));
}

/** Heartbeat: extends the lease atomically. False = the lease is gone (expired and recovered, cancelled, stolen). */
export function renewLease(ctx: Ctx, l: Lease, leaseMs: number): boolean {
  const until = new Date(Date.now() + leaseMs).toISOString();
  return ctx.db.run(`UPDATE tasks SET lease_until = ? WHERE ${LEASE_GUARD}`, until, ...leaseParams(l)).changes === 1;
}

/**
 * Graceful stop: give the task back to the queue at once (the attempt is not counted — the worker stopped, the task
 * did not fail). No-op if the lease was already lost.
 */
export function releaseLease(ctx: Ctx, l: Lease, reason: string): boolean {
  const t = now();
  const r = ctx.db.tx(() => {
    const row = ctx.db.get<{ agent_id: string | null; department_id: string | null }>(
      `UPDATE tasks SET status = 'QUEUED', lease_owner = NULL, lease_until = NULL, attempts = MAX(attempts - 1, 0),
         stage = 'Navbatga qaytarildi (server to''xtadi)', updated_at = ?
       WHERE ${LEASE_GUARD} RETURNING agent_id, department_id`,
      t, ...leaseParams(l),
    );
    if (row)
      ctx.db.run(
        "UPDATE agent_runs SET status = 'cancelled', end_reason = 'shutdown', error = ?, finished_at = ? WHERE task_id = ? AND status = 'running'",
        reason, t, l.taskId,
      );
    return row;
  });
  if (!r) return false;
  ctx.bus.emit("task.status", { taskId: l.taskId, agentId: r.agent_id, departmentId: r.department_id }, { from: "IN_PROGRESS", to: "QUEUED", reason }, null);
  return true;
}

/**
 * Puts tasks whose worker is gone back in the queue: leases that ran out, and — when `deadOwner` says which workers
 * have stopped heart-beating — leases they still nominally hold. A task that has used all its attempts fails
 * instead of looping (a task that crashes its worker every time must not crash it forever).
 */
export function recoverExpiredLeases(ctx: Ctx, opts: { deadOwner?: (owner: string | null) => boolean } = {}): string[] {
  const t = now();
  const rows = ctx.db
    .all<{ id: string; agent_id: string | null; department_id: string | null; lease_owner: string | null; lease_until: string | null; attempts: number; max_attempts: number }>(
      "SELECT id, agent_id, department_id, lease_owner, lease_until, attempts, max_attempts FROM tasks WHERE status = 'IN_PROGRESS' AND kind <> 'human'",
    )
    .filter((r) => (r.lease_until !== null && r.lease_until < t) || !!opts.deadOwner?.(r.lease_owner));
  const out: string[] = [];
  for (const r of rows) {
    const exhausted = r.attempts >= r.max_attempts;
    const moved = ctx.db.tx(() => {
      // guarded by the lease we saw: a worker that renewed in the meantime keeps its task
      const ch = ctx.db.run(
        `UPDATE tasks SET status = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?, stage = ?,
           error = CASE WHEN ? = 1 THEN ? ELSE error END
         WHERE id = ? AND status = 'IN_PROGRESS' AND lease_owner IS ? AND lease_until IS ?`,
        exhausted ? "FAILED" : "QUEUED", t,
        exhausted ? null : "Qayta navbatga qo'yildi (ishchi jarayon to'xtagan)",
        exhausted ? 1 : 0, `Ishchi jarayon ${r.attempts} marta to'xtadi — vazifa to'xtatildi`,
        r.id, r.lease_owner, r.lease_until,
      ).changes;
      if (!ch) return false;
      if (exhausted) ctx.db.run("UPDATE tasks SET completed_at = ? WHERE id = ?", t, r.id);
      // the worker that held the lease is gone: its in-flight AI call will never finish, so close it in the log
      ctx.db.run(
        "UPDATE agent_runs SET status = 'failed', end_reason = 'orphaned', error = 'uzildi (ishchi jarayon to''xtadi)', finished_at = ? WHERE task_id = ? AND status = 'running'",
        t, r.id,
      );
      return true;
    });
    if (!moved) continue;
    ctx.bus.emit("task.status", { taskId: r.id, agentId: r.agent_id, departmentId: r.department_id },
      { from: "IN_PROGRESS", to: exhausted ? "FAILED" : "QUEUED", reason: exhausted ? "worker lost, attempts exhausted" : "worker lost" }, null);
    out.push(r.id);
  }
  return out;
}
