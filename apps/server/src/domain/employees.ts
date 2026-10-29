// Human employees: directory, profiles, creation and scoped management, roles, delegated grants, org chart,
// presence for the 3D office. Employees are `users` rows (one account system); AI agents stay separate.
import {
  PERMISSIONS, ROLES, SCOPABLE_PERMISSIONS, type EmployeeCardDto, type EmployeeDto, type EmployeeStatus, type Permission,
  type PresenceDto, type PresenceState, type Role,
} from "@sag/shared";
import { now } from "../db/db.js";
import type { AuthUser } from "../lib/auth.js";
import { audit, type Actor } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { hashPassword } from "../lib/passwords.js";
import { canAssignTo, canManagePerson, canViewPerson, deptsFor, has, isStaffOnly, personRef, rolesOf } from "./access.js";
import type { Ctx } from "./context.js";
import { checkPassword } from "./users.js";
import { computeWorkload } from "./workload.js";

interface UserRow {
  id: string; username: string; display_name: string; email: string | null; job_title: string; department_id: string | null;
  floor_id: string | null; manager_id: string | null; status: EmployeeStatus; start_date: string | null;
  capacity_hours_week: number; work_start: string; work_end: string; timezone: string; last_activity_at: string | null;
  last_login_at: string | null; created_at: string; is_active: number;
}

const actorOf = (u: AuthUser): Actor => ({ type: "user", id: u.id });
const hasAvatar = (ctx: Ctx, id: string) => !!ctx.db.get("SELECT 1 FROM user_avatars WHERE user_id = ?", id);

function row(ctx: Ctx, id: string): UserRow {
  const r = ctx.db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
  if (!r) throw notFound("Xodim");
  return r;
}

function card(ctx: Ctx, r: UserRow): EmployeeCardDto {
  const floor = r.floor_id ?? (r.department_id ? ctx.db.get<{ floor_id: string }>("SELECT floor_id FROM departments WHERE id = ?", r.department_id)?.floor_id ?? null : null);
  return {
    id: r.id, displayName: r.display_name, jobTitle: r.job_title, departmentId: r.department_id, floorId: floor,
    status: r.status, hasAvatar: hasAvatar(ctx, r.id), roles: rolesOf(ctx, r.id), managerId: r.manager_id,
  };
}

