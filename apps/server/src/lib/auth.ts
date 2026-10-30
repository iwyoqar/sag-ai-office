import { createHash } from "node:crypto";
import type { Permission, Role } from "@sag/shared";
import type { Db } from "../db/db.js";
import { now } from "../db/db.js";
import { token } from "./ids.js";
import { verifyPassword } from "./passwords.js";

export interface Grant {
  permission: Permission;
  /** null = not limited to one department */
  departmentId: string | null;
  canDelegate: boolean;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: Role[];
  /** role permissions + department-unscoped grants */
  permissions: Permission[];
  /** employee's own department (null for technical accounts) */
  departmentId: string | null;
  managerId: string | null;
  /** departments where this user is the head */
  headOf: string[];
  grants: Grant[];
  /** business unit the account belongs to ('hq' = SAG Head Office); company-wide routes serve HQ accounts only */
  homeUnitId: string;
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Loads an active user with everything authorisation needs. Inactive/archived accounts load as null. */
export function loadUser(db: Db, userId: string): AuthUser | null {
  const u = db.get<{
    id: string; username: string; display_name: string; is_active: number; status: string; department_id: string | null;
    manager_id: string | null; home_unit_id: string; activation_status: string;
  }>(
    "SELECT id, username, display_name, is_active, status, department_id, manager_id, home_unit_id, activation_status FROM users WHERE id = ?", userId,
  );
  if (!u || !u.is_active || u.status !== "active" || u.activation_status !== "ACTIVE") return null;
  const roles = db.all<{ role_id: Role }>("SELECT role_id FROM user_roles WHERE user_id = ?", u.id).map((r) => r.role_id);
  const rolePerms = db
    .all<{ permission_id: Permission }>(
      `SELECT DISTINCT rp.permission_id FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id = rp.role_id WHERE ur.user_id = ?`,
      u.id,
    )
    .map((r) => r.permission_id);
  const grants = db
    .all<{ permission_id: Permission; department_id: string | null; can_delegate: number }>(
      "SELECT permission_id, department_id, can_delegate FROM user_permissions WHERE user_id = ?", u.id,
    )
    .map((g) => ({ permission: g.permission_id, departmentId: g.department_id, canDelegate: !!g.can_delegate }));
  const permissions = [...new Set([...rolePerms, ...grants.filter((g) => !g.departmentId).map((g) => g.permission)])];
  const headOf = db.all<{ id: string }>("SELECT id FROM departments WHERE head_user_id = ?", u.id).map((r) => r.id);
  return {
    id: u.id, username: u.username, displayName: u.display_name, roles, permissions,
    departmentId: u.department_id, managerId: u.manager_id, headOf, grants, homeUnitId: u.home_unit_id,
  };
}

export async function login(db: Db, username: string, password: string): Promise<AuthUser | null> {
  const row = db.get<{ id: string; password_hash: string; is_active: number; status: string; activation_status: string }>(
    "SELECT id, password_hash, is_active, status, activation_status FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)", username, username.toLowerCase(),
  );
  // Verify against a dummy hash when the user is missing (or has no password yet: pending activation), so timing
  // does not reveal valid usernames.
  const hash = row?.password_hash.startsWith("scrypt$") ? row.password_hash : DUMMY_HASH;
  const ok = await verifyPassword(password, hash);
  if (!row || !row.is_active || row.status !== "active" || row.activation_status !== "ACTIVE" || hash === DUMMY_HASH || !ok) return null;
  return loadUser(db, row.id);
}

const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function createSession(db: Db, userId: string, ttlHours: number): { token: string; expiresAt: string } {
  const raw = token(32);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)", sha(raw), userId, now(), expiresAt);
  return { token: raw, expiresAt };
}

export function userForSession(db: Db, raw: string | undefined): AuthUser | null {
  if (!raw) return null;
  const s = db.get<{ user_id: string; expires_at: string }>("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", sha(raw));
  if (!s) return null;
  if (s.expires_at < now()) {
    db.run("DELETE FROM sessions WHERE token_hash = ?", sha(raw));
    return null;
  }
  return loadUser(db, s.user_id);
}

export function destroySession(db: Db, raw: string | undefined) {
  if (raw) db.run("DELETE FROM sessions WHERE token_hash = ?", sha(raw));
}

/** Small in-memory limiter for login attempts (per key, sliding window). */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string): boolean {
    const t = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}
