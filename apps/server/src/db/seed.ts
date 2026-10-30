import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES } from "@sag/shared";
import { type Db, now } from "./db.js";
import { AGENTS, CONNECTORS, DEPARTMENTS, FLOORS, GLOBAL_INSTRUCTIONS } from "./seedData.js";
import { hashPassword } from "../lib/passwords.js";
import { ensureHqInstallations } from "../connectors/installations.js";
import { slug, token, uid } from "../lib/ids.js";
import { writeFileSync } from "node:fs";
import { ensureAgentTemplates } from "../domain/templatesFromAgents.js";
import { dirname, join } from "node:path";

/**
 * A generated first-boot admin password goes to a file next to the database (data/ is git-ignored, owner-only
 * permissions where the OS supports them) — never to logs or stdout, which hosts keep and share.
 */
export function writeInitialAdminPassword(databasePath: string, password: string): string {
  const file = join(dirname(databasePath), "initial-admin-password.txt");
  const text = ["login: admin", `password: ${password}`, "", "Change it after the first sign-in, then delete this file.", ""].join("\n");
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

export interface SeedResult {
  seeded: boolean;
  admin?: { username: string; password: string; generated: boolean };
}

/** Idempotent: does nothing if the organisation already exists. */
export async function seed(db: Db, opts: { adminPassword?: string } = {}): Promise<SeedResult> {
  if (db.get("SELECT id FROM floors LIMIT 1")) {
    ensureAgentTemplates(db); // marketplace catalog for databases seeded before migration 017
    return { seeded: false };
  }
  const t = now();
  const generated = !opts.adminPassword;
  const password = opts.adminPassword ?? token(12);
  const adminHash = await hashPassword(password);

  db.tx(() => {
    // OR IGNORE: later migrations may already have inserted newer roles/permissions
    for (const r of ROLES) db.run("INSERT OR IGNORE INTO roles (id) VALUES (?)", r);
    for (const p of PERMISSIONS) db.run("INSERT OR IGNORE INTO permissions (id) VALUES (?)", p);
    for (const r of ROLES)
      for (const p of DEFAULT_ROLE_PERMISSIONS[r]) db.run("INSERT OR IGNORE INTO role_permissions VALUES (?, ?)", r, p);

    for (const f of FLOORS) db.run("INSERT INTO floors (id, level, title) VALUES (?, ?, ?)", f.id, f.level, f.title);
    for (const c of CONNECTORS)
      db.run("INSERT OR IGNORE INTO connectors (id, name, kind, created_at) VALUES (?, ?, ?, ?)", c.id, c.name, c.kind, t); // some come from migrations
    ensureHqInstallations(db); // every connector belongs to HQ until a unit gets its own installation

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

  ensureAgentTemplates(db);
  return { seeded: true, admin: { username: "admin", password, generated } };
}
