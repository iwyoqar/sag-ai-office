// Connector installations: which business unit may use which connector. Credentials never live here — they stay
// in the server environment (SERVER_ENV) or the encrypted secret store (SECRET_STORE); NONE = needs no credential.
import type { ConnectorInstallationDto } from "@sag/shared";
import type { Db } from "../db/db.js";
import { now } from "../db/db.js";
import type { Ctx } from "../domain/context.js";
import type { AuthUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { HQ_UNIT, isGroupLevel, unitAccess } from "../domain/units.js";

export type CredentialScope = "NONE" | "SERVER_ENV" | "SECRET_STORE";

export const credentialScopeOf = (connectorId: string): CredentialScope =>
  connectorId === "internal-api" || connectorId === "web-search" ? "NONE"
  : ["gmail", "drive", "sheets", "calendar"].includes(connectorId) ? "SECRET_STORE" : "SERVER_ENV";

/**
 * Connectors a non-HQ unit may have installed today: only those that need no per-unit credential (per-unit
 * credentials for Google, Slack, Notion… are not supported yet — nothing is faked).
 */
export const UNIT_INSTALLABLE: readonly string[] = ["web-search"];

/** HQ owns every catalog connector (idempotent; used by the seed and on start). */
export function ensureHqInstallations(db: Db) {
  const t = now();
  for (const c of db.all<{ id: string; status: string }>("SELECT id, status FROM connectors"))
    db.run(
      `INSERT OR IGNORE INTO connector_installations (id, business_unit_id, connector_id, status, credential_scope, created_at, updated_at)
       VALUES (?, 'hq', ?, ?, ?, ?, ?)`,
      `ci_hq_${c.id}`, c.id, c.status, credentialScopeOf(c.id), t, t,
    );
}

interface InstRow {
  id: string; business_unit_id: string; connector_id: string; name: string; enabled: number; status: ConnectorInstallationDto["status"];
  credential_scope: ConnectorInstallationDto["credentialScope"]; last_health_at: string | null; last_error: string | null;
}
const toDto = (r: InstRow): ConnectorInstallationDto => ({
  id: r.id, unitId: r.business_unit_id, connectorId: r.connector_id, name: r.name, enabled: !!r.enabled, status: r.status,
  credentialScope: r.credential_scope, lastHealthAt: r.last_health_at, lastError: r.last_error,
});

/**
 * Who sees a unit's connector list (metadata only — credentials are never returned): the unit's director and
 * managers, HQ group level for SAG-owned branches, HQ platform admins (they install). Never another unit, and no
 * data-sharing agreement opens it.
 */
function canSeeConnectors(ctx: Ctx, u: AuthUser, unitId: string) {
  const a = unitAccess(ctx, u, unitId); // 404 when invisible
  const type = ctx.db.get<{ business_type: string }>("SELECT business_type FROM org_nodes WHERE id = ?", unitId)!.business_type;
  return { a, ok: a.memberRole === "unit_director" || a.memberRole === "unit_manager" || a.manageStructure || (isGroupLevel(u) && type === "SAG_BRANCH") };
}

export function listUnitConnectors(ctx: Ctx, u: AuthUser, unitId: string): ConnectorInstallationDto[] {
  if (unitId === HQ_UNIT) throw notFound("Biznes bo'lim"); // HQ's connectors live in The Brain
  if (!canSeeConnectors(ctx, u, unitId).ok) throw forbidden();
  return ctx.db.all<InstRow>(
    `SELECT ci.*, c.name FROM connector_installations ci JOIN connectors c ON c.id = ci.connector_id
     WHERE ci.business_unit_id = ? ORDER BY c.name`, unitId,
  ).map(toDto);
}

/** HQ platform admins install a connector for a unit (only ones that need no per-unit credential today). */
export function installUnitConnector(ctx: Ctx, u: AuthUser, unitId: string, connectorId: string): ConnectorInstallationDto {
  if (unitId === HQ_UNIT) throw notFound("Biznes bo'lim");
  const { a } = canSeeConnectors(ctx, u, unitId);
  if (!a.manageStructure) throw forbidden();
  const c = ctx.db.get<{ id: string; status: string }>("SELECT id, status FROM connectors WHERE id = ?", connectorId);
  if (!c) throw notFound("Connector");
  if (!UNIT_INSTALLABLE.includes(connectorId))
    throw badRequest("Bu connector uchun bo'lim darajasidagi kalitlar hali qo'llab-quvvatlanmaydi");
  if (ctx.db.get("SELECT 1 FROM connector_installations WHERE business_unit_id = ? AND connector_id = ?", unitId, connectorId))
    throw conflict("installed", "Connector allaqachon o'rnatilgan");
  const id = uid("ci");
  const t = now();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO connector_installations (id, business_unit_id, connector_id, status, credential_scope, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, unitId, connectorId, c.status, credentialScopeOf(connectorId), u.id, t, t,
    );
    // the unit's departments may use it (agents still need an explicit grant)
    for (const d of ctx.db.all<{ id: string }>("SELECT id FROM departments WHERE business_unit_id = ?", unitId))
      ctx.db.run("INSERT OR IGNORE INTO department_connectors (department_id, connector_id) VALUES (?, ?)", d.id, connectorId);
    audit(ctx.db, { type: "user", id: u.id }, "connector.install", { type: "unit", id: unitId }, { unitId, connectorId });
  });
  return listUnitConnectors(ctx, u, unitId).find((x) => x.id === id)!;
}

