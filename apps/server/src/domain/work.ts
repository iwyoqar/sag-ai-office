// Human task workflow on the shared `tasks` table (kind = 'human'):
// assign → accept/decline → start → progress → submit → review (approve / request changes) → done,
// with hierarchical subtasks whose required members drive the parent's progress and status.
// Every change is one transaction: guarded status update + history event + audit + parent aggregation, so
// concurrent writers serialise (BEGIN IMMEDIATE) and a duplicate transition fails with 409 instead of double-applying.
import { allowedHumanTransitions, canTransitionHumanTask, type TaskPriority, type TaskStatus, type TaskDto } from "@sag/shared";
import { now } from "../db/db.js";
import type { AuthUser } from "../lib/auth.js";
import { actorTag, audit, type Actor } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import {
  ancestors, canAssignTo, canManageTask, canSeeParentContext, canSeeTask, has, personRef, visibleTaskIds, visibleTaskSql, type TaskRef,
} from "./access.js";
import type { Ctx } from "./context.js";
import { checkWorkload, notify } from "./notifications.js";
import { assertNoCycle, toDto, type TaskRow } from "./tasks.js";

const SYSTEM: Actor = { type: "system", id: null };
const actorOf = (u: AuthUser): Actor => ({ type: "user", id: u.id });
const DONE_LIKE: TaskStatus[] = ["DONE", "CANCELLED"];

function rowOf(ctx: Ctx, id: string): TaskRow {
  const r = ctx.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  if (!r || r.kind !== "human") throw notFound("Vazifa");
  return r;
}

const refOf = (r: TaskRow): TaskRef => ({
  id: r.id, kind: r.kind, parent_id: r.parent_id, department_id: r.department_id, created_by: r.created_by,
  assigned_by: r.assigned_by, assignee_user_id: r.assignee_user_id, reviewer_user_id: r.reviewer_user_id,
  business_unit_id: r.business_unit_id,
});

/** Loads a human task the caller may see; others get 404 (no existence leak). */
export function visibleTask(ctx: Ctx, u: AuthUser, id: string): TaskRow {
  const r = ctx.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  if (!r || r.kind !== "human" || !canSeeTask(ctx, u, refOf(r))) throw notFound("Vazifa");
  return r;
}

function requireManage(ctx: Ctx, u: AuthUser, r: TaskRow) {
  if (!canManageTask(ctx, u, refOf(r))) throw forbidden();
}
function requireAssignee(u: AuthUser, r: TaskRow) {
  if (r.assignee_user_id !== u.id) throw forbidden();
}

/** Who should hear about a task (content-free realtime events + refetch). */
function audience(ctx: Ctx, r: TaskRow): string[] {
  const ids = new Set<string>();
  for (const t of [refOf(r), ...ancestors(ctx, refOf(r))])
    for (const id of [t.created_by, t.assigned_by, t.assignee_user_id, t.reviewer_user_id]) if (id) ids.add(id);
  return [...ids];
}

function signal(ctx: Ctx, r: TaskRow, actor: string | null, extra: Record<string, unknown> = {}) {
  ctx.bus.emit("work.updated", { taskId: r.id, departmentId: r.department_id }, { human: true, audience: audience(ctx, r), ...extra }, actor);
}

// ---------------------------------------------------------------------------------------------------------------
// transitions

interface MoveOpts {
  reason?: string;
  /** automatic (parent aggregation): skips the transition table, recorded with actor = system */
  auto?: boolean;
  set?: Record<string, string | number | null>;
}

/** Guarded status change + history event + audit. Must run inside a transaction. */
function move(ctx: Ctx, r: TaskRow, to: TaskStatus, actor: Actor, o: MoveOpts = {}): TaskRow {
  if (!o.auto && !canTransitionHumanTask(r.status, to))
    throw conflict("invalid_transition", `${r.status} → ${to} o'tishi mumkin emas`, { from: r.status, to, allowed: allowedHumanTransitions(r.status) });
  const t = now();
  const sets: Record<string, string | number | null> = { status: to, updated_at: t, last_actor: actorTag(actor), ...(o.set ?? {}) };
  if (to === "ACCEPTED" && !r.accepted_at) sets.accepted_at = t;
  if (to === "IN_PROGRESS" && !r.started_at) sets.started_at = t;
  if (to === "IN_REVIEW") sets.submitted_at = t;
  if (to === "DONE") { sets.completed_at = t; sets.progress = 100; }
  if (to === "CANCELLED") sets.completed_at = t;
  const cols = Object.keys(sets);
  const res = ctx.db.run(
    `UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND status = ?`,
    ...cols.map((c) => sets[c]), r.id, r.status,
  );
  if (res.changes !== 1) throw conflict("concurrent_update", "Vazifa holati boshqa foydalanuvchi tomonidan o'zgartirildi");
  audit(ctx.db, actor, o.auto ? "task.auto_transition" : "task.transition", { type: "task", id: r.id }, { from: r.status, to, reason: o.reason });
  const next = rowOf(ctx, r.id);
  ctx.bus.emit("task.status", { taskId: r.id, departmentId: r.department_id },
    { human: true, audience: audience(ctx, next), from: r.status, to, reason: o.reason ?? null, auto: !!o.auto }, actor.id);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// parent aggregation

interface Kid { id: string; status: TaskStatus; progress: number | null; weight: number; is_optional: number }

export function requiredOpenSubtasks(ctx: Ctx, id: string): number {
  return ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) n FROM tasks WHERE parent_id = ? AND is_optional = 0 AND status NOT IN ('DONE','CANCELLED')", id,
  )!.n;
}

