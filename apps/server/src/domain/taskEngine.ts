// T1 Unified Task Engine (WORK_MANAGEMENT_ROADMAP.md): one task model and one assignment model for people and AI
// agents. The engine validates every business-lifecycle transition (current and target state, actor, required fields,
// version) and every assignment, then hands the execution side to the existing adapters so nothing runs twice:
// - people's tasks (kind = human): domain/work.ts humanAdapter — guarded legacy moves, parent aggregation, notices;
// - AI tasks: domain/tasks.ts — the execution status machine the AI runtime and the HQ AI Director use.
// Lifecycle bookkeeping (status → lifecycle sync, transition log with actor, version bump, legacy assignee mirroring)
// lives in the database triggers of migration 022, so the legacy flows stay consistent too.
import {
  CLOSED_LIFECYCLES, LIFECYCLE_TRANSITIONS, canMoveLifecycle,
  type AssigneeType, type AssignmentRole, type TaskAssignmentDto, type TaskEngineView, type TaskLifecycle, type TaskTransitionDto,
} from "@sag/shared";
import { now } from "../db/db.js";
import type { AuthUser } from "../lib/auth.js";
import { actorTag, audit, type Actor } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { canAssignTo, canManageTask, canSeeTask, deptsFor, has, personRef, taskRef } from "./access.js";
import type { Ctx } from "./context.js";
import { checkWorkload, notify } from "./notifications.js";
import { cancelTask, reassignTask, transitionTask, type TaskRow } from "./tasks.js";
import { humanAdapter as H, requiredOpenSubtasks } from "./work.js";

const ACTIVE = "state IN ('ASSIGNED','ACCEPTED')";
const actorOf = (u: AuthUser): Actor => ({ type: "user", id: u.id });

interface AssignmentRow {
  id: string; task_id: string; business_unit_id: string; assignee_type: AssigneeType; user_id: string | null; agent_id: string | null;
  role: AssignmentRole; state: TaskAssignmentDto["state"]; assigned_by: string | null; assigned_at: string;
  accepted_at: string | null; released_at: string | null; reason: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// loading and authorisation

/** A task the caller may see (any kind, HQ scope as everywhere on these routes); others get 404. */
function load(ctx: Ctx, u: AuthUser, id: string): TaskRow {
  const ref = taskRef(ctx, id);
  if (!ref || !canSeeTask(ctx, u, ref)) throw notFound("Vazifa");
  return ctx.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id)!;
}

const isHuman = (r: TaskRow) => r.kind === "human";

/** Owns the work (people's rules from domain/access.ts; AI work also by tasks:manage, as on /api/tasks). */
function manages(ctx: Ctx, u: AuthUser, r: TaskRow): boolean {
  const ref = taskRef(ctx, r.id)!;
  return canManageTask(ctx, u, ref) || (!isHuman(r) && has(u, "tasks:manage"));
}

const active = (ctx: Ctx, taskId: string) =>
  ctx.db.all<AssignmentRow>(`SELECT * FROM task_assignments WHERE task_id = ? AND ${ACTIVE} ORDER BY assigned_at`, taskId);

function rolesOf(ctx: Ctx, taskId: string, userId: string): Set<AssignmentRole> {
  return new Set(active(ctx, taskId).filter((a) => a.user_id === userId).map((a) => a.role));
}

function checkVersion(r: TaskRow, version: number | undefined) {
  if (version !== undefined && version !== r.version)
    throw conflict("version_conflict", "Vazifa boshqa foydalanuvchi tomonidan o'zgartirildi — sahifani yangilang", { current: r.version });
}

/** Every engine change moves the version on once (triggers already did when a business column changed). */
function bump(ctx: Ctx, id: string, seen: number) {
  ctx.db.run("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?", now(), id, seen);
}

function emit(ctx: Ctx, r: TaskRow, actor: string, change: Record<string, unknown>) {
  // people's work goes to the people involved; AI task events are filtered by task visibility (routes/events.ts)
  const audience = [...new Set([r.created_by, r.assigned_by, ...active(ctx, r.id).map((a) => a.user_id)].filter((x): x is string => !!x))];
  ctx.bus.emit("task.updated", { taskId: r.id, departmentId: r.department_id }, { human: isHuman(r), audience, ...change }, actor);
}

