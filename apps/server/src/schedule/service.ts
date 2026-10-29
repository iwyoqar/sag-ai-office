// Routines and scheduled tasks. Runs on the server (not in the browser) and survives restarts:
// next_run_at is stored, and each occurrence is recorded once in routine_runs (UNIQUE routine_id + scheduled_for),
// so two scheduler ticks or two server processes can never start the same occurrence twice.
import type { TaskPriority } from "@sag/shared";
import { now } from "../db/db.js";
import type { Ctx } from "../domain/context.js";
import { createTask, getTask, transitionTask } from "../domain/tasks.js";
import { type Actor, SYSTEM, audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { describeRule, nextOccurrence, occurrences, parseRule } from "./rrule.js";

export const DEFAULT_TZ = "Asia/Tashkent";

export interface RoutineDto {
  id: string; name: string; description: string; departmentId: string | null; agentId: string | null;
  rrule: string; schedule: string; timezone: string; nextRunAt: string | null; lastRunAt: string | null;
  status: "ACTIVE" | "PAUSED"; requiresApproval: boolean; priority: TaskPriority; createdAt: string;
  runs: RunDto[];
}

export interface RunDto {
  id: string; scheduledFor: string; taskId: string | null; status: string; startedAt: string; finishedAt: string | null; error: string | null;
}

interface RoutineRow {
  id: string; name: string; description: string; department_id: string | null; agent_id: string | null; rrule: string;
  timezone: string; next_run_at: string | null; last_run_at: string | null; status: "ACTIVE" | "PAUSED";
  requires_approval: number; priority: TaskPriority; created_at: string; created_by: string | null;
}

function runs(ctx: Ctx, routineId: string, limit = 10): RunDto[] {
  return ctx.db.all<RunDto>(
    `SELECT id, scheduled_for scheduledFor, task_id taskId, status, started_at startedAt, finished_at finishedAt, error
     FROM routine_runs WHERE routine_id = ? ORDER BY scheduled_for DESC LIMIT ?`,
    routineId, limit,
  );
}

function toDto(ctx: Ctx, r: RoutineRow): RoutineDto {
  return {
    id: r.id, name: r.name, description: r.description, departmentId: r.department_id, agentId: r.agent_id, rrule: r.rrule,
    schedule: describeRule(r.rrule), timezone: r.timezone, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, status: r.status,
    requiresApproval: !!r.requires_approval, priority: r.priority, createdAt: r.created_at, runs: runs(ctx, r.id),
  };
}

function row(ctx: Ctx, id: string): RoutineRow {
  const r = ctx.db.get<RoutineRow>("SELECT * FROM routines WHERE id = ?", id);
  if (!r) throw notFound("Routine");
  return r;
}

export const listRoutines = (ctx: Ctx) =>
  ctx.db.all<RoutineRow>("SELECT * FROM routines ORDER BY status, next_run_at").map((r) => toDto(ctx, r));
export const getRoutine = (ctx: Ctx, id: string) => toDto(ctx, row(ctx, id));

export interface RoutineInput {
  name: string; description?: string; departmentId?: string | null; agentId?: string | null; rrule: string;
  timezone?: string; requiresApproval?: boolean; priority?: TaskPriority; startAt?: string | null;
}

function validate(ctx: Ctx, i: Partial<RoutineInput>) {
  if (i.rrule !== undefined) {
    try {
      parseRule(i.rrule);
    } catch (e) {
      throw badRequest(`Takrorlanish qoidasi noto'g'ri: ${(e as Error).message}`);
    }
  }
  if (i.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: i.timezone });
    } catch {
      throw badRequest(`Vaqt zonasi noto'g'ri: ${i.timezone}`);
    }
  }
  if (i.departmentId && !ctx.db.get("SELECT 1 FROM departments WHERE id = ?", i.departmentId)) throw notFound("Bo'lim");
  if (i.agentId) {
    const a = ctx.db.get<{ department_id: string; lifecycle: string }>("SELECT department_id, lifecycle FROM agents WHERE id = ?", i.agentId);
    if (!a) throw notFound("Agent");
    if (a.lifecycle === "ARCHIVED") throw badRequest("Agent arxivlangan");
    if (i.departmentId && i.departmentId !== a.department_id) throw badRequest("Agent tanlangan bo'limga tegishli emas");
  }
}

