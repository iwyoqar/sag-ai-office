// Authorisation for people and human work. Every route calls these; the UI only mirrors them.
// Least privilege: department-scoped permissions held through a role apply to the departments the user heads
// (and, for tasks:read_team, their own department); grants can add specific departments.
import type { Permission, Role } from "@sag/shared";
import { loadUser, type AuthUser } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import type { Ctx } from "./context.js";
import { HQ_UNIT } from "./units.js";

export const has = (u: AuthUser, p: Permission) => u.permissions.includes(p);

/** Departments where `u` may use the department-scoped permission `p`. */
export function deptsFor(u: AuthUser, p: Permission): Set<string> {
  const out = new Set<string>();
  if (has(u, p)) {
    for (const d of u.headOf) out.add(d);
    if (p === "tasks:read_team" && u.departmentId) out.add(u.departmentId);
  }
  for (const g of u.grants) if (g.permission === p && g.departmentId) out.add(g.departmentId);
  return out;
}

export const managedDepartments = (u: AuthUser) => [...deptsFor(u, "employees:manage_dept")];

export interface PersonRef {
  id: string;
  department_id: string | null;
  manager_id: string | null;
  status: string;
}

export function rolesOf(ctx: Ctx, userId: string): Role[] {
  return ctx.db.all<{ role_id: Role }>("SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id", userId).map((r) => r.role_id);
}

/** Roles a department head may manage (never other heads, directors or admins). */
const STAFF_ROLES: readonly Role[] = ["employee", "member", "viewer"];
export const isStaffOnly = (roles: Role[]) => roles.every((r) => STAFF_ROLES.includes(r));

export function personRef(ctx: Ctx, id: string): PersonRef | undefined {
  return ctx.db.get<PersonRef>("SELECT id, department_id, manager_id, status FROM users WHERE id = ?", id);
}

/** Edit profile / department / manager / status of `target`. Self-management is never granted through this. */
export function canManagePerson(ctx: Ctx, u: AuthUser, target: PersonRef): boolean {
  if (target.id === u.id) return false;
  if (has(u, "employees:manage_all")) return true;
  if (!target.department_id || !deptsFor(u, "employees:manage_dept").has(target.department_id)) return false;
  return isStaffOnly(rolesOf(ctx, target.id));
}

/** Full profile (tasks, workload, activity, contact). Everyone else gets the directory card only. */
export function canViewPerson(ctx: Ctx, u: AuthUser, target: PersonRef): boolean {
  if (target.id === u.id || has(u, "employees:read_all") || has(u, "employees:manage_all")) return true;
  if (target.manager_id === u.id) return true;
  if (target.department_id && deptsFor(u, "employees:manage_dept").has(target.department_id)) return true;
  return canManagePerson(ctx, u, target);
}

/** May `u` give work to `assignee`? */
export function canAssignTo(u: AuthUser, assignee: PersonRef): boolean {
  if (assignee.status !== "active") return false;
  if (assignee.id === u.id) return true; // personal tasks
  if (has(u, "tasks:assign_any")) return true;
  if (assignee.manager_id === u.id) return true; // direct reports
  return !!assignee.department_id && deptsFor(u, "tasks:assign_dept").has(assignee.department_id);
}

export interface TaskRef {
  id: string;
  kind: string;
  parent_id: string | null;
  department_id: string | null;
  created_by: string | null;
  assigned_by: string | null;
  assignee_user_id: string | null;
  reviewer_user_id: string | null;
  business_unit_id: string;
}

const TASK_REF = "SELECT id, kind, parent_id, department_id, created_by, assigned_by, assignee_user_id, reviewer_user_id, business_unit_id FROM tasks WHERE id = ?";
export const taskRef = (ctx: Ctx, id: string) => ctx.db.get<TaskRef>(TASK_REF, id);

/** Ancestors, nearest first (bounded: parent chains are short and acyclic). */
export function ancestors(ctx: Ctx, t: TaskRef): TaskRef[] {
  const out: TaskRef[] = [];
  let p = t.parent_id;
  while (p && out.length < 20) {
    const r = taskRef(ctx, p);
    if (!r) break;
    out.push(r);
    p = r.parent_id;
  }
  return out;
}

