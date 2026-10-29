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
    "INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, correlation_id, metadata, created_at) VALUES (?,?,?,?,?,?,?,?)",
    actor.type, actor.id, action, target?.type ?? null, target?.id ?? null, correlationId ?? null,
    JSON.stringify(redact(metadata)), now(),
  );
}