// ---------------------------------------------------------------------------------------------------------------
// assignments

export interface AssignInput { assigneeType: AssigneeType; assigneeId: string; role: AssignmentRole; version?: number }

/**
 * Rules: the task is open and the caller owns it; the assignee exists, is active and belongs to the task's unit
 * (cross-unit work only through an authorised handoff, never a direct assignment); people are assigned only where
 * the caller may give them work (access.ts canAssignTo), agents only within the caller's departments; no duplicate
 * active assignment; an owner never reviews or approves their own task; agents never approve; a person's task is
 * owned by people (agents contribute or review), an AI task is executed by exactly one AI owner and may have
 * accountable human co-owners. A task may have several owners (owner decision 2026-10-31).
 */
export function assign(ctx: Ctx, u: AuthUser, id: string, i: AssignInput): TaskEngineView {
  const r = load(ctx, u, id);
  if (CLOSED_LIFECYCLES.includes(r.lifecycle)) throw conflict("task_closed", "Yakunlangan vazifaga biriktirib bo'lmaydi");
  if (!manages(ctx, u, r)) throw forbidden("Bu vazifaga ijrochi biriktira olmaysiz");
  checkVersion(r, i.version);
  const current = active(ctx, id);
  const dup = current.some((a) => a.role === i.role && (i.assigneeType === "HUMAN" ? a.user_id === i.assigneeId : a.agent_id === i.assigneeId));
  if (dup) throw conflict("duplicate_assignment", "Bu ijrochi shu rolda allaqachon biriktirilgan");

  ctx.db.tx(() => {
    if (i.assigneeType === "HUMAN") {
      const p = ctx.db.get<{ id: string; status: string; home_unit_id: string; department_id: string | null; manager_id: string | null }>(
        "SELECT id, status, home_unit_id, department_id, manager_id FROM users WHERE id = ?", i.assigneeId,
      );
      if (!p) throw notFound("Xodim");
      if (p.status !== "active") throw badRequest("Xodim faol emas — biriktirib bo'lmaydi");
      if (p.home_unit_id !== r.business_unit_id) throw forbidden("Xodim boshqa biznes birlikda — faqat ruxsatli topshirish orqali");
      const owners = current.filter((a) => a.role === "OWNER" && a.user_id === p.id);
      const judges = current.filter((a) => (a.role === "REVIEWER" || a.role === "APPROVER") && a.user_id === p.id);
      if ((i.role === "REVIEWER" || i.role === "APPROVER") && owners.length) throw badRequest("Ijrochi o'z vazifasini tekshira yoki tasdiqlay olmaydi");
      if (i.role === "OWNER" && judges.length) throw badRequest("Tekshiruvchi/tasdiqlovchi bir vaqtda ijrochi bo'la olmaydi");
      if ((i.role === "OWNER" || i.role === "CONTRIBUTOR") && !canAssignTo(u, personRef(ctx, p.id)!))
        throw forbidden("Bu xodimga ish berish huquqingiz yo'q");
      if (i.role === "OWNER" && isHuman(r) && !r.assignee_user_id) {
        // the first owner of a person's task is its legacy assignee: the handshake (ASSIGNED → accepted) stays as before
        if (r.status === "BACKLOG")
          H.move(ctx, H.rowOf(ctx, id), "ASSIGNED", actorOf(u), { set: { assignee_user_id: p.id, assigned_by: u.id, accepted_at: null, decline_reason: null } });
        else ctx.db.run("UPDATE tasks SET assignee_user_id = ?, assigned_by = ?, updated_at = ? WHERE id = ?", p.id, u.id, now(), id);
      } else insertAssignment(ctx, r, i, u);
      if (i.role === "OWNER" || i.role === "CONTRIBUTOR")
        notify(ctx, { userId: p.id, kind: "assigned", taskId: id, title: `Yangi vazifa: ${r.title}`, body: `Topshiruvchi: ${u.displayName}`, dedupeKey: `assigned:${id}:${p.id}:${i.role}:${now()}` });
      if (i.role === "REVIEWER" || i.role === "APPROVER")
        notify(ctx, { userId: p.id, kind: "review", taskId: id, title: `${i.role === "APPROVER" ? "Tasdiqlovchi" : "Tekshiruvchi"} etib belgilandingiz: ${r.title}`, dedupeKey: `judge:${id}:${p.id}:${i.role}:${now()}` });
      checkWorkload(ctx, p.id);
    } else {
      if (i.role === "APPROVER") throw badRequest("AI agent tasdiqlovchi bo'la olmaydi — yakuniy tasdiq inson tomonidan");
      if (!has(u, "ai_tasks:create")) throw forbidden("AI agentlarga ish berish huquqingiz yo'q");
      const a = ctx.db.get<{ id: string; lifecycle: string; business_unit_id: string; department_id: string }>(
        "SELECT id, lifecycle, business_unit_id, department_id FROM agents WHERE id = ?", i.assigneeId,
      );
      if (!a) throw notFound("Agent");
      if (a.lifecycle !== "ACTIVE") throw badRequest("Agent faol emas — biriktirib bo'lmaydi");
      if (a.business_unit_id !== r.business_unit_id) throw forbidden("Agent boshqa biznes birlikda — faqat ruxsatli topshirish orqali");
      if (!has(u, "tasks:manage") && !has(u, "tasks:assign_any") && !deptsFor(u, "tasks:assign_dept").has(a.department_id))
        throw forbidden("Bu bo'lim agentiga ish berish huquqingiz yo'q");
      if (i.role === "OWNER") {
        if (isHuman(r)) throw badRequest("Xodim vazifasining ijrochisi inson bo'ladi — agentni yordamchi yoki tekshiruvchi qiling");
        // an AI task is executed by one agent: the first owner is set through the AI runtime's own reassignment
        if (r.agent_id) throw conflict("ai_owner_exists", "AI vazifaning bajaruvchi agenti bor — almashtirish uchun qayta biriktiring");
        reassignTask(ctx, id, a.id, actorOf(u));
      } else insertAssignment(ctx, r, i, u);
    }
    bump(ctx, id, r.version);
    audit(ctx.db, actorOf(u), "task.assign", { type: "task", id }, { assigneeType: i.assigneeType, assigneeId: i.assigneeId, role: i.role });
    emit(ctx, r, u.id, { change: "assignment" });
  });
  return view(ctx, u, id);
}

