// Users & roles management (admin). Guards: never leave the system without an active admin;
// deactivation and password reset end the user's sessions.
import { ROLES, type Role } from "@sag/shared";
import { now } from "../db/db.js";
import { type Actor, audit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import type { Ctx } from "./context.js";

export interface UserAdminDto {
  id: string; username: string; displayName: string; roles: Role[]; isActive: boolean;
  createdAt: string; lastLoginAt: string | null;
}

export const MIN_PASSWORD = 10;

export function checkPassword(pw: string) {
  if (pw.length < MIN_PASSWORD) throw badRequest(`Parol kamida ${MIN_PASSWORD} belgidan iborat bo'lsin`);
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password|parol)/i.test(pw)) throw badRequest("Parol juda oddiy");
}

function rolesOf(ctx: Ctx, userId: string): Role[] {
  return ctx.db.all<{ role_id: Role }>("SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id", userId).map((r) => r.role_id);
}

export function listUsers(ctx: Ctx): UserAdminDto[] {
  return ctx.db
    .all<{ id: string; username: string; display_name: string; is_active: number; created_at: string; last_login_at: string | null }>(
      "SELECT id, username, display_name, is_active, created_at, last_login_at FROM users ORDER BY created_at",
    )
    .map((u) => ({
      id: u.id, username: u.username, displayName: u.display_name, roles: rolesOf(ctx, u.id), isActive: !!u.is_active,
      createdAt: u.created_at, lastLoginAt: u.last_login_at,
    }));
}

const getUser = (ctx: Ctx, id: string) => {
  const u = listUsers(ctx).find((x) => x.id === id);
  if (!u) throw notFound("Foydalanuvchi");
  return u;
};

function activeAdmins(ctx: Ctx, exceptUserId?: string): number {
  return ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM users u JOIN user_roles r ON r.user_id = u.id
     WHERE r.role_id = 'admin' AND u.is_active = 1 AND u.id <> ?`,
    exceptUserId ?? "",
  )!.n;
}

function validRoles(roles: string[]): Role[] {
  if (!roles.length) throw badRequest("Kamida bitta rol tanlang");
  const bad = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (bad.length) throw badRequest(`Noma'lum rol: ${bad.join(", ")}`);
  return [...new Set(roles)] as Role[];
}

export async function createUser(
  ctx: Ctx, input: { username: string; displayName: string; password: string; roles: string[] }, actor: Actor,
): Promise<UserAdminDto> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw badRequest("Login 3–32 belgi: lotin harflari, raqam, . _ -");
  if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", username)) throw conflict("username_taken", "Bu login band");
  checkPassword(input.password);
  const roles = validRoles(input.roles);
  const hash = await hashPassword(input.password);
  const id = uid("usr");
  ctx.db.tx(() => {
    ctx.db.run(
      "INSERT INTO users (id, username, display_name, password_hash, created_at, created_by) VALUES (?,?,?,?,?,?)",
      id, username, input.displayName.trim() || username, hash, now(), actor.type === "user" ? actor.id : null,
    );
    for (const r of roles) ctx.db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", id, r);
    audit(ctx.db, actor, "user.create", { type: "user", id }, { username, roles });
  });
  return getUser(ctx, id);
}

export function updateUser(
  ctx: Ctx, id: string, patch: { displayName?: string; roles?: string[]; isActive?: boolean }, actor: Actor,
): UserAdminDto {
  const u = getUser(ctx, id);
  const roles = patch.roles ? validRoles(patch.roles) : u.roles;
  const active = patch.isActive ?? u.isActive;
  const losesAdmin = u.roles.includes("admin") && u.isActive && (!roles.includes("admin") || !active);
  if (losesAdmin && activeAdmins(ctx, id) === 0) throw conflict("last_admin", "Kamida bitta faol administrator qolishi kerak");
  if (actor.id === id && (!active || (u.roles.includes("admin") && !roles.includes("admin"))))
    throw conflict("self_lockout", "O'zingizni o'chira yoki admin huquqidan mahrum qila olmaysiz");
  ctx.db.tx(() => {
    if (patch.displayName !== undefined) ctx.db.run("UPDATE users SET display_name = ? WHERE id = ?", patch.displayName.trim() || u.username, id);
    if (patch.roles) {
      ctx.db.run("DELETE FROM user_roles WHERE user_id = ?", id);
      for (const r of roles) ctx.db.run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", id, r);
    }
    if (patch.isActive !== undefined) {
      ctx.db.run("UPDATE users SET is_active = ?, status = ? WHERE id = ?", active ? 1 : 0, active ? "active" : "inactive", id);
      if (!active) ctx.db.run("DELETE FROM sessions WHERE user_id = ?", id);
    }
    audit(ctx.db, actor, "user.update", { type: "user", id }, { roles: patch.roles, isActive: patch.isActive, displayName: patch.displayName });
  });
  return getUser(ctx, id);
}

/** Admin reset: sets a new password and signs the user out everywhere. */
export async function resetPassword(ctx: Ctx, id: string, password: string, actor: Actor) {
  getUser(ctx, id);
  checkPassword(password);
  const hash = await hashPassword(password);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash, id);
    ctx.db.run("DELETE FROM sessions WHERE user_id = ?", id);
    audit(ctx.db, actor, "user.password_reset", { type: "user", id });
  });
}

/** Self-service change: requires the current password; other sessions are ended, the current one stays. */
export async function changeOwnPassword(ctx: Ctx, userId: string, current: string, next: string, keepTokenHash?: string) {
  const row = ctx.db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", userId);
  if (!row || !(await verifyPassword(current, row.password_hash))) throw badRequest("Joriy parol noto'g'ri");
  checkPassword(next);
  if (current === next) throw badRequest("Yangi parol eskisidan farq qilsin");
  const hash = await hashPassword(next);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash, userId);
    ctx.db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", userId, keepTokenHash ?? "");
    audit(ctx.db, { type: "user", id: userId }, "user.password_change", { type: "user", id: userId });
  });
}
