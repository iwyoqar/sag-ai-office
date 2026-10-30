import type { Db } from "../db/db.js";
import { now } from "../db/db.js";

export interface Actor {
  type: "user" | "agent" | "system";
  id: string | null;
}

export const SYSTEM: Actor = { type: "system", id: null };

const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization|cookie/i;

/** Drops secret-looking fields so they never land in the audit log. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(x)]),
    );
  }
  return v;
}

export function audit(
  db: Db,
  actor: Actor,
  action: string,
  target: { type: string; id: string | null } | null,
  metadata: Record<string, unknown> = {},
  correlationId?: string,
) {
  db.run(
    `INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, correlation_id, metadata, created_at, business_unit_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    actor.type, actor.id, action, target?.type ?? null, target?.id ?? null, correlationId ?? null,
    JSON.stringify(redact(metadata)), now(), unitOfTarget(db, target, metadata),
  );
}

const UNIT_OF: Record<string, string> = {
  task: "SELECT business_unit_id u FROM tasks WHERE id = ?",
  agent: "SELECT business_unit_id u FROM agents WHERE id = ?",
  user: "SELECT home_unit_id u FROM users WHERE id = ?",
  department: "SELECT business_unit_id u FROM departments WHERE id = ?",
  agreement: "SELECT unit_id u FROM data_sharing_agreements WHERE id = ?",
};

/** Owning business unit of an audit entry, so unit activity is never shown outside the unit's audience. */
function unitOfTarget(db: Db, target: { type: string; id: string | null } | null, metadata: Record<string, unknown>): string | null {
  if (typeof metadata.unitId === "string") return metadata.unitId;
  if (!target?.id) return null;
  if (target.type === "unit") return target.id;
  const q = UNIT_OF[target.type];
  return q ? (db.get<{ u: string }>(q, target.id)?.u ?? null) : null;
}