/** An active engine assignment (T1: owner, contributor, reviewer, approver) makes a person part of the task. */
const ACTIVE_ASSIGNMENT = "SELECT 1 FROM task_assignments WHERE task_id = ? AND user_id = ? AND state IN ('ASSIGNED','ACCEPTED') LIMIT 1";
const involved = (u: AuthUser, t: TaskRef, ctx?: Ctx) =>
  t.created_by === u.id || t.assigned_by === u.id || t.assignee_user_id === u.id || t.reviewer_user_id === u.id
  || (!!ctx && !!ctx.db.get(ACTIVE_ASSIGNMENT, t.id, u.id));

/** Owns the work: may edit, split, reassign, review and cancel it. */
export function canManageTask(ctx: Ctx, u: AuthUser, t: TaskRef): boolean {
  if (t.business_unit_id !== HQ_UNIT) return false; // these rules serve HQ's routes; units have their own (domain/units.ts)
  if (has(u, "tasks:assign_any")) return true;
  if (t.created_by === u.id || t.assigned_by === u.id) return true;
  if (t.department_id && deptsFor(u, "tasks:assign_dept").has(t.department_id)) return true;
  // whoever is responsible for a parent task (e.g. the head who received it) owns its subtasks
  return ancestors(ctx, t).some((a) => a.assignee_user_id === u.id || a.created_by === u.id || a.assigned_by === u.id);
}

/**
 * Whole-organisation task reach. Today there is exactly one organisation (it becomes business unit `hq` in W1), so
 * `tasks:read_all` means "every task of this unit" — never cross-unit. W1 replaces this with the unit scope.
 */
export const readsAllTasks = (u: AuthUser) => has(u, "tasks:read_all") || has(u, "tasks:assign_any");

/** Departments whose tasks `u` sees as a department head (or through department-scoped grants). */
export const taskDepartments = (u: AuthUser) =>
  new Set([...deptsFor(u, "tasks:read_team"), ...deptsFor(u, "employees:manage_dept"), ...deptsFor(u, "tasks:assign_dept")]);

/**
 * One rule for AI and human tasks (security model §3.5): unit-wide readers, people involved in the task, heads of
 * its department, and whoever is responsible for an ancestor (a parent's creator sees its subtasks' progress).
 */
export function canSeeTask(ctx: Ctx, u: AuthUser, t: TaskRef): boolean {
  // HQ's task, work and event routes never reach another business unit's work (units: domain/units.ts unitAccess)
  if (t.business_unit_id !== HQ_UNIT) return false;
  if (readsAllTasks(u) || involved(u, t, ctx)) return true;
  if (t.department_id && taskDepartments(u).has(t.department_id)) return true;
  return canManageTask(ctx, u, t);
}

/**
 * The assignee of a subtask needs its parent's context (title, description, priority, deadline, status, owner)
 * even when the parent itself is not theirs to see — but not the parent's comments, files or other subtasks.
 */
export function canSeeParentContext(ctx: Ctx, u: AuthUser, child: TaskRef): boolean {
  return (child.business_unit_id === HQ_UNIT && involved(u, child, ctx)) || canSeeTask(ctx, u, child);
}

/** SQL fragment + params limiting a task query to tasks `u` may see (for list endpoints and stats). */
export function visibleTaskSql(u: AuthUser, alias = "t"): { sql: string; params: string[] } {
  // company-wide (HQ) task lists never include other business units' work
  const hq = `${alias}.business_unit_id = '${HQ_UNIT}'`;
  if (readsAllTasks(u)) return { sql: hq, params: [] };
  const depts = [...taskDepartments(u)];
  const me = u.id;
  const own = `(${alias}.created_by = ? OR ${alias}.assigned_by = ? OR ${alias}.assignee_user_id = ? OR ${alias}.reviewer_user_id = ?)`;
  // descendants of tasks this user is responsible for (recursive, depth-limited by the data)
  const below = `${alias}.id IN (WITH RECURSIVE sub(id) AS (
      SELECT id FROM tasks WHERE assignee_user_id = ? OR created_by = ? OR assigned_by = ?
      UNION SELECT c.id FROM tasks c JOIN sub ON c.parent_id = sub.id) SELECT id FROM sub)`;
  // tasks this person is assigned to through the engine (any role, while the assignment is active)
  const assigned = `${alias}.id IN (SELECT task_id FROM task_assignments WHERE user_id = ? AND state IN ('ASSIGNED','ACCEPTED'))`;
  const parts = [own, below, assigned];
  const params = [me, me, me, me, me, me, me, me];
  if (depts.length) {
    parts.push(`${alias}.department_id IN (${depts.map(() => "?").join(",")})`);
    params.push(...depts);
  }
  return { sql: `(${hq} AND (${parts.join(" OR ")}))`, params };
}