export function createRoutine(ctx: Ctx, input: RoutineInput, actor: Actor, at = new Date()): RoutineDto {
  validate(ctx, input);
  const tz = input.timezone || DEFAULT_TZ;
  const start = input.startAt ? new Date(input.startAt) : at;
  const anchor = start.getTime() > at.getTime() ? start : at;
  const next = nextOccurrence(input.rrule, new Date(anchor.getTime() - 1), tz, anchor);
  const id = uid("rtn");
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO routines (id, name, description, department_id, agent_id, rrule, timezone, next_run_at, status, requires_approval, priority, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'ACTIVE', ?,?,?,?)`,
      id, input.name, input.description ?? "", input.departmentId ?? null, input.agentId ?? null, input.rrule.toUpperCase(), tz,
      next.toISOString(), input.requiresApproval ? 1 : 0, input.priority ?? "MEDIUM", actor.type === "user" ? actor.id : null, anchor.toISOString(),
    );
    audit(ctx.db, actor, "routine.create", { type: "routine", id }, { name: input.name, rrule: input.rrule });
  });
  return getRoutine(ctx, id);
}

export function updateRoutine(ctx: Ctx, id: string, patch: Partial<RoutineInput>, actor: Actor, at = new Date()): RoutineDto {
  const r = row(ctx, id);
  validate(ctx, { ...patch, departmentId: patch.departmentId ?? r.department_id, agentId: patch.agentId === undefined ? r.agent_id : patch.agentId });
  const m: Record<string, string> = {
    name: "name", description: "description", departmentId: "department_id", agentId: "agent_id",
    timezone: "timezone", priority: "priority",
  };
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(m))
    if (k in patch) { sets.push(`${col} = ?`); vals.push((patch as Record<string, string | null>)[k] ?? null); }
  if (patch.requiresApproval !== undefined) { sets.push("requires_approval = ?"); vals.push(patch.requiresApproval ? 1 : 0); }
  if (patch.rrule !== undefined || patch.timezone !== undefined) {
    const rule = (patch.rrule ?? r.rrule).toUpperCase();
    sets.push("rrule = ?", "next_run_at = ?");
    vals.push(rule, nextOccurrence(rule, at, patch.timezone ?? r.timezone, new Date(r.created_at)).toISOString());
  }
  if (!sets.length) return getRoutine(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
    audit(ctx.db, actor, "routine.update", { type: "routine", id }, patch);
  });
  return getRoutine(ctx, id);
}

export function setRoutineStatus(ctx: Ctx, id: string, status: "ACTIVE" | "PAUSED", actor: Actor, at = new Date()) {
  const r = row(ctx, id);
  // resuming never fires the occurrences that passed while paused
  const next = status === "ACTIVE" ? nextOccurrence(r.rrule, at, r.timezone, new Date(r.created_at)).toISOString() : r.next_run_at;
  ctx.db.run("UPDATE routines SET status = ?, next_run_at = ? WHERE id = ?", status, next, id);
  audit(ctx.db, actor, status === "ACTIVE" ? "routine.resume" : "routine.pause", { type: "routine", id });
  return getRoutine(ctx, id);
}

export function deleteRoutine(ctx: Ctx, id: string, actor: Actor) {
  row(ctx, id);
  ctx.db.tx(() => {
    // tasks it created stay (history); only the routine and its run log go
    ctx.db.run("DELETE FROM routines WHERE id = ?", id);
    audit(ctx.db, actor, "routine.delete", { type: "routine", id });
  });
}

/**
 * Starts one occurrence. Returns null if that occurrence was already started (idempotent).
 * The created task is an ordinary task: same routing, approval and notifications as any other.
 */
export function runOccurrence(ctx: Ctx, routineId: string, scheduledFor: Date, actor: Actor = SYSTEM): RunDto | null {
  const r = row(ctx, routineId);
  const runId = uid("rr");
  const inserted = ctx.db.run(
    "INSERT OR IGNORE INTO routine_runs (id, routine_id, scheduled_for, status, started_at) VALUES (?,?,?, 'running', ?)",
    runId, routineId, scheduledFor.toISOString(), now(),
  );
  if (!inserted.changes) return null;
  try {
    const t = createTask(ctx, {
      title: r.name, description: r.description, departmentId: r.department_id, agentId: r.agent_id,
      priority: r.priority, requiresApproval: !!r.requires_approval,
    }, actor);
    ctx.db.run("UPDATE routine_runs SET task_id = ? WHERE id = ?", t.id, runId);
  } catch (e) {
    ctx.db.run("UPDATE routine_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", (e as Error).message, now(), runId);
  }
  ctx.db.run("UPDATE routines SET last_run_at = ? WHERE id = ?", scheduledFor.toISOString(), routineId);
  audit(ctx.db, actor, "routine.run", { type: "routine", id: routineId }, { scheduledFor: scheduledFor.toISOString() });
  return runs(ctx, routineId, 50).find((x) => x.id === runId) ?? null;
}

/**
 * One scheduler pass. Due routines fire once (missed occurrences while the server was down are caught up
 * with a single run, not a burst), and scheduled one-off tasks are released to the queue.
 */
export function schedulerTick(ctx: Ctx, at = new Date()): { routines: number; tasks: number } {
  let fired = 0;
  const due = ctx.db.all<RoutineRow>(
    "SELECT * FROM routines WHERE status = 'ACTIVE' AND next_run_at IS NOT NULL AND next_run_at <= ?", at.toISOString(),
  );
  for (const r of due) {
    const next = nextOccurrence(r.rrule, at, r.timezone, new Date(r.created_at)).toISOString();
    // claim this occurrence by advancing next_run_at atomically; a concurrent scheduler loses here
    const claimed = ctx.db.run("UPDATE routines SET next_run_at = ? WHERE id = ? AND next_run_at = ?", next, r.id, r.next_run_at);
    if (!claimed.changes) continue;
    if (runOccurrence(ctx, r.id, new Date(r.next_run_at!))) fired++;
  }

  let released = 0;
  for (const t of ctx.db.all<{ id: string }>(
    "SELECT id FROM tasks WHERE status = 'BACKLOG' AND scheduled_for IS NOT NULL AND scheduled_for <= ? AND agent_id IS NOT NULL", at.toISOString(),
  )) {
    try {
      transitionTask(ctx, t.id, "QUEUED", SYSTEM, { reason: "scheduled time reached" });
      ctx.db.run("UPDATE tasks SET stage = NULL WHERE id = ?", t.id);
      released++;
    } catch {
      /* changed concurrently (cancelled / started) — nothing to do */
    }
  }
  return { routines: fired, tasks: released };
}

/** Keeps routine_runs in step with the tasks they created. */
export function syncRunStatus(ctx: Ctx, taskId: string, to: string) {
  const map: Record<string, string> = { DONE: "succeeded", FAILED: "failed", CANCELLED: "skipped" };
  if (!map[to]) return;
  const t = getTask(ctx, taskId);
  ctx.db.run(
    "UPDATE routine_runs SET status = ?, finished_at = ?, error = ? WHERE task_id = ? AND status = 'running'",
    map[to], now(), to === "FAILED" ? t.error : null, taskId,
  );
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private ctx: Ctx, private intervalMs = 20_000, private log?: (m: string, meta?: Record<string, unknown>) => void) {}

  start() {
    if (this.timer) return;
    this.unsubscribe = this.ctx.bus.subscribe((e) => {
      if (e.type === "task.status" && e.taskId) syncRunStatus(this.ctx, e.taskId, String(e.data.to));
    });
    const tick = () => {
      try {
        const r = schedulerTick(this.ctx);
        if (r.routines || r.tasks) this.log?.("scheduler", r);
      } catch (e) {
        this.log?.("scheduler error", { error: (e as Error).message });
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
  }
}

// ---------------------------------------------------------------- calendar
export interface CalendarItem {
  kind: "task" | "routine" | "run";
  id: string;
  title: string;
  at: string;
  status: string;
  departmentId: string | null;
  agentId: string | null;
  taskId?: string | null;
  routineId?: string;
}

/** Everything on the calendar in [from, to): scheduled/created/completed tasks, past routine runs, future occurrences. */
export function calendar(ctx: Ctx, from: Date, to: Date, f: { departmentId?: string; agentId?: string } = {}, at = new Date()): CalendarItem[] {
  const F = from.toISOString(), T = to.toISOString();
  const items: CalendarItem[] = [];
  const tasks = ctx.db.all<{ id: string; title: string; status: string; department_id: string | null; agent_id: string | null; scheduled_for: string | null; created_at: string; completed_at: string | null }>(
    `SELECT id, title, status, department_id, agent_id, scheduled_for, created_at, completed_at FROM tasks
     WHERE parent_id IS NULL AND (
       (scheduled_for >= ? AND scheduled_for < ?) OR (completed_at >= ? AND completed_at < ?) OR (scheduled_for IS NULL AND created_at >= ? AND created_at < ?)
     ) AND id NOT IN (SELECT task_id FROM routine_runs WHERE task_id IS NOT NULL)`,
    F, T, F, T, F, T,
  );
  for (const t of tasks)
    items.push({
      kind: "task", id: t.id, title: t.title, status: t.status, departmentId: t.department_id, agentId: t.agent_id, taskId: t.id,
      at: t.completed_at ?? t.scheduled_for ?? t.created_at,
    });
  const rs = ctx.db.all<RoutineRow>("SELECT * FROM routines");
  for (const r of rs) {
    for (const run of ctx.db.all<{ id: string; scheduled_for: string; status: string; task_id: string | null }>(
      "SELECT id, scheduled_for, status, task_id FROM routine_runs WHERE routine_id = ? AND scheduled_for >= ? AND scheduled_for < ?", r.id, F, T,
    ))
      items.push({ kind: "run", id: run.id, title: r.name, at: run.scheduled_for, status: run.status, departmentId: r.department_id, agentId: r.agent_id, taskId: run.task_id, routineId: r.id });
    if (r.status !== "ACTIVE") continue;
    const start = new Date(Math.max(from.getTime(), at.getTime()));
    if (start >= to) continue;
    for (const o of occurrences(r.rrule, start, to, r.timezone, new Date(r.created_at), 200))
      items.push({ kind: "routine", id: `${r.id}@${o.toISOString()}`, title: r.name, at: o.toISOString(), status: "PLANNED", departmentId: r.department_id, agentId: r.agent_id, routineId: r.id });
  }
  return items
    .filter((i) => (!f.departmentId || i.departmentId === f.departmentId) && (!f.agentId || i.agentId === f.agentId))
    .sort((a, b) => a.at.localeCompare(b.at));
}