/**
 * Recomputes a parent's progress/stage/status from its required subtasks (optional ones never block completion)
 * and walks up the tree. Runs inside the caller's transaction, reading committed-in-tx state, so concurrent
 * subtask updates (serialised by SQLite) always converge on the same parent state.
 */
function aggregate(ctx: Ctx, parentId: string | null) {
  if (!parentId) return;
  const p = ctx.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", parentId);
  if (!p || p.kind !== "human") return;
  const kids = ctx.db.all<Kid>("SELECT id, status, progress, weight, is_optional FROM tasks WHERE parent_id = ? AND status <> 'CANCELLED'", parentId);
  const req = kids.filter((k) => !k.is_optional);
  if (!req.length) {
    ctx.db.run("UPDATE tasks SET stage = NULL WHERE id = ? AND stage IS NOT NULL", parentId);
    return aggregate(ctx, p.parent_id);
  }
  const value = (k: Kid) => (k.status === "DONE" ? 100 : k.status === "IN_REVIEW" ? 90 : k.progress ?? 0);
  const wsum = req.reduce((s, k) => s + k.weight, 0);
  const progress = Math.round(req.reduce((s, k) => s + k.weight * value(k), 0) / wsum);
  const done = req.filter((k) => k.status === "DONE").length;
  const blocked = req.filter((k) => k.status === "BLOCKED").length;
  const changes = req.filter((k) => k.status === "CHANGES_REQUESTED").length;
  const stage = [`${done}/${req.length} majburiy bajarildi`, blocked ? `${blocked} bloklangan` : "", changes ? `${changes} qayta ishlashda` : ""]
    .filter(Boolean).join(" · ");
  if (!DONE_LIKE.includes(p.status)) ctx.db.run("UPDATE tasks SET progress = ?, stage = ?, updated_at = ? WHERE id = ?", Math.min(progress, 99), stage, now(), parentId);

  let cur = rowOf(ctx, parentId);
  const allDone = done === req.length;
  if (allDone && !DONE_LIKE.includes(cur.status) && cur.status !== "IN_REVIEW") {
    // never just because subtasks were assigned/accepted: every required subtask is DONE (reviewed where required)
    cur = move(ctx, cur, cur.requires_approval ? "IN_REVIEW" : "DONE", SYSTEM, { auto: true, reason: "barcha majburiy kichik vazifalar bajarildi" });
    if (cur.status === "IN_REVIEW") notifyReviewer(ctx, cur);
    else notifyDone(ctx, cur);
  } else if (!allDone) {
    if (cur.status === "IN_REVIEW" || cur.status === "DONE")
      cur = move(ctx, cur, "IN_PROGRESS", SYSTEM, { auto: true, reason: "yangi yoki qayta ochilgan majburiy kichik vazifa" });
    if (blocked && (cur.status === "ACCEPTED" || cur.status === "IN_PROGRESS"))
      cur = move(ctx, cur, "BLOCKED", SYSTEM, { auto: true, reason: `${blocked} ta majburiy kichik vazifa bloklangan` });
    else if (!blocked && cur.status === "BLOCKED")
      cur = move(ctx, cur, "IN_PROGRESS", SYSTEM, { auto: true, reason: "bloklangan kichik vazifalar hal qilindi" });
    else if (cur.status === "ACCEPTED")
      cur = move(ctx, cur, "IN_PROGRESS", SYSTEM, { auto: true, reason: "ish kichik vazifalarga bo'lindi" });
  }
  aggregate(ctx, p.parent_id);
}

function notifyReviewer(ctx: Ctx, r: TaskRow) {
  const to = r.reviewer_user_id ?? r.assigned_by ?? r.created_by;
  if (to && to !== r.assignee_user_id)
    notify(ctx, { userId: to, kind: "review", taskId: r.id, title: `Ko'rib chiqish kerak: ${r.title}`, dedupeKey: `review:${r.id}:${r.submitted_at ?? now()}` });
}
function notifyDone(ctx: Ctx, r: TaskRow) {
  for (const id of new Set([r.assigned_by, r.created_by]))
    if (id && id !== r.assignee_user_id)
      notify(ctx, { userId: id, kind: "completed", taskId: r.id, title: `Bajarildi: ${r.title}`, dedupeKey: `done:${r.id}:${id}` });
}

