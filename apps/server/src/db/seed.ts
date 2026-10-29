import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES } from "@sag/shared";
import { type Db, now } from "./db.js";
import { AGENTS, CONNECTORS, DEPARTMENTS, FLOORS, GLOBAL_INSTRUCTIONS } from "./seedData.js";
import { hashPassword } from "../lib/passwords.js";
import { slug, token, uid } from "../lib/ids.js";

export interface SeedResult {
  seeded: boolean;
  admin?: { username: string; password: string; generated: boolean };
}

/** Idempotent: does nothing if the organisation already exists. */
export async function seed(db: Db, opts: { adminPassword?: string } = {}): Promise<SeedResult> {
  if (db.get("SELECT id FROM floors LIMIT 1")) return { seeded: false };
  const t = now();
  const generated = !opts.adminPassword;
  const password = opts.adminPassword ?? token(12);
  const adminHash = await hashPassword(password);

  db.tx(() => {
    for (const r of ROLES) db.run("INSERT INTO roles (id) VALUES (?)", r);
    for (const p of PERMISSIONS) db.run("INSERT INTO permissions (id) VALUES (?)", p);
    for (const r of ROLES)
      for (const p of DEFAULT_ROLE_PERMISSIONS[r]) db.run("INSERT INTO role_permissions VALUES (?, ?)", r, p);

    for (const f of FLOORS) db.run("INSERT INTO floors (id, level, title) VALUES (?, ?, ?)", f.id, f.level, f.title);
    for (const c of CONNECTORS)
      db.run("INSERT INTO connectors (id, name, kind, created_at) VALUES (?, ?, ?, ?)", c.id, c.name, c.kind, t);

    DEPARTMENTS.forEach((d, i) => {
      db.run(
        "INSERT INTO departments (id, floor_id, name, short, color, weight, sort, focus, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        d.id, d.floor, d.name, d.short, d.color, d.weight, i, JSON.stringify(d.focus), t,
      );
      for (const c of d.connectors) db.run("INSERT INTO department_connectors VALUES (?, ?)", d.id, c);
      (AGENTS[d.id] ?? []).forEach(([name, role], desk) => {
        db.run(
          "INSERT INTO agents (id, name, role, department_id, workstation, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
          `${d.id}-${slug(name)}`, name, role, d.id, desk, t, t,
        );
      });
    });

    for (const g of GLOBAL_INSTRUCTIONS)
      db.run(
        "INSERT INTO instructions (id, scope, scope_id, version, title, content, created_at) VALUES (?, 'GLOBAL', NULL, 1, ?, ?, ?)",
        uid("ins"), g.title, g.content, t,
      );

    const adminId = uid("usr");
    db.run(
      "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, 'admin', 'Administrator', ?, ?)",
      adminId, adminHash, t,
    );
    db.run("INSERT INTO user_roles VALUES (?, 'admin')", adminId);
    db.run(
      "INSERT INTO audit_logs (actor_type, action, target_type, metadata, created_at) VALUES ('system', 'system.seed', 'organisation', ?, ?)",
      JSON.stringify({ floors: FLOORS.length, departments: DEPARTMENTS.length }), t,
    );
  });

  return { seeded: true, admin: { username: "admin", password, generated } };
}