/** Disable / re-enable; disabling also withdraws every agent grant of that connector in the unit. */
export function setUnitConnectorEnabled(ctx: Ctx, u: AuthUser, unitId: string, connectorId: string, enabled: boolean): ConnectorInstallationDto {
  if (unitId === HQ_UNIT) throw notFound("Biznes bo'lim");
  const { a } = canSeeConnectors(ctx, u, unitId);
  if (!a.manageStructure) throw forbidden();
  const inst = ctx.db.get<{ id: string }>("SELECT id FROM connector_installations WHERE business_unit_id = ? AND connector_id = ?", unitId, connectorId);
  if (!inst) throw notFound("Connector");
  ctx.db.tx(() => {
    ctx.db.run("UPDATE connector_installations SET enabled = ?, updated_at = ? WHERE id = ?", enabled ? 1 : 0, now(), inst.id);
    if (!enabled)
      ctx.db.run(
        "DELETE FROM agent_connector_permissions WHERE connector_id = ? AND agent_id IN (SELECT id FROM agents WHERE business_unit_id = ?)",
        connectorId, unitId,
      );
    audit(ctx.db, { type: "user", id: u.id }, enabled ? "connector.enable" : "connector.disable", { type: "unit", id: unitId }, { unitId, connectorId });
  });
  return listUnitConnectors(ctx, u, unitId).find((x) => x.id === inst.id)!;
}

/** The unit's director grants its own agents connectors installed in the unit (read; write where the tool allows). */
export function grantUnitAgentConnectors(ctx: Ctx, u: AuthUser, unitId: string, agentId: string, connectorIds: string[], writeIds: string[] = []) {
  if (unitId === HQ_UNIT) throw notFound("Biznes bo'lim");
  const a = unitAccess(ctx, u, unitId);
  if (a.memberRole !== "unit_director") throw forbidden();
  const ag = ctx.db.get<{ business_unit_id: string }>("SELECT business_unit_id FROM agents WHERE id = ?", agentId);
  if (!ag || ag.business_unit_id !== unitId) throw notFound("Agent");
  const installed = new Set(ctx.db.all<{ connector_id: string }>(
    "SELECT connector_id FROM connector_installations WHERE business_unit_id = ? AND enabled = 1", unitId,
  ).map((r) => r.connector_id));
  const missing = connectorIds.filter((c) => !installed.has(c));
  if (missing.length) throw badRequest(`Bu bo'limda o'rnatilmagan: ${missing.join(", ")}`);
  // same shape as HQ grants (domain/agents.ts setAgentConnectors), limited to this unit's installations
  const write = new Set(writeIds.filter((w) => connectorIds.includes(w)));
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM agent_connector_permissions WHERE agent_id = ?", agentId);
    for (const c of new Set(connectorIds))
      ctx.db.run("INSERT INTO agent_connector_permissions (agent_id, connector_id, allowed_actions) VALUES (?, ?, ?)",
        agentId, c, JSON.stringify(write.has(c) ? ["read", "write"] : ["read"]));
    audit(ctx.db, { type: "user", id: u.id }, "agent.connectors.set", { type: "agent", id: agentId }, { unitId, connectorIds, writeIds: [...write] });
  });
  return listUnitConnectors(ctx, u, unitId);
}
