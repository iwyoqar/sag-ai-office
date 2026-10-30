// Authorisation for people and human work. Every route calls these; the UI only mirrors them.
// Least privilege: department-scoped permissions held through a role apply to the departments the user heads
// (and, for tasks:read_team, their own department); grants can add specific departments.
import type { Permission, Role } from "@sag/shared";
import type { AuthUser } from "../lib/auth.js";
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

const involved = (u: AuthUser, t: TaskRef) =>
  t.created_by === u.id || t.assigned_by === u.id || t.assignee_user_id === u.id || t.reviewer_user_id === u.id;

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
  if (readsAllTasks(u) || involved(u, t)) return true;
  if (t.department_id && taskDepartments(u).has(t.department_id)) return true;
  return canManageTask(ctx, u, t);
}

/**
 * The assignee of a subtask needs its parent's context (title, description, priority, deadline, status, owner)
 * even when the parent itself is not theirs to see — but not the parent's comments, files or other subtasks.
 */
export function canSeeParentContext(ctx: Ctx, u: AuthUser, child: TaskRef): boolean {
  return (child.business_unit_id === HQ_UNIT && involved(u, child)) || canSeeTask(ctx, u, child);
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
  const parts = [own, below];
  const params = [me, me, me, me, me, me, me];
  if (depts.length) {
    parts.push(`${alias}.department_id IN (${depts.map(() => "?").join(",")})`);
    params.push(...depts);
  }
  return { sql: `(${hq} AND (${parts.join(" OR ")}))`, params };
}