function insertAssignment(ctx: Ctx, r: TaskRow, i: AssignInput, u: AuthUser) {
  try {
    ctx.db.run(
      `INSERT INTO task_assignments (id, task_id, business_unit_id, assignee_type, user_id, agent_id, role, state, assigned_by, assigned_at, accepted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      uid("asg"), r.id, r.business_unit_id, i.assigneeType, i.assigneeType === "HUMAN" ? i.assigneeId : null,
      i.assigneeType === "AI_AGENT" ? i.assigneeId : null, i.role, i.assigneeType === "AI_AGENT" ? "ACCEPTED" : "ASSIGNED",
      u.id, now(), i.assigneeType === "AI_AGENT" ? now() : null,
    );
  } catch (e) {
    if (/UNIQUE/.test((e as Error).message)) throw conflict("duplicate_assignment", "Bu ijrochi shu rolda allaqachon biriktirilgan");
    if (/cross_unit/.test((e as Error).message)) throw forbidden("Ijrochi boshqa biznes birlikda");
    throw e;
  }
}

function assignmentOf(ctx: Ctx, taskId: string, assignmentId: string): AssignmentRow {
  const a = ctx.db.get<AssignmentRow>("SELECT * FROM task_assignments WHERE id = ? AND task_id = ?", assignmentId, taskId);
  if (!a) throw notFound("Biriktirish");
  return a;
}

/** Take someone off a task (the owner of the work decides). The executing AI agent is replaced, not released. */
export function release(ctx: Ctx, u: AuthUser, id: string, assignmentId: string, o: { reason?: string; version?: number } = {}): TaskEngineView {
  const r = load(ctx, u, id);
  if (!manages(ctx, u, r)) throw forbidden();
  checkVersion(r, o.version);
  const a = assignmentOf(ctx, id, assignmentId);
  if (a.state !== "ASSIGNED" && a.state !== "ACCEPTED") throw conflict("assignment_closed", "Bu biriktirish allaqachon yopilgan");
  ctx.db.tx(() => {
    if (a.assignee_type === "AI_AGENT" && a.role === "OWNER" && a.agent_id === r.agent_id)
      throw conflict("ai_owner_required", "Bajaruvchi agentni olib tashlab bo'lmaydi — boshqa agentga qayta biriktiring yoki bekor qiling");
    if (a.role === "OWNER" && a.user_id && a.user_id === r.assignee_user_id) {
      // the legacy assignee: hand the work to another active human owner, or back to the backlog before anyone started
      const next = active(ctx, id).find((x) => x.role === "OWNER" && x.user_id && x.user_id !== a.user_id);
      if (next) ctx.db.run("UPDATE tasks SET assignee_user_id = ?, accepted_at = ?, updated_at = ? WHERE id = ?", next.user_id, next.accepted_at, now(), id);
      else if (r.status === "ASSIGNED")
        H.move(ctx, H.rowOf(ctx, id), "BACKLOG", actorOf(u), { reason: o.reason, set: { assignee_user_id: null, accepted_at: null } });
      else throw conflict("owner_required", "Ish boshlangan — yagona ijrochini olib tashlash o'rniga boshqasiga qayta biriktiring");
    } else if (a.role === "REVIEWER" && a.user_id && a.user_id === r.reviewer_user_id) {
      ctx.db.run("UPDATE tasks SET reviewer_user_id = NULL, updated_at = ? WHERE id = ?", now(), id);
    }
    ctx.db.run(`UPDATE task_assignments SET state = 'RELEASED', released_at = ?, reason = ? WHERE id = ? AND ${ACTIVE}`, now(), o.reason ?? null, a.id);
    bump(ctx, id, r.version);
    audit(ctx.db, actorOf(u), "task.unassign", { type: "task", id }, { assignmentId: a.id, role: a.role, reason: o.reason });
    emit(ctx, r, u.id, { change: "assignment" });
  });
  return view(ctx, u, id);
}

/** The assignee's answer to an assignment: accept, or decline with a reason. */
export function respond(ctx: Ctx, u: AuthUser, id: string, assignmentId: string, accept: boolean, reason?: string): TaskEngineView {
  const r = load(ctx, u, id);
  const a = assignmentOf(ctx, id, assignmentId);
  if (a.assignee_type !== "HUMAN" || a.user_id !== u.id) throw forbidden("Bu biriktirish sizga tegishli emas");
  if (a.state !== "ASSIGNED") throw conflict("assignment_closed", accept ? "Allaqachon qabul qilingan yoki yopilgan" : "Bu biriktirish allaqachon yopilgan");
  if (!accept && !reason?.trim()) throw badRequest("Rad etish sababini yozing");
  ctx.db.tx(() => {
    const legacyOwner = a.role === "OWNER" && isHuman(r) && r.assignee_user_id === u.id && r.status === "ASSIGNED";
    if (legacyOwner && accept) H.move(ctx, H.rowOf(ctx, id), "ACCEPTED", actorOf(u));
    else if (legacyOwner) {
      H.move(ctx, H.rowOf(ctx, id), "BACKLOG", actorOf(u), { reason, set: { decline_reason: reason!.trim(), assignee_user_id: null, accepted_at: null } });
      const back = r.assigned_by ?? r.created_by;
      if (back && back !== u.id)
        notify(ctx, { userId: back, kind: "declined", taskId: id, title: `Rad etildi: ${r.title}`, body: reason, dedupeKey: `declined:${id}:${u.id}:${now()}` });
    }
    ctx.db.run(
      `UPDATE task_assignments SET state = ?, accepted_at = CASE WHEN ? THEN ? ELSE accepted_at END,
         released_at = CASE WHEN ? THEN NULL ELSE ? END, reason = ? WHERE id = ? AND state = 'ASSIGNED'`,
      accept ? "ACCEPTED" : "DECLINED", accept ? 1 : 0, now(), accept ? 1 : 0, now(), accept ? null : reason!.trim(), a.id,
    );
    if (legacyOwner) H.aggregate(ctx, r.parent_id);
    bump(ctx, id, r.version);
    audit(ctx.db, actorOf(u), accept ? "task.assignment_accept" : "task.assignment_decline", { type: "task", id }, { assignmentId: a.id, reason });
    emit(ctx, r, u.id, { change: "assignment" });
  });
  return view(ctx, u, id);
}

// ---------------------------------------------------------------------------------------------------------------
// lifecycle

export interface TransitionInput { to: TaskLifecycle; reason?: string; version?: number }

/** Lifecycle-only change (PLANNED, APPROVED, …): no legacy status moves; the triggers log it and bump the version. */
function setLifecycle(ctx: Ctx, r: TaskRow, to: TaskLifecycle, actor: Actor, extra: { blockedReason?: string | null } = {}) {
  const res = ctx.db.run(
    "UPDATE tasks SET lifecycle = ?, last_actor = ?, updated_at = ?, blocked_reason = COALESCE(?, blocked_reason) WHERE id = ? AND lifecycle = ?",
    to, actorTag(actor), now(), extra.blockedReason ?? null, r.id, r.lifecycle,
  );
  if (res.changes !== 1) throw conflict("concurrent_update", "Vazifa holati boshqa foydalanuvchi tomonidan o'zgartirildi");
}

const depsOpen = (ctx: Ctx, id: string) =>
  !!ctx.db.get("SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_id WHERE d.task_id = ? AND p.status <> 'DONE' LIMIT 1", id);

/**
 * Who may request each transition, and what it needs. Throws (403 / 409 / 400) when not allowed; returns the plan
 * the caller then executes. Kept free of side effects so the screen can ask "what may I do now?" (view.can).
 */
function authorise(ctx: Ctx, u: AuthUser, r: TaskRow, to: TaskLifecycle, reason: string | undefined) {
  const from = r.lifecycle;
  if (!canMoveLifecycle(from, to))
    throw conflict("invalid_transition", `${from} → ${to} o'tishi mumkin emas`, { from, to, allowed: LIFECYCLE_TRANSITIONS[from] });
  const manager = manages(ctx, u, r);
  const roles = rolesOf(ctx, r.id, u.id);
  const owner = roles.has("OWNER");
  const judge = roles.has("REVIEWER") || roles.has("APPROVER");
  const need = (ok: boolean, why = "Bu amalga huquqingiz yo'q") => { if (!ok) throw forbidden(why); };
  if ((to === "BLOCKED" || to === "REVISION") && !reason?.trim()) throw badRequest("Sababni yozing");

  if (!isHuman(r)) {
    // AI tasks: people plan, queue, block and cancel; the AI runtime starts, submits and finishes them (review: T3)
    if (["IN_PROGRESS", "IN_REVIEW", "COMPLETED", "APPROVED", "REVISION"].includes(to))
      throw conflict("ai_execution", "Bu holatni AI ijro tizimi o'zgartiradi (ko'rib chiqish oqimi T3 bosqichida)");
    if (to === "BLOCKED") need(manager || owner);
    else need(manager);
    // the execution status machine (shared TASK_TRANSITIONS) decides what each request can reach
    if (to === "BLOCKED" && !["IN_PROGRESS", "WAITING_FOR_DEPENDENCY"].includes(r.status))
      throw conflict("invalid_transition", "Faqat bajarilayotgan yoki kutayotgan AI vazifani bloklash mumkin");
    if ((to === "PLANNED" || to === "BACKLOG") && !["BACKLOG", "QUEUED"].includes(r.status))
      throw conflict("invalid_transition", "AI vazifa navbatdan chiqqan — avval bekor qiling yoki kuting");
    if (to === "ASSIGNED") {
      if (!r.agent_id) throw conflict("no_owner", "Avval bajaruvchi AI agentni biriktiring");
      need(has(u, "ai_tasks:create"), "AI agentlarga ish berish huquqingiz yo'q");
    }
    return;
  }

  // people's tasks
  const owners = active(ctx, r.id).filter((a) => a.role === "OWNER");
  switch (to) {
    case "PLANNED": case "BACKLOG":
      need(manager);
      if (to === "BACKLOG" && owners.length) throw conflict("owners_assigned", "Avval ijrochilarni olib tashlang");
      return;
    case "ASSIGNED":
      need(manager);
      if (!owners.length) throw conflict("no_owner", "Avval ijrochi (OWNER) biriktiring");
      return;
    case "IN_PROGRESS":
      need(owner || (from === "BLOCKED" && manager), "Ishni ijrochi boshlaydi");
      if (depsOpen(ctx, r.id)) throw conflict("waiting_dependency", "Oldingi bog'liq vazifalar hali bajarilmagan");
      return;
    case "BLOCKED":
      need(owner || manager);
      if (r.status === "ASSIGNED") throw conflict("not_accepted", "Avval vazifani qabul qiling");
      return;
    case "IN_REVIEW":
      need(owner, "Natijani ijrochi topshiradi");
      if (!r.requires_approval) throw conflict("review_not_required", "Bu vazifa tekshiruvsiz — to'g'ridan-to'g'ri yakunlang");
      if (requiredOpenSubtasks(ctx, r.id) > 0) throw conflict("subtasks_open", "Majburiy kichik vazifalar hali bajarilmagan");
      return;
    case "APPROVED": {
      need(!owner, "Ijrochi o'z ishini tasdiqlay olmaydi");
      // final approval by the assigned approver when there is one, otherwise a reviewer or the owner of the work
      const approvers = active(ctx, r.id).filter((a) => a.role === "APPROVER");
      need(approvers.length ? roles.has("APPROVER") : judge || manager, "Tasdiqlash huquqi tasdiqlovchida");
      if (requiredOpenSubtasks(ctx, r.id) > 0) throw conflict("subtasks_open", "Majburiy kichik vazifalar hali bajarilmagan");
      return;
    }
    case "REVISION":
      need(!owner, "Ijrochi o'z ishini qaytara olmaydi");
      need(judge || manager);
      return;
    case "COMPLETED":
      if (from === "IN_PROGRESS") {
        need(owner, "Natijani ijrochi topshiradi");
        if (r.requires_approval) throw conflict("review_required", "Bu vazifa tekshiruvdan o'tishi kerak — tekshiruvga topshiring");
      } else need(owner || judge || manager); // after approval
      if (requiredOpenSubtasks(ctx, r.id) > 0) throw conflict("subtasks_open", "Majburiy kichik vazifalar hali bajarilmagan");
      return;
    case "CANCELLED":
      need(manager);
      return;
  }
}

/**
 * Move a task to another lifecycle state. Validates, then executes through the adapter of its kind; the triggers
 * keep lifecycle, log and version consistent. `version` (optional) refuses a stale screen with 409.
 */
export function transition(ctx: Ctx, u: AuthUser, id: string, i: TransitionInput): TaskEngineView {
  const r = load(ctx, u, id);
  checkVersion(r, i.version);
  authorise(ctx, u, r, i.to, i.reason);
  const actor = actorOf(u);
  const reason = i.reason?.trim() || undefined;
  ctx.db.tx(() => {
    if (isHuman(r)) moveHuman(ctx, u, r, i.to, reason);
    else moveAi(ctx, r, i.to, actor, reason);
    if (i.to !== "BLOCKED" && r.blocked_reason) ctx.db.run("UPDATE tasks SET blocked_reason = NULL WHERE id = ?", id);
    bump(ctx, id, r.version);
    audit(ctx.db, actor, "task.lifecycle", { type: "task", id }, { from: r.lifecycle, to: i.to, reason });
    emit(ctx, r, u.id, { change: "lifecycle", from: r.lifecycle, to: i.to });
  });
  return view(ctx, u, id);
}

function moveHuman(ctx: Ctx, u: AuthUser, r: TaskRow, to: TaskLifecycle, reason?: string) {
  const actor = actorOf(u);
  let cur = H.rowOf(ctx, r.id);
  const go = (s: Parameters<typeof H.move>[2], set: Record<string, string | number | null> = {}) => { cur = H.move(ctx, cur, s, actor, { reason, set }); };
  switch (to) {
    case "PLANNED":
    case "BACKLOG":
      if (cur.status === "BACKLOG") setLifecycle(ctx, cur, to, actor);
      else go("BACKLOG", { assignee_user_id: null, accepted_at: null });
      break;
    case "ASSIGNED":
      if (!cur.assignee_user_id) {
        const first = active(ctx, r.id).find((a) => a.role === "OWNER" && a.user_id)!;
        ctx.db.run("UPDATE tasks SET assignee_user_id = ?, assigned_by = ?, updated_at = ? WHERE id = ?", first.user_id, u.id, now(), r.id);
        cur = H.rowOf(ctx, r.id);
      }
      if (cur.status === "BACKLOG" || cur.status === "BLOCKED") go("ASSIGNED");
      else setLifecycle(ctx, cur, "ASSIGNED", actor);
      break;
    case "IN_PROGRESS":
      if (cur.status === "ASSIGNED") go("ACCEPTED");
      go("IN_PROGRESS");
      // starting the work accepts the starter's own assignment
      ctx.db.run(`UPDATE task_assignments SET state = 'ACCEPTED', accepted_at = ? WHERE task_id = ? AND user_id = ? AND role = 'OWNER' AND state = 'ASSIGNED'`, now(), r.id, u.id);
      break;
    case "BLOCKED":
      go("BLOCKED", { blocked_reason: reason ?? null });
      break;
    case "IN_REVIEW":
      go("IN_REVIEW");
      H.notifyReviewer(ctx, cur);
      break;
    case "APPROVED":
      ctx.db.run("INSERT INTO task_reviews (id, task_id, reviewer_id, decision, comment, created_at) VALUES (?,?,?,?,?,?)", uid("rev"), r.id, u.id, "APPROVED", reason ?? "", now());
      setLifecycle(ctx, cur, "APPROVED", actor);
      break;
    case "REVISION":
      go("CHANGES_REQUESTED");
      ctx.db.run("INSERT INTO task_reviews (id, task_id, reviewer_id, decision, comment, created_at) VALUES (?,?,?,?,?,?)", uid("rev"), r.id, u.id, "CHANGES_REQUESTED", reason ?? "", now());
      if (reason) H.comment(ctx, r.id, u.id, "review", reason);
      for (const a of active(ctx, r.id).filter((x) => x.role === "OWNER" && x.user_id))
        notify(ctx, { userId: a.user_id!, kind: "changes_requested", taskId: r.id, title: `O'zgartirish so'raldi: ${r.title}`, body: reason, dedupeKey: `review-result:${r.id}:${a.user_id}:${now()}` });
      break;
    case "COMPLETED":
      go("DONE");
      H.notifyDone(ctx, cur);
      break;
    case "CANCELLED": {
      go("CANCELLED");
      for (const k of ctx.db.all<{ id: string }>("SELECT id FROM tasks WHERE parent_id = ? AND status NOT IN ('DONE','CANCELLED')", r.id))
        H.move(ctx, H.rowOf(ctx, k.id), "CANCELLED", { type: "system", id: null }, { auto: true, reason: "asosiy vazifa bekor qilindi" });
      break;
    }
  }
  H.aggregate(ctx, r.parent_id);
  for (const a of active(ctx, r.id)) if (a.user_id && a.role === "OWNER") checkWorkload(ctx, a.user_id);
}

function moveAi(ctx: Ctx, r: TaskRow, to: TaskLifecycle, actor: Actor, reason?: string) {
  switch (to) {
    case "PLANNED":
    case "BACKLOG":
      if (r.status === "BACKLOG") setLifecycle(ctx, r, to, actor);
      else transitionTask(ctx, r.id, "BACKLOG", actor, { reason });
      break;
    case "ASSIGNED":
      // queued for its agent; it waits for prerequisites first when they are still open
      transitionTask(ctx, r.id, "QUEUED", actor, { reason });
      if (depsOpen(ctx, r.id)) transitionTask(ctx, r.id, "WAITING_FOR_DEPENDENCY", actor, { reason: "bog'liq vazifalar kutilmoqda" });
      break;
    case "BLOCKED":
      transitionTask(ctx, r.id, "BLOCKED", actor, { reason });
      ctx.db.run("UPDATE tasks SET blocked_reason = ? WHERE id = ?", reason ?? null, r.id);
      break;
    case "CANCELLED":
      cancelTask(ctx, r.id, actor, reason);
      break;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// read

const nameOf = (ctx: Ctx, type: "user" | "agent", id: string) =>
  type === "user"
    ? ctx.db.get<{ n: string }>("SELECT display_name n FROM users WHERE id = ?", id)?.n ?? null
    : ctx.db.get<{ n: string }>("SELECT name n FROM agents WHERE id = ?", id)?.n ?? null;

function assignmentDto(ctx: Ctx, a: AssignmentRow): TaskAssignmentDto {
  const id = (a.user_id ?? a.agent_id)!;
  return {
    id: a.id, taskId: a.task_id, assigneeType: a.assignee_type, assigneeId: id,
    assigneeName: nameOf(ctx, a.assignee_type === "HUMAN" ? "user" : "agent", id), role: a.role, state: a.state,
    assignedBy: a.assigned_by, assignedAt: a.assigned_at, acceptedAt: a.accepted_at, releasedAt: a.released_at, reason: a.reason,
  };
}

/** The task as the engine sees it, with what this viewer may do now (server-computed; the UI only mirrors it). */
export function view(ctx: Ctx, u: AuthUser, id: string): TaskEngineView {
  const r = load(ctx, u, id);
  const assignments = ctx.db
    .all<AssignmentRow>("SELECT * FROM task_assignments WHERE task_id = ? ORDER BY CASE WHEN state IN ('ASSIGNED','ACCEPTED') THEN 0 ELSE 1 END, assigned_at", id)
    .map((a) => assignmentDto(ctx, a));
  const transitions: TaskTransitionDto[] = ctx.db
    .all<{ id: number; from_lifecycle: TaskLifecycle | null; to_lifecycle: TaskLifecycle; status: string; actor: string; reason: string | null; at: string }>(
      "SELECT id, from_lifecycle, to_lifecycle, status, actor, reason, at FROM task_transitions WHERE task_id = ? ORDER BY id DESC LIMIT 30", id,
    )
    .map((t) => {
      const [type, who] = t.actor.split(":");
      return {
        id: t.id, from: t.from_lifecycle, to: t.to_lifecycle, status: t.status, actor: t.actor,
        actorName: who && (type === "user" || type === "agent") ? nameOf(ctx, type, who) : null, reason: t.reason, at: t.at,
      };
    });
  const manage = manages(ctx, u, r);
  const allowed = LIFECYCLE_TRANSITIONS[r.lifecycle].filter((to) => {
    try { authorise(ctx, u, r, to, "?"); return true; } catch { return false; }
  });
  return {
    task: {
      id: r.id, title: r.title, kind: r.kind, lifecycle: r.lifecycle, status: r.status, priority: r.priority, version: r.version,
      startAt: r.start_at, dueAt: r.deadline, completedAt: r.completed_at, businessUnitId: r.business_unit_id,
      departmentId: r.department_id, blockedReason: r.blocked_reason, requiresApproval: !!r.requires_approval,
    },
    assignments, transitions,
    can: { manage, assign: manage && !CLOSED_LIFECYCLES.includes(r.lifecycle), transitions: allowed },
  };
}