function full(ctx: Ctx, u: AuthUser, r: UserRow): EmployeeDto {
  const ref = { id: r.id, department_id: r.department_id, manager_id: r.manager_id, status: r.status };
  const manage = canManagePerson(ctx, u, ref);
  return {
    ...card(ctx, r), username: r.username, email: r.email, startDate: r.start_date,
    capacityHoursWeek: r.capacity_hours_week, workStart: r.work_start, workEnd: r.work_end, timezone: r.timezone,
    lastActivityAt: r.last_activity_at, lastLoginAt: r.last_login_at, createdAt: r.created_at,
    grants: ctx.db.all<{ id: string; permission: Permission; departmentId: string | null; canDelegate: number; grantedBy: string | null }>(
      "SELECT id, permission_id permission, department_id departmentId, can_delegate canDelegate, granted_by grantedBy FROM user_permissions WHERE user_id = ?", r.id,
    ).map((g) => ({ ...g, canDelegate: !!g.canDelegate })),
    workload: computeWorkload(ctx, r.id),
    can: {
      edit: manage || r.id === u.id,
      editOrg: manage,
      changeStatus: manage,
      changeRoles: has(u, "users:manage") && r.id !== u.id,
      grant: r.id !== u.id && (has(u, "permissions:delegate") || has(u, "users:manage") || u.grants.some((g) => g.canDelegate)),
      assignTasks: canAssignTo(u, ref),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// directory & profile

export interface DirectoryFilter {
  q?: string; departmentId?: string; status?: EmployeeStatus | "all"; role?: Role; sort?: "name" | "department" | "workload" | "recent";
}

/** Everyone signed in sees the directory card; full fields (and workload) only where `canViewPerson`. */
export function directory(ctx: Ctx, u: AuthUser, f: DirectoryFilter = {}): (EmployeeCardDto & { workload?: EmployeeDto["workload"]; canView: boolean })[] {
  const where = ["1=1"];
  const p: string[] = [];
  const st = f.status ?? "active";
  if (st !== "all") { where.push("status = ?"); p.push(st); }
  if (f.departmentId) { where.push("department_id = ?"); p.push(f.departmentId); }
  if (f.q?.trim()) {
    where.push("(display_name LIKE ? OR job_title LIKE ? OR username LIKE ?)");
    const q = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    p.push(q, q, q);
  }
  if (f.role) { where.push("id IN (SELECT user_id FROM user_roles WHERE role_id = ?)"); p.push(f.role); }
  // archived / inactive people are history: visible to those who may manage or read everyone
  const rows = ctx.db.all<UserRow>(`SELECT * FROM users WHERE ${where.join(" AND ")} ORDER BY display_name`, ...p).filter((r) => {
    if (r.status === "active") return true;
    return canViewPerson(ctx, u, { id: r.id, department_id: r.department_id, manager_id: r.manager_id, status: r.status });
  });
  const out = rows.map((r) => {
    const view = canViewPerson(ctx, u, { id: r.id, department_id: r.department_id, manager_id: r.manager_id, status: r.status });
    return { ...card(ctx, r), canView: view, ...(view ? { workload: computeWorkload(ctx, r.id) } : {}) };
  });
  const rank = { RED: 0, ORANGE: 1, YELLOW: 2, GREEN: 3 } as const;
  if (f.sort === "department") out.sort((a, b) => (a.departmentId ?? "").localeCompare(b.departmentId ?? "") || a.displayName.localeCompare(b.displayName));
  if (f.sort === "workload") out.sort((a, b) => (a.workload ? rank[a.workload.level] : 9) - (b.workload ? rank[b.workload.level] : 9));
  if (f.sort === "recent") {
    const at = new Map(rows.map((r) => [r.id, r.last_activity_at ?? ""]));
    out.sort((a, b) => (at.get(b.id) ?? "").localeCompare(at.get(a.id) ?? ""));
  }
  return out;
}

export function profile(ctx: Ctx, u: AuthUser, id: string) {
  const r = row(ctx, id);
  const ref = { id: r.id, department_id: r.department_id, manager_id: r.manager_id, status: r.status };
  if (!canViewPerson(ctx, u, ref)) {
    // active colleagues: card only; inactive/archived: hidden (404) to unauthorised users
    if (r.status !== "active") throw notFound("Xodim");
    return { employee: card(ctx, r), full: false as const };
  }
  const activity = ctx.db.all(
    `SELECT id, action, target_type targetType, target_id targetId, actor_id actorId, created_at createdAt FROM audit_logs
     WHERE (actor_type = 'user' AND actor_id = ?) OR (target_type = 'user' AND target_id = ?)
     ORDER BY id DESC LIMIT 40`, id, id,
  );
  return { employee: full(ctx, u, r), full: true as const, activity };
}

// ---------------------------------------------------------------------------------------------------------------
// create / update

export interface EmployeeInput {
  username: string; displayName: string; password: string; email?: string | null; jobTitle?: string;
  departmentId?: string | null; floorId?: string | null; managerId?: string | null; roles?: string[]; startDate?: string | null;
  capacityHoursWeek?: number; workStart?: string; workEnd?: string; timezone?: string;
}

function validRoles(roles: string[]): Role[] {
  const bad = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (bad.length) throw badRequest(`Noma'lum rol: ${bad.join(", ")}`);
  if (!roles.length) throw badRequest("Kamida bitta rol tanlang");
  return [...new Set(roles)] as Role[];
}

function checkRefs(ctx: Ctx, i: { departmentId?: string | null; floorId?: string | null; managerId?: string | null; email?: string | null }, selfId?: string) {
  if (i.departmentId && !ctx.db.get("SELECT 1 FROM departments WHERE id = ?", i.departmentId)) throw notFound("Bo'lim");
  if (i.floorId && !ctx.db.get("SELECT 1 FROM floors WHERE id = ?", i.floorId)) throw notFound("Qavat");
  if (i.managerId) {
    const m = personRef(ctx, i.managerId);
    if (!m) throw notFound("Rahbar");
    if (m.status !== "active") throw badRequest("Rahbar faol emas");
    if (selfId) {
      // reporting lines must stay a tree
      let cur: string | null = i.managerId;
      for (let n = 0; cur && n < 50; n++) {
        if (cur === selfId) throw badRequest("Rahbarlik zanjiri halqa hosil qiladi");
        cur = personRef(ctx, cur)?.manager_id ?? null;
      }
    }
  }
  if (i.email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.email)) throw badRequest("Email noto'g'ri");
    const other = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", i.email.toLowerCase());
    if (other && other.id !== selfId) throw conflict("email_taken", "Bu email band");
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function createEmployee(ctx: Ctx, u: AuthUser, i: EmployeeInput): Promise<EmployeeDto> {
  const roles = validRoles(i.roles?.length ? i.roles : ["employee"]);
  if (!has(u, "employees:manage_all") && !has(u, "users:manage")) {
    // department heads: staff roles only, inside departments they manage
    if (!i.departmentId || !deptsFor(u, "employees:manage_dept").has(i.departmentId)) throw forbidden("Faqat o'z bo'limingizga xodim qo'sha olasiz");
    if (!isStaffOnly(roles)) throw forbidden("Rahbar faqat xodim rolini bera oladi");
  }
  if ((roles.includes("admin") || roles.includes("director")) && !has(u, "users:manage")) throw forbidden("Bu rolni faqat administrator beradi");
  const username = i.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw badRequest("Login 3–32 belgi: lotin harflari, raqam, . _ -");
  if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", username)) throw conflict("username_taken", "Bu login band");
  checkPassword(i.password);
  if (!i.displayName.trim()) throw badRequest("Ism-familiya kerak");
  for (const t of [i.workStart, i.workEnd]) if (t && !TIME.test(t)) throw badRequest("Ish vaqti HH:MM ko'rinishida bo'lsin");
  const email = i.email?.trim().toLowerCase() || null;
  checkRefs(ctx, { ...i, email });
  const hash = await hashPassword(i.password);
  const id = uid("usr");
  const manager = i.managerId ?? (i.departmentId ? ctx.db.get<{ head_user_id: string | null }>("SELECT head_user_id FROM departments WHERE id = ?", i.departmentId)?.head_user_id ?? null : null);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO users (id, username, display_name, password_hash, created_at, created_by, email, job_title, department_id, floor_id,
         manager_id, start_date, capacity_hours_week, work_start, work_end, timezone)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, username, i.displayName.trim(), hash, now(), u.id, email, i.jobTitle?.trim() ?? "", i.departmentId ?? null, i.floorId ?? null,
      manager === id ? null : manager, i.startDate ?? null, i.capacityHoursWeek ?? 40, i.workStart ?? "09:00", i.workEnd ?? "18:00", i.timezone ?? "Asia/Tashkent",
    );
    for (const r of roles) ctx.db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", id, r);
    if (i.departmentId) ctx.db.run("UPDATE users SET desk = ? WHERE id = ?", nextDesk(ctx, i.departmentId, id), id);
    audit(ctx.db, actorOf(u), "employee.create", { type: "user", id }, { username, roles, departmentId: i.departmentId ?? null });
    ctx.bus.emit("employee.updated", { departmentId: i.departmentId ?? null }, { employeeId: id }, u.id);
  });
  return full(ctx, u, row(ctx, id));
}