/** Only the ids among `ids` of tasks `u` may see: a hidden task's id, title or existence never reaches a response. */
export function visibleTaskIds(ctx: Ctx, u: AuthUser, ids: string[]): string[] {
  return ids.filter((id) => { const r = taskRef(ctx, id); return !!r && canSeeTask(ctx, u, r); });
}

/**
 * Tasks named in a request (parent, dependencies) must be ones the caller may see — the same 404 as for a task that
 * does not exist, so ids of other people's, other units' or franchises' work can be neither used nor probed.
 */
export function requireVisibleTask(ctx: Ctx, u: AuthUser, id: string): TaskRef {
  const r = taskRef(ctx, id);
  if (!r || !canSeeTask(ctx, u, r)) throw notFound("Vazifa");
  return r;
}

export interface RoutineRef { department_id: string | null; agent_id: string | null; created_by: string | null }

/**
 * Routines (recurring AI work) follow task visibility: unit-wide readers and task managers see every HQ routine;
 * others the ones they created and those of departments whose tasks they see. Routines of other units never.
 */
export function canSeeRoutine(ctx: Ctx, u: AuthUser, r: RoutineRef): boolean {
  const owner = r.agent_id
    ? ctx.db.get<{ dep: string; unit: string }>("SELECT department_id dep, business_unit_id unit FROM agents WHERE id = ?", r.agent_id)
    : r.department_id ? ctx.db.get<{ dep: string; unit: string }>("SELECT id dep, business_unit_id unit FROM departments WHERE id = ?", r.department_id) : undefined;
  if (owner && owner.unit !== HQ_UNIT) return false;
  if (readsAllTasks(u) || has(u, "tasks:manage") || r.created_by === u.id) return true;
  const dep = r.department_id ?? owner?.dep ?? null;
  return !!dep && taskDepartments(u).has(dep);
}

/** Departments whose documents and memory `u` may read besides company-wide items (all of them with brain:manage). */
export function knowledgeDepts(u: AuthUser): Set<string> {
  const s = taskDepartments(u);
  if (u.departmentId) s.add(u.departmentId);
  return s;
}

export const readsDeptKnowledge = (u: AuthUser, departmentId: string) => has(u, "brain:manage") || knowledgeDepts(u).has(departmentId);

/** The person an AI task is done for: the human creator of the task or of its nearest ancestor (null: system work). */
export function requesterOf(ctx: Ctx, taskId: string | null): string | null {
  const t = taskId ? taskRef(ctx, taskId) : undefined;
  if (!t) return null;
  return t.created_by ?? ancestors(ctx, t).find((a) => a.created_by)?.created_by ?? null;
}

/**
 * Department documents and memory an HQ agent may bring into work done for `requesterId`: the agent's department when
 * the requester may read it themselves, otherwise company-wide items only (null). Asking another department's agent
 * never opens that department's private documents. System work (no human requester) keeps the agent's department.
 */
export function agentKnowledgeDept(ctx: Ctx, agentDepartmentId: string, requesterId: string | null): string | null {
  if (!requesterId) return agentDepartmentId;
  const u = loadUser(ctx.db, requesterId);
  return u && readsDeptKnowledge(u, agentDepartmentId) ? agentDepartmentId : null;
}

/** A department-scoped permission that a wider one includes everywhere. */
const WIDER: Partial<Record<Permission, Permission>> = {
  "employees:manage_dept": "employees:manage_all", "tasks:assign_dept": "tasks:assign_any", "tasks:read_team": "tasks:read_all",
};

/**
 * May `u` pass permission `p` on (to `departmentId`, or unscoped when null)? Only what they hold themselves, in at
 * least that scope — delegating never creates rights the delegator does not have.
 */
export function holdsToDelegate(u: AuthUser, p: Permission, departmentId: string | null): boolean {
  const wider = WIDER[p];
  if (wider && has(u, wider)) return true;
  return departmentId ? deptsFor(u, p).has(departmentId) : has(u, p);
}