// ---------------------------------------------------------------------------------------------------------------
// create / edit

export interface WorkInput {
  title: string;
  description?: string;
  assigneeId?: string | null;
  departmentId?: string | null;
  parentId?: string | null;
  priority?: TaskPriority;
  deadline?: string | null;
  estimateHours?: number | null;
  isOptional?: boolean;
  weight?: number;
  /** review before completion; default: yes when assigned to someone else, no for personal tasks */
  requiresReview?: boolean;
  reviewerId?: string | null;
  dependsOn?: string[];
  /** planned start (the due date is `deadline`) */
  startAt?: string | null;
  /** one task per creator and key: a retried request gets the first task back (routes) */
  idempotencyKey?: string;
}

export function createWork(ctx: Ctx, u: AuthUser, input: WorkInput): TaskDto {
  const assigneeId = input.assigneeId === undefined ? u.id : input.assigneeId;
  let parent: TaskRow | null = null;
  if (input.parentId) {
    parent = visibleTask(ctx, u, input.parentId);
    // the parent's owner or the person responsible for it (e.g. a head distributing the director's task)
    if (parent.assignee_user_id !== u.id && !canManageTask(ctx, u, refOf(parent))) throw forbidden();
    if (DONE_LIKE.includes(parent.status)) throw conflict("task_closed", "Yakunlangan vazifaga kichik vazifa qo'shib bo'lmaydi");
  }
  let departmentId = input.departmentId ?? null;
  if (assigneeId) {
    const a = personRef(ctx, assigneeId);
    if (!a) throw notFound("Xodim");
    if (a.status !== "active") throw badRequest("Xodim faol emas — vazifa berib bo'lmaydi");
    const viaParent = parent && parent.assignee_user_id === u.id && a.id === u.id;
    if (!canAssignTo(u, a) && !viaParent) throw forbidden("Bu xodimga vazifa berish huquqingiz yo'q");
    departmentId = a.department_id ?? departmentId;
  } else {
    // unassigned department backlog: only for someone who may assign in that department
    if (!departmentId) throw badRequest("Ijrochi yoki bo'lim tanlang");
    if (!has(u, "tasks:assign_any") && !u.headOf.includes(departmentId) && !u.grants.some((g) => g.permission === "tasks:assign_dept" && g.departmentId === departmentId))
      throw forbidden();
  }
  if (input.reviewerId && !personRef(ctx, input.reviewerId)) throw notFound("Tekshiruvchi");
  const self = assigneeId === u.id;
  const requiresReview = input.requiresReview ?? !self;
  const reviewer = requiresReview ? input.reviewerId ?? (self ? u.managerId : u.id) : null;
  if (requiresReview && !reviewer) throw badRequest("Tekshiruvchi aniqlanmadi — tekshiruvchini tanlang yoki tekshiruvsiz yarating");
  if (requiresReview && reviewer === assigneeId) throw badRequest("Ijrochi o'z ishini o'zi tasdiqlay olmaydi");
  if (input.deadline && Number.isNaN(Date.parse(input.deadline))) throw badRequest("Muddat noto'g'ri");
  const deps = [...new Set(input.dependsOn ?? [])];
  for (const d of deps) visibleTask(ctx, u, d);

  const id = uid("tsk");
  const t = now();
  const status: TaskStatus = !assigneeId ? "BACKLOG" : self ? "ACCEPTED" : "ASSIGNED";
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO tasks (id, kind, title, description, created_by, parent_id, department_id, priority, deadline, status,
         created_at, updated_at, requires_approval, assignee_user_id, assigned_by, reviewer_user_id, estimate_hours, is_optional, weight, accepted_at,
         idempotency_key, start_at)
       VALUES (?, 'human', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.title, input.description ?? "", u.id, parent?.id ?? null, departmentId, input.priority ?? "MEDIUM",
      input.deadline ? new Date(input.deadline).toISOString() : null, status, t, t, requiresReview ? 1 : 0,
      assigneeId, assigneeId ? u.id : null, reviewer, input.estimateHours ?? null, input.isOptional ? 1 : 0, input.weight ?? 1,
      status === "ACCEPTED" ? t : null, input.idempotencyKey ?? null, input.startAt ? new Date(input.startAt).toISOString() : null,
    );
    if (deps.length) {
      assertNoCycle(ctx, id, deps);
      for (const d of deps) ctx.db.run("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)", id, d);
    }
    audit(ctx.db, actorOf(u), "task.create", { type: "task", id }, { title: input.title, assigneeId, parentId: parent?.id ?? null, departmentId });
    const r = rowOf(ctx, id);
    ctx.bus.emit("task.created", { taskId: id, departmentId }, { human: true, audience: audience(ctx, r), status }, u.id);
    if (assigneeId && !self)
      notify(ctx, { userId: assigneeId, kind: "assigned", taskId: id, title: `Yangi vazifa: ${input.title}`, body: `Topshiruvchi: ${u.displayName}`, dedupeKey: `assigned:${id}:${assigneeId}:${t}` });
    aggregate(ctx, parent?.id ?? null);
    checkWorkload(ctx, assigneeId);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export interface WorkPatch {
  title?: string; description?: string; priority?: TaskPriority; deadline?: string | null; estimateHours?: number | null;
  isOptional?: boolean; weight?: number; requiresReview?: boolean; reviewerId?: string | null;
}

export function updateWork(ctx: Ctx, u: AuthUser, id: string, patch: WorkPatch): TaskDto {
  const r = visibleTask(ctx, u, id);
  // the assignee may refine the estimate of their own work; everything else belongs to the task's owner
  const onlyEstimate = Object.keys(patch).every((k) => k === "estimateHours");
  if (!(onlyEstimate && r.assignee_user_id === u.id)) requireManage(ctx, u, r);
  if (DONE_LIKE.includes(r.status)) throw conflict("task_closed", "Yakunlangan vazifani tahrirlab bo'lmaydi");
  if (patch.reviewerId && patch.reviewerId === r.assignee_user_id) throw badRequest("Ijrochi o'z ishini o'zi tasdiqlay olmaydi");
  if (patch.reviewerId && !personRef(ctx, patch.reviewerId)) throw notFound("Tekshiruvchi");
  const map: Record<string, [string, unknown]> = {
    title: ["title", patch.title], description: ["description", patch.description], priority: ["priority", patch.priority],
    deadline: ["deadline", patch.deadline ? new Date(patch.deadline).toISOString() : null],
    estimateHours: ["estimate_hours", patch.estimateHours], isOptional: ["is_optional", patch.isOptional ? 1 : 0],
    weight: ["weight", patch.weight], requiresReview: ["requires_approval", patch.requiresReview ? 1 : 0], reviewerId: ["reviewer_user_id", patch.reviewerId],
  };
  const keys = Object.keys(patch).filter((k) => k in map && (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return toDto(ctx, r);
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE tasks SET ${keys.map((k) => `${map[k][0]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => map[k][1] as string | number | null), now(), id,
    );
    audit(ctx.db, actorOf(u), "task.update", { type: "task", id }, Object.fromEntries(keys.map((k) => [k, (patch as Record<string, unknown>)[k]])));
    signal(ctx, rowOf(ctx, id), u.id, { change: "updated" });
    if (keys.includes("isOptional") || keys.includes("weight")) aggregate(ctx, r.parent_id);
    checkWorkload(ctx, r.assignee_user_id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

/** (Re)assign to a person. Restarts the hand-shake: the new assignee accepts or declines. */
export function assignWork(ctx: Ctx, u: AuthUser, id: string, assigneeId: string): TaskDto {
  const r = visibleTask(ctx, u, id);
  requireManage(ctx, u, r);
  if (DONE_LIKE.includes(r.status) || r.status === "IN_REVIEW") throw conflict("task_closed", "Bu holatda qayta biriktirib bo'lmaydi");
  const a = personRef(ctx, assigneeId);
  if (!a) throw notFound("Xodim");
  if (!canAssignTo(u, a)) throw forbidden("Bu xodimga vazifa berish huquqingiz yo'q");
  if (r.reviewer_user_id === a.id) throw badRequest("Tekshiruvchi o'zi ijrochi bo'la olmaydi");
  const prev = r.assignee_user_id;
  const t = now();
  ctx.db.tx(() => {
    const set = { assignee_user_id: a.id, assigned_by: u.id, department_id: a.department_id ?? r.department_id, decline_reason: null, accepted_at: null };
    const next = r.status === "ASSIGNED"
      ? (() => {
          const res = ctx.db.run(
            "UPDATE tasks SET assignee_user_id = ?, assigned_by = ?, department_id = ?, decline_reason = NULL, updated_at = ? WHERE id = ? AND status = 'ASSIGNED'",
            a.id, u.id, set.department_id, t, id,
          );
          if (res.changes !== 1) throw conflict("concurrent_update", "Vazifa holati boshqa foydalanuvchi tomonidan o'zgartirildi");
          return rowOf(ctx, id);
        })()
      : move(ctx, r, "ASSIGNED", actorOf(u), { reason: "biriktirildi", set });
    audit(ctx.db, actorOf(u), "task.assign", { type: "task", id }, { from: prev, to: a.id });
    notify(ctx, { userId: a.id, kind: "assigned", taskId: id, title: `Yangi vazifa: ${r.title}`, body: `Topshiruvchi: ${u.displayName}`, dedupeKey: `assigned:${id}:${a.id}:${t}` });
    if (prev && prev !== a.id)
      notify(ctx, { userId: prev, kind: "reassigned", taskId: id, title: `Vazifa boshqa xodimga berildi: ${r.title}`, dedupeKey: `reassigned:${id}:${prev}:${t}` });
    signal(ctx, next, u.id, { change: "assigned" });
    aggregate(ctx, r.parent_id);
    checkWorkload(ctx, a.id);
    checkWorkload(ctx, prev);
  });
  return toDto(ctx, rowOf(ctx, id));
}

// ---------------------------------------------------------------------------------------------------------------
// assignee actions

function comment(ctx: Ctx, taskId: string, userId: string | null, kind: string, body: string) {
  ctx.db.run("INSERT INTO task_comments (id, task_id, user_id, kind, body, created_at) VALUES (?,?,?,?,?,?)", uid("cmt"), taskId, userId, kind, body, now());
}

const notifyOwner = (ctx: Ctx, r: TaskRow, kind: string, title: string, key: string) => {
  const to = r.assigned_by ?? r.created_by;
  if (to && to !== r.assignee_user_id) notify(ctx, { userId: to, kind, taskId: r.id, title, dedupeKey: key });
};

export function acceptWork(ctx: Ctx, u: AuthUser, id: string): TaskDto {
  const r = visibleTask(ctx, u, id);
  requireAssignee(u, r);
  ctx.db.tx(() => {
    const n = move(ctx, r, "ACCEPTED", actorOf(u));
    notifyOwner(ctx, n, "accepted", `Qabul qilindi: ${r.title}`, `accepted:${id}:${n.accepted_at}`);
    aggregate(ctx, r.parent_id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export function declineWork(ctx: Ctx, u: AuthUser, id: string, reason: string): TaskDto {
  const r = visibleTask(ctx, u, id);
  requireAssignee(u, r);
  if (!reason.trim()) throw badRequest("Rad etish sababini yozing");
  ctx.db.tx(() => {
    move(ctx, r, "BACKLOG", actorOf(u), { reason, set: { decline_reason: reason.trim(), assignee_user_id: null, accepted_at: null } });
    comment(ctx, id, u.id, "decline", reason.trim());
    notifyOwner(ctx, r, "declined", `Rad etildi: ${r.title}`, `declined:${id}:${u.id}:${now()}`);
    aggregate(ctx, r.parent_id);
    checkWorkload(ctx, u.id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export function startWork(ctx: Ctx, u: AuthUser, id: string): TaskDto {
  const r = visibleTask(ctx, u, id);
  requireAssignee(u, r);
  if (!["ACCEPTED", "CHANGES_REQUESTED", "BLOCKED"].includes(r.status)) throw conflict("invalid_transition", `${r.status} holatidan boshlab bo'lmaydi`);
  const open = ctx.db.get(
    "SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_id WHERE d.task_id = ? AND p.status <> 'DONE' LIMIT 1", id,
  );
  if (open) throw conflict("waiting_dependency", "Avval bog'liq vazifalar bajarilishi kerak");
  ctx.db.tx(() => {
    move(ctx, r, "IN_PROGRESS", actorOf(u));
    aggregate(ctx, r.parent_id);
    checkWorkload(ctx, u.id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export function reportWork(ctx: Ctx, u: AuthUser, id: string, p: { progress?: number; actualHours?: number; note?: string }): TaskDto {
  const r = visibleTask(ctx, u, id);
  requireAssignee(u, r);
  if (r.status !== "IN_PROGRESS") throw conflict("not_running", "Avval ishni boshlang");
  if (p.progress !== undefined && requiredOpenSubtasks(ctx, id) + ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE parent_id = ? AND is_optional = 0 AND status = 'DONE'", id)!.n > 0)
    throw conflict("derived_progress", "Bu vazifaning foizi kichik vazifalardan hisoblanadi");
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE tasks SET progress = COALESCE(?, progress), actual_hours = COALESCE(?, actual_hours), updated_at = ? WHERE id = ? AND status = 'IN_PROGRESS'",
      p.progress ?? null, p.actualHours ?? null, now(), id,
    );
    if (p.note?.trim()) comment(ctx, id, u.id, "progress", p.note.trim());
    ctx.bus.emit("task.progress", { taskId: id, departmentId: r.department_id }, { human: true, audience: audience(ctx, r), progress: p.progress ?? null }, u.id);
    aggregate(ctx, r.parent_id);
    checkWorkload(ctx, u.id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

/** Submit the result: to review when required, otherwise straight to DONE. */
export function submitWork(ctx: Ctx, u: AuthUser, id: string, result: string): TaskDto {
  const r = visibleTask(ctx, u, id);
  requireAssignee(u, r);
  if (requiredOpenSubtasks(ctx, id) > 0) throw conflict("subtasks_open", "Majburiy kichik vazifalar hali bajarilmagan");
  ctx.db.tx(() => {
    const res = result.trim();
    const n = move(ctx, r, r.requires_approval ? "IN_REVIEW" : "DONE", actorOf(u), { set: res ? { result: res } : {} });
    if (res) comment(ctx, id, u.id, "result", res);
    if (n.status === "IN_REVIEW") notifyReviewer(ctx, n);
    else notifyDone(ctx, n);
    aggregate(ctx, r.parent_id);
    checkWorkload(ctx, u.id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export function reviewWork(ctx: Ctx, u: AuthUser, id: string, decision: "APPROVED" | "CHANGES_REQUESTED", text: string): TaskDto {
  const r = visibleTask(ctx, u, id);
  if (r.assignee_user_id === u.id) throw forbidden("O'z ishingizni o'zingiz tasdiqlay olmaysiz");
  if (r.reviewer_user_id !== u.id && !canManageTask(ctx, u, refOf(r))) throw forbidden();
  if (r.status !== "IN_REVIEW") throw conflict("invalid_transition", "Vazifa ko'rib chiqishda emas");
  if (decision === "CHANGES_REQUESTED" && !text.trim()) throw badRequest("Nimani o'zgartirish kerakligini yozing");
  if (decision === "APPROVED" && requiredOpenSubtasks(ctx, id) > 0) throw conflict("subtasks_open", "Majburiy kichik vazifalar hali bajarilmagan");
  ctx.db.tx(() => {
    const n = move(ctx, r, decision === "APPROVED" ? "DONE" : "CHANGES_REQUESTED", actorOf(u), { reason: text.trim() || undefined });
    ctx.db.run("INSERT INTO task_reviews (id, task_id, reviewer_id, decision, comment, created_at) VALUES (?,?,?,?,?,?)", uid("rev"), id, u.id, decision, text.trim(), now());
    if (text.trim()) comment(ctx, id, u.id, "review", text.trim());
    if (r.assignee_user_id)
      notify(ctx, {
        userId: r.assignee_user_id, kind: decision === "APPROVED" ? "approved" : "changes_requested", taskId: id,
        title: decision === "APPROVED" ? `Tasdiqlandi: ${r.title}` : `O'zgartirish so'raldi: ${r.title}`, body: text.trim(),
        dedupeKey: `review-result:${id}:${n.updated_at}`,
      });
    if (n.status === "DONE") notifyDone(ctx, n);
    aggregate(ctx, r.parent_id);
    checkWorkload(ctx, r.assignee_user_id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export function blockWork(ctx: Ctx, u: AuthUser, id: string, reason: string, unblock = false): TaskDto {
  const r = visibleTask(ctx, u, id);
  if (r.assignee_user_id !== u.id) requireManage(ctx, u, r);
  if (!unblock && !reason.trim()) throw badRequest("Bloklanish sababini yozing");
  ctx.db.tx(() => {
    if (unblock) {
      if (r.status !== "BLOCKED") throw conflict("invalid_transition", "Vazifa bloklanmagan");
      move(ctx, r, r.started_at ? "IN_PROGRESS" : "ACCEPTED", actorOf(u), { reason: reason || "blok olindi" });
    } else {
      move(ctx, r, "BLOCKED", actorOf(u), { reason });
      comment(ctx, id, u.id, "comment", `Bloklandi: ${reason.trim()}`);
      notifyOwner(ctx, r, "blocked", `Bloklandi: ${r.title}`, `blocked:${id}:${now()}`);
    }
    aggregate(ctx, r.parent_id);
    checkWorkload(ctx, r.assignee_user_id);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export function cancelWork(ctx: Ctx, u: AuthUser, id: string, reason?: string): TaskDto {
  const r = visibleTask(ctx, u, id);
  requireManage(ctx, u, r);
  const people = new Set<string>();
  ctx.db.tx(() => {
    move(ctx, r, "CANCELLED", actorOf(u), { reason });
    if (r.assignee_user_id) people.add(r.assignee_user_id);
    // open subtasks go with it
    const stack = [id];
    while (stack.length) {
      const pid = stack.pop()!;
      for (const k of ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE parent_id = ? AND status NOT IN ('DONE','CANCELLED')", pid)) {
        move(ctx, k, "CANCELLED", SYSTEM, { auto: true, reason: "asosiy vazifa bekor qilindi" });
        if (k.assignee_user_id) people.add(k.assignee_user_id);
        stack.push(k.id);
      }
    }
    aggregate(ctx, r.parent_id);
    for (const p of people) checkWorkload(ctx, p);
  });
  return toDto(ctx, rowOf(ctx, id));
}

export function addComment(ctx: Ctx, u: AuthUser, id: string, body: string) {
  const r = visibleTask(ctx, u, id);
  if (!body.trim()) throw badRequest("Izoh bo'sh");
  ctx.db.tx(() => {
    comment(ctx, id, u.id, "comment", body.trim());
    signal(ctx, r, u.id, { change: "comment" });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// reads

export interface WorkItem extends TaskDto {
  assigneeName: string | null;
  subtasks: { total: number; done: number; required: number };
  overdue: boolean;
}

function items(ctx: Ctx, u: AuthUser, rows: TaskRow[]): WorkItem[] {
  const names = new Map(ctx.db.all<{ id: string; display_name: string }>("SELECT id, display_name FROM users").map((x) => [x.id, x.display_name]));
  const nowIso = now();
  return rows.map((r) => {
    const c = ctx.db.get<{ total: number; done: number; required: number }>(
      "SELECT COUNT(*) total, SUM(status = 'DONE') done, SUM(is_optional = 0) required FROM tasks WHERE parent_id = ? AND status <> 'CANCELLED'", r.id,
    )!;
    const dto = toDto(ctx, r);
    return {
      ...dto,
      // dependency links name only tasks the viewer may see (ids of hidden work are not revealed)
      dependsOn: visibleTaskIds(ctx, u, dto.dependsOn),
      assigneeName: r.assignee_user_id ? names.get(r.assignee_user_id) ?? null : null,
      subtasks: { total: c.total, done: c.done ?? 0, required: c.required ?? 0 },
      overdue: !!r.deadline && r.deadline < nowIso && !DONE_LIKE.includes(r.status) && r.status !== "IN_REVIEW",
    };
  });
}

export type WorkView = "my" | "team" | "department" | "company" | "review" | "overdue" | "blocked" | "person";

export function listWork(
  ctx: Ctx, u: AuthUser, view: WorkView, f: { departmentId?: string; includeDone?: boolean; q?: string; assigneeId?: string } = {},
): WorkItem[] {
  const vis = visibleTaskSql(u);
  const where = ["t.kind = 'human'", vis.sql];
  const p: (string | number)[] = [...vis.params];
  const open = "t.status NOT IN ('DONE','CANCELLED')";
  switch (view) {
    case "my":
      where.push("t.assignee_user_id = ?");
      p.push(u.id);
      break;
    case "team": {
      // people who report to me (+ my department when I may see the team's work)
      const depts = [...new Set([...u.headOf, ...u.grants.filter((g) => g.permission === "tasks:read_team" && g.departmentId).map((g) => g.departmentId!),
        ...(u.permissions.includes("tasks:read_team") && u.departmentId ? [u.departmentId] : [])])];
      where.push(`(t.assignee_user_id IN (SELECT id FROM users WHERE manager_id = ?)${depts.length ? ` OR t.department_id IN (${depts.map(() => "?").join(",")})` : ""})`);
      p.push(u.id, ...depts);
      break;
    }
    case "department":
      if (f.departmentId) { where.push("t.department_id = ?"); p.push(f.departmentId); }
      else if (u.headOf.length || u.departmentId) {
        const d = u.headOf.length ? u.headOf : [u.departmentId!];
        where.push(`t.department_id IN (${d.map(() => "?").join(",")})`);
        p.push(...d);
      }
      break;
    case "company":
      if (!has(u, "tasks:read_all") && !has(u, "tasks:assign_any")) throw forbidden();
      if (f.departmentId) { where.push("t.department_id = ?"); p.push(f.departmentId); }
      break;
    case "review":
      where.push("t.status = 'IN_REVIEW'", "COALESCE(t.assignee_user_id, '') <> ?");
      p.push(u.id);
      break;
    case "overdue":
      where.push("t.deadline IS NOT NULL AND t.deadline < ?", "t.status NOT IN ('DONE','CANCELLED','IN_REVIEW')");
      p.push(now());
      break;
    case "blocked":
      where.push("t.status = 'BLOCKED'");
      break;
    case "person": // one employee's tasks — still limited to what the viewer may see
      if (!f.assigneeId) throw badRequest("assigneeId kerak");
      break;
  }
  if (!f.includeDone && view !== "review") where.push(open);
  if (f.assigneeId) { where.push("t.assignee_user_id = ?"); p.push(f.assigneeId); }
  if (f.q?.trim()) { where.push("t.title LIKE ?"); p.push(`%${f.q.trim().replace(/[%_]/g, "")}%`); }
  const rows = ctx.db.all<TaskRow>(
    `SELECT t.* FROM tasks t WHERE ${where.join(" AND ")}
     ORDER BY CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END, t.deadline, t.updated_at DESC LIMIT 300`,
    ...p,
  );
  // final guard: list SQL and per-task rules must agree
  return items(ctx, u, rows.filter((r) => canSeeTask(ctx, u, refOf(r))));
}

export function workDetail(ctx: Ctx, u: AuthUser, id: string) {
  const r = visibleTask(ctx, u, id);
  const subs = ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at", id).filter((s) => canSeeTask(ctx, u, refOf(s)));
  const ref = refOf(r);
  const manage = canManageTask(ctx, u, ref);
  const parent = r.parent_id ? ctx.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", r.parent_id) : null;
  return {
    task: items(ctx, u, [r])[0],
    // full parent for those who may see it; otherwise only the context an assignee needs (no comments/files/siblings)
    parent: !parent ? null
      : canSeeTask(ctx, u, refOf(parent)) ? { id: parent.id, title: parent.title, status: parent.status }
      : canSeeParentContext(ctx, u, ref)
        ? {
          id: parent.id, title: parent.title, status: parent.status, contextOnly: true, description: parent.description,
          priority: parent.priority, deadline: parent.deadline, ownerId: parent.assignee_user_id ?? parent.created_by,
        }
        : null,
    subtasks: items(ctx, u, subs),
    comments: ctx.db.all(
      `SELECT c.id, c.kind, c.body, c.created_at createdAt, c.user_id userId, u.display_name userName
       FROM task_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.created_at`, id,
    ),
    reviews: ctx.db.all(
      `SELECT r.id, r.decision, r.comment, r.created_at createdAt, r.reviewer_id reviewerId, u.display_name reviewerName
       FROM task_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.task_id = ? ORDER BY r.created_at`, id,
    ),
    attachments: ctx.db.all(
      `SELECT a.id, a.filename, a.mime, a.size_bytes sizeBytes, a.created_at createdAt, a.user_id userId, u.display_name userName
       FROM task_attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY a.created_at`, id,
    ),
    history: ctx.db.all(
      `SELECT e.id, e.type, e.data, e.created_at at, e.actor, u.display_name actorName FROM task_events e
       LEFT JOIN users u ON u.id = e.actor WHERE e.task_id = ? AND e.type IN ('task.created','task.status') ORDER BY e.id`, id,
    ).map((h) => ({ ...(h as Record<string, unknown>), data: JSON.parse(String((h as { data: string }).data)) })),
    can: {
      manage,
      act: r.assignee_user_id === u.id,
      review: r.status === "IN_REVIEW" && r.assignee_user_id !== u.id && (r.reviewer_user_id === u.id || manage),
      split: !DONE_LIKE.includes(r.status) && (manage || r.assignee_user_id === u.id),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// attachments

const MAX_ATTACHMENT = 10 * 1024 * 1024;

export function addAttachment(ctx: Ctx, u: AuthUser, id: string, f: { filename: string; mime: string; data: Uint8Array }) {
  const r = visibleTask(ctx, u, id);
  if (r.assignee_user_id !== u.id) requireManage(ctx, u, r);
  if (f.data.length > MAX_ATTACHMENT) throw badRequest("Fayl 10 MB dan katta");
  if (!f.data.length) throw badRequest("Fayl bo'sh");
  const name = f.filename.replace(/[\\/\0\r\n"]/g, "_").slice(0, 200) || "fayl";
  const aid = uid("att");
  ctx.db.tx(() => {
    ctx.db.run(
      "INSERT INTO task_attachments (id, task_id, user_id, filename, mime, size_bytes, data, created_at) VALUES (?,?,?,?,?,?,?,?)",
      aid, id, u.id, name, f.mime.slice(0, 100) || "application/octet-stream", f.data.length, f.data, now(),
    );
    audit(ctx.db, actorOf(u), "task.attachment_add", { type: "task", id }, { attachmentId: aid, filename: name, size: f.data.length });
    signal(ctx, r, u.id, { change: "attachment" });
  });
  return { id: aid, filename: name };
}

export function getAttachment(ctx: Ctx, u: AuthUser, taskId: string, attId: string) {
  visibleTask(ctx, u, taskId);
  const a = ctx.db.get<{ filename: string; mime: string; data: Uint8Array }>(
    "SELECT filename, mime, data FROM task_attachments WHERE id = ? AND task_id = ?", attId, taskId,
  );
  if (!a) throw notFound("Fayl");
  return a;
}

/**
 * People's-work execution adapter for the Task Engine (domain/taskEngine.ts): the same guarded moves, parent
 * aggregation, review records and notices the routes above use, so engine transitions keep the legacy flow intact.
 */
export const humanAdapter = { move, aggregate, rowOf, refOf, notifyReviewer, notifyDone, comment, signal };