export interface EmployeePatch {
  displayName?: string; email?: string | null; jobTitle?: string; departmentId?: string | null; floorId?: string | null;
  managerId?: string | null; startDate?: string | null; capacityHoursWeek?: number; workStart?: string; workEnd?: string; timezone?: string;
  telegramUserId?: number | null;
}

/** Self-service fields; everything else needs management rights over the person. */
const SELF_FIELDS = new Set(["displayName", "workStart", "workEnd", "timezone", "telegramUserId"]);
const ORG_FIELDS = new Set(["departmentId", "managerId", "floorId", "jobTitle", "capacityHoursWeek", "startDate", "email"]);

export function updateEmployee(ctx: Ctx, u: AuthUser, id: string, patch: EmployeePatch): EmployeeDto {
  const r = row(ctx, id);
  const ref = { id: r.id, department_id: r.department_id, manager_id: r.manager_id, status: r.status };
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  const manage = canManagePerson(ctx, u, ref);
  if (id === u.id) {
    if (keys.some((k) => !SELF_FIELDS.has(k))) throw forbidden("O'z lavozimingiz, bo'limingiz yoki rahbaringizni o'zgartira olmaysiz");
  } else if (!manage) throw forbidden();
  // a department head may move people only between departments they manage
  if (patch.departmentId !== undefined && !has(u, "employees:manage_all") && id !== u.id) {
    if (!patch.departmentId || !deptsFor(u, "employees:manage_dept").has(patch.departmentId)) throw forbidden("Faqat o'zingiz boshqaradigan bo'limga o'tkaza olasiz");
  }
  for (const t of [patch.workStart, patch.workEnd]) if (t && !TIME.test(t)) throw badRequest("Ish vaqti HH:MM ko'rinishida bo'lsin");
  const email = patch.email === undefined ? undefined : patch.email?.trim().toLowerCase() || null;
  checkRefs(ctx, { ...patch, email }, id);
  const cols: Record<string, string> = {
    displayName: "display_name", email: "email", jobTitle: "job_title", departmentId: "department_id", floorId: "floor_id",
    managerId: "manager_id", startDate: "start_date", capacityHoursWeek: "capacity_hours_week", workStart: "work_start",
    workEnd: "work_end", timezone: "timezone", telegramUserId: "telegram_user_id",
  };
  const vals: Record<string, unknown> = { ...patch, ...(email !== undefined ? { email } : {}) };
  if (!keys.length) return full(ctx, u, r);
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE users SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`,
      ...keys.map((k) => (vals[k] as string | number | null) ?? null), id,
    );
    // moving to another department: a free desk there (the old one is released)
    if (patch.departmentId !== undefined && patch.departmentId !== r.department_id)
      ctx.db.run("UPDATE users SET desk = ? WHERE id = ?", patch.departmentId ? nextDesk(ctx, patch.departmentId, id) : null, id);
    audit(ctx.db, actorOf(u), keys.some((k) => ORG_FIELDS.has(k)) ? "employee.update_org" : "employee.update", { type: "user", id }, vals);
    ctx.bus.emit("employee.updated", { departmentId: (patch.departmentId ?? r.department_id) || null }, { employeeId: id }, u.id);
  });
  return full(ctx, u, row(ctx, id));
}

/** Deactivate / archive / reactivate. Never deletes: task history keeps its attribution. Sessions end at once. */
export function setEmployeeStatus(ctx: Ctx, u: AuthUser, id: string, status: EmployeeStatus): EmployeeDto {
  const r = row(ctx, id);
  if (id === u.id) throw conflict("self_lockout", "O'zingizni faolsizlantira olmaysiz");
  if (!canManagePerson(ctx, u, { id, department_id: r.department_id, manager_id: r.manager_id, status: r.status })) throw forbidden();
  if (status !== "active" && rolesOf(ctx, id).includes("admin")) {
    const others = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM users x JOIN user_roles ur ON ur.user_id = x.id WHERE ur.role_id = 'admin' AND x.status = 'active' AND x.id <> ?", id,
    )!.n;
    if (!others) throw conflict("last_admin", "Kamida bitta faol administrator qolishi kerak");
  }
  ctx.db.tx(() => {
    ctx.db.run("UPDATE users SET status = ?, is_active = ?, desk = NULL WHERE id = ?", status, status === "active" ? 1 : 0, id);
    // reactivated people get a free desk again; leavers free theirs
    if (status === "active" && r.department_id) ctx.db.run("UPDATE users SET desk = ? WHERE id = ?", nextDesk(ctx, r.department_id, id), id);
    if (status !== "active") {
      ctx.db.run("DELETE FROM sessions WHERE user_id = ?", id);
      ctx.db.run("UPDATE departments SET head_user_id = NULL WHERE head_user_id = ?", id);
    }
    audit(ctx.db, actorOf(u), "employee.status", { type: "user", id }, { from: r.status, to: status });
    ctx.bus.emit("employee.updated", { departmentId: r.department_id }, { employeeId: id }, u.id);
  });
  return full(ctx, u, row(ctx, id));
}

/** Roles: administrators only (users:manage); nobody changes their own roles. */
export function setEmployeeRoles(ctx: Ctx, u: AuthUser, id: string, roles: string[]): EmployeeDto {
  if (!has(u, "users:manage")) throw forbidden();
  if (id === u.id) throw forbidden("O'z rolingizni o'zgartira olmaysiz");
  const r = row(ctx, id);
  const next = validRoles(roles);
  const before = rolesOf(ctx, id);
  if (before.includes("admin") && !next.includes("admin")) {
    const others = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM users x JOIN user_roles ur ON ur.user_id = x.id WHERE ur.role_id = 'admin' AND x.status = 'active' AND x.id <> ?", id,
    )!.n;
    if (!others) throw conflict("last_admin", "Kamida bitta faol administrator qolishi kerak");
  }
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM user_roles WHERE user_id = ?", id);
    for (const x of next) ctx.db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", id, x);
    if (!next.includes("department_head")) ctx.db.run("UPDATE departments SET head_user_id = NULL WHERE head_user_id = ?", id);
    audit(ctx.db, actorOf(u), "employee.roles", { type: "user", id }, { from: before, to: next });
    ctx.bus.emit("employee.updated", { departmentId: r.department_id }, { employeeId: id }, u.id);
  });
  return full(ctx, u, row(ctx, id));
}

/**
 * Grant a permission (optionally limited to one department). Administrators and holders of permissions:delegate
 * may grant anything except the admin-only ones; others may pass on only what was delegated to them (can_delegate),
 * never wider than their own scope, never to themselves.
 */
export function grantPermission(ctx: Ctx, u: AuthUser, id: string, g: { permission: string; departmentId?: string | null; canDelegate?: boolean }) {
  if (id === u.id) throw forbidden("O'zingizga ruxsat bera olmaysiz");
  const target = row(ctx, id);
  if (target.status !== "active") throw badRequest("Xodim faol emas");
  if (!(PERMISSIONS as readonly string[]).includes(g.permission)) throw badRequest("Noma'lum ruxsat");
  const perm = g.permission as Permission;
  const dept = g.departmentId ?? null;
  if (dept && !SCOPABLE_PERMISSIONS.includes(perm)) throw badRequest("Bu ruxsatni bo'limga cheklab bo'lmaydi");
  if (dept && !ctx.db.get("SELECT 1 FROM departments WHERE id = ?", dept)) throw notFound("Bo'lim");
  const ADMIN_ONLY: Permission[] = ["users:manage", "employees:manage_all", "permissions:delegate"];
  const admin = has(u, "users:manage");
  if (!admin) {
    if (ADMIN_ONLY.includes(perm)) throw forbidden("Bu ruxsatni faqat administrator beradi");
    if (!has(u, "permissions:delegate")) {
      const mine = u.grants.find((x) => x.permission === perm && x.canDelegate && (x.departmentId === null || x.departmentId === dept));
      if (!mine || (mine.departmentId && mine.departmentId !== dept)) throw forbidden("Sizga bu ruxsatni berish huquqi berilmagan");
      if (!dept && mine.departmentId) throw forbidden("Ruxsat sizning doirangizdan keng bo'la olmaydi");
    }
  }
  const gid = uid("grt");
  ctx.db.tx(() => {
    const r = ctx.db.run(
      "INSERT OR IGNORE INTO user_permissions (id, user_id, permission_id, department_id, can_delegate, granted_by, granted_at) VALUES (?,?,?,?,?,?,?)",
      gid, id, perm, dept, g.canDelegate && (admin || has(u, "permissions:delegate")) ? 1 : 0, u.id, now(),
    );
    if (!r.changes) throw conflict("exists", "Bu ruxsat allaqachon berilgan");
    audit(ctx.db, actorOf(u), "permission.grant", { type: "user", id }, { permission: perm, departmentId: dept, canDelegate: !!g.canDelegate });
  });
  return gid;
}

export function revokePermission(ctx: Ctx, u: AuthUser, id: string, grantId: string) {
  const g = ctx.db.get<{ permission_id: Permission; department_id: string | null; granted_by: string | null }>(
    "SELECT permission_id, department_id, granted_by FROM user_permissions WHERE id = ? AND user_id = ?", grantId, id,
  );
  if (!g) throw notFound("Ruxsat");
  if (!has(u, "users:manage") && !has(u, "permissions:delegate") && g.granted_by !== u.id) throw forbidden();
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM user_permissions WHERE id = ?", grantId);
    audit(ctx.db, actorOf(u), "permission.revoke", { type: "user", id }, { permission: g.permission_id, departmentId: g.department_id });
  });
}

/** Department head: admins and the director (permissions:delegate). The head gets the department_head role. */
export function setDepartmentHead(ctx: Ctx, u: AuthUser, departmentId: string, userId: string | null) {
  if (!has(u, "users:manage") && !has(u, "permissions:delegate")) throw forbidden();
  if (!ctx.db.get("SELECT 1 FROM departments WHERE id = ?", departmentId)) throw notFound("Bo'lim");
  if (userId) {
    const p = personRef(ctx, userId);
    if (!p) throw notFound("Xodim");
    if (p.status !== "active") throw badRequest("Xodim faol emas");
  }
  ctx.db.tx(() => {
    ctx.db.run("UPDATE departments SET head_user_id = ? WHERE id = ?", userId, departmentId);
    if (userId) {
      ctx.db.run("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, 'department_head')", userId);
      ctx.db.run("UPDATE users SET department_id = COALESCE(department_id, ?) WHERE id = ?", departmentId, userId);
      if (!ctx.db.get("SELECT 1 FROM users WHERE id = ? AND desk IS NOT NULL", userId)) {
        const dep = ctx.db.get<{ department_id: string }>("SELECT department_id FROM users WHERE id = ?", userId)!.department_id;
        ctx.db.run("UPDATE users SET desk = ? WHERE id = ?", nextDesk(ctx, dep, userId), userId);
      }
    }
    audit(ctx.db, actorOf(u), "department.head", { type: "department", id: departmentId }, { userId });
    ctx.bus.emit("employee.updated", { departmentId }, { departmentId }, u.id);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// org chart, presence, avatars

export function orgChart(ctx: Ctx, u: AuthUser) {
  if (!has(u, "employees:read_all") && !has(u, "employees:manage_all") && !deptsFor(u, "employees:manage_dept").size) throw forbidden();
  const all = has(u, "employees:read_all") || has(u, "employees:manage_all");
  const scope = deptsFor(u, "employees:manage_dept");
  const people = ctx.db.all<UserRow>("SELECT * FROM users WHERE status = 'active' ORDER BY display_name")
    .filter((r) => all || (r.department_id && scope.has(r.department_id)) || r.id === u.id);
  const departments = ctx.db.all<{ id: string; name: string; color: string; head_user_id: string | null; floor_id: string }>(
    "SELECT id, name, color, head_user_id, floor_id FROM departments WHERE is_active = 1 ORDER BY sort",
  ).filter((d) => all || scope.has(d.id));
  const directors = people.filter((p) => rolesOf(ctx, p.id).includes("director")).map((p) => p.id);
  return {
    directors,
    departments: departments.map((d) => ({
      id: d.id, name: d.name, color: d.color, floorId: d.floor_id, headId: d.head_user_id,
      members: people.filter((p) => p.department_id === d.id).map((p) => p.id),
      agents: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE department_id = ? AND lifecycle <> 'ARCHIVED'", d.id)!.n,
    })),
    people: people.map((p) => ({ ...card(ctx, p), workload: computeWorkload(ctx, p.id).level })),
  };
}

/** Smallest desk number not used by an active colleague of the department. */
export function nextDesk(ctx: Ctx, departmentId: string, exceptUserId = ""): number {
  const used = new Set(
    ctx.db.all<{ desk: number }>(
      "SELECT desk FROM users WHERE department_id = ? AND status = 'active' AND desk IS NOT NULL AND id <> ?", departmentId, exceptUserId,
    ).map((r) => r.desk),
  );
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

const AWAY_MS = 30 * 60_000;

/** What each active employee is doing, from real data only: tasks in progress, reviews waiting, blocks, activity. */
export function presence(ctx: Ctx): PresenceDto[] {
  const rows = ctx.db.all<UserRow>("SELECT * FROM users WHERE status = 'active' AND department_id IS NOT NULL ORDER BY created_at");
  const t = Date.now();
  return rows.map((r) => {
    const desk = (r as UserRow & { desk: number | null }).desk ?? null;
    const st = (s: string) => !!ctx.db.get("SELECT 1 FROM tasks WHERE kind = 'human' AND assignee_user_id = ? AND status = ? LIMIT 1", r.id, s);
    const reviewing = !!ctx.db.get("SELECT 1 FROM tasks WHERE kind = 'human' AND reviewer_user_id = ? AND status = 'IN_REVIEW' LIMIT 1", r.id);
    const seen = r.last_activity_at ? t - Date.parse(r.last_activity_at) : Infinity;
    const state: PresenceState = seen > AWAY_MS ? "away" : st("IN_PROGRESS") ? "working" : reviewing ? "reviewing" : st("BLOCKED") ? "blocked" : "available";
    return { id: r.id, displayName: r.display_name, jobTitle: r.job_title, departmentId: r.department_id!, floorId: card(ctx, r).floorId, state, desk };
  });
}

/** Touch last activity (throttled to once a minute per user). */
export function touchActivity(ctx: Ctx, userId: string) {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  ctx.db.run("UPDATE users SET last_activity_at = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)", now(), userId, cutoff);
}

const SIGS: [string, number[]][] = [["image/png", [0x89, 0x50, 0x4e, 0x47]], ["image/jpeg", [0xff, 0xd8, 0xff]], ["image/webp", [0x52, 0x49, 0x46, 0x46]]];

export function setAvatar(ctx: Ctx, u: AuthUser, id: string, data: Uint8Array) {
  const r = row(ctx, id);
  if (id !== u.id && !canManagePerson(ctx, u, { id, department_id: r.department_id, manager_id: r.manager_id, status: r.status })) throw forbidden();
  if (data.length > 1024 * 1024) throw badRequest("Rasm 1 MB dan katta");
  const mime = SIGS.find(([, sig]) => sig.every((b, i) => data[i] === b))?.[0];
  if (!mime) throw badRequest("Faqat PNG, JPEG yoki WebP rasm");
  ctx.db.run("INSERT INTO user_avatars (user_id, mime, data, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at",
    id, mime, data, now());
  audit(ctx.db, actorOf(u), "employee.avatar", { type: "user", id });
}

export const getAvatar = (ctx: Ctx, id: string) => ctx.db.get<{ mime: string; data: Uint8Array }>("SELECT mime, data FROM user_avatars WHERE user_id = ?", id);
