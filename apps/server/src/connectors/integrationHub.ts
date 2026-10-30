// Integration Hub: the management side of connectors — catalog (registry), instances by scope, credentials,
// health and audit. Every function checks the caller server-side; DTOs never contain secrets.
//
// Who may do what:
//   view an instance      its unit's director/manager; HQ "brain:manage" for HQ and region/group instances; HQ group
//                         level for SAG-owned branches; HQ platform admins (structure) for every instance's metadata.
//   manage credentials    HQ instance → HQ "brain:manage"; another unit's instance → that unit's director only
//                         (a franchise's keys are its own); region/group instance → HQ platform admins.
//   shared instances      HQ platform admins create region/group instances and assign them to SAG-owned units below
//                         (the database refuses anything else); region membership never assigns anything.
import { now } from "../db/db.js";
import type { Ctx } from "../domain/context.js";
import { HQ_UNIT, isGroupLevel, isPlatformAdmin } from "../domain/units.js";
import type { AuthUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import type { ConnectorHub } from "./hub.js";
import { credentialScopeOf } from "./installations.js";
import { REGISTRY, STORABLE_AUTH, definitionOf, type AuthMethod } from "./registry.js";
import type { CredentialMeta, CredentialMethod } from "./vault.js";

interface Row {
  id: string; scope_level: "UNIT" | "REGION" | "GROUP"; scope_node_id: string; business_unit_id: string | null; connector_id: string; name: string;
  enabled: number; status: string; credential_scope: string; health_status: string; consecutive_failures: number; last_health_at: string | null;
  last_error: string | null; last_error_class: string | null; unit_type: string | null; scope_name: string;
}

export interface InstanceDto {
  id: string; scopeLevel: Row["scope_level"]; scopeNodeId: string; scopeName: string; unitId: string | null; connectorId: string; name: string;
  enabled: boolean; status: string; healthStatus: string; consecutiveFailures: number; lastHealthAt: string | null; lastError: string | null;
  lastErrorClass: string | null; credentialScope: string; definitionStatus: string; credentials: CredentialMeta[]; assignedUnits: string[];
  can: { manageCredentials: boolean; checkHealth: boolean; assign: boolean };
}

const SELECT = `SELECT ci.*, c.name, u.business_type unit_type, s.name scope_name FROM connector_installations ci
  JOIN connectors c ON c.id = ci.connector_id JOIN org_nodes s ON s.id = ci.scope_node_id LEFT JOIN org_nodes u ON u.id = ci.business_unit_id`;

const isHqManager = (u: AuthUser) => u.homeUnitId === HQ_UNIT && u.permissions.includes("brain:manage");

function unitRole(ctx: Ctx, u: AuthUser, unitId: string) {
  if (u.homeUnitId !== unitId) return null;
  return ctx.db.get<{ role_id: string }>(
    "SELECT role_id FROM unit_memberships WHERE user_id = ? AND node_id = ? AND role_id IN ('unit_director','unit_manager')", u.id, unitId,
  )?.role_id ?? null;
}

function rights(ctx: Ctx, u: AuthUser, r: Row) {
  let view = false;
  let manageCredentials = false;
  if (r.scope_level === "UNIT") {
    if (r.business_unit_id === HQ_UNIT) view = manageCredentials = isHqManager(u);
    else {
      const role = unitRole(ctx, u, r.business_unit_id!);
      view = !!role || isPlatformAdmin(u) || (isGroupLevel(u) && r.unit_type === "SAG_BRANCH");
      manageCredentials = role === "unit_director";
    }
  } else {
    view = isHqManager(u) || isPlatformAdmin(u);
    manageCredentials = isPlatformAdmin(u);
    // units the shared instance is assigned to see it (read-only) through their leads
    if (!view && u.homeUnitId !== HQ_UNIT && unitRole(ctx, u, u.homeUnitId))
      view = !!ctx.db.get("SELECT 1 FROM connector_instance_assignments WHERE instance_id = ? AND business_unit_id = ?", r.id, u.homeUnitId);
  }
  return { view, manageCredentials, checkHealth: manageCredentials || (view && isHqManager(u)), assign: r.scope_level !== "UNIT" && isPlatformAdmin(u) };
}

function toDto(ctx: Ctx, hub: ConnectorHub, u: AuthUser, r: Row): InstanceDto {
  const can = rights(ctx, u, r);
  return {
    id: r.id, scopeLevel: r.scope_level, scopeNodeId: r.scope_node_id, scopeName: r.scope_name, unitId: r.business_unit_id, connectorId: r.connector_id,
    name: r.name, enabled: !!r.enabled, status: r.status, healthStatus: r.health_status, consecutiveFailures: r.consecutive_failures,
    lastHealthAt: r.last_health_at, lastError: r.last_error, lastErrorClass: r.last_error_class, credentialScope: r.credential_scope,
    definitionStatus: definitionOf(r.connector_id)?.status ?? "PLANNED",
    credentials: can.manageCredentials || can.view ? hub.vault.meta(r.id) : [],
    assignedUnits: r.scope_level === "UNIT" ? [] : ctx.db.all<{ u: string }>("SELECT business_unit_id u FROM connector_instance_assignments WHERE instance_id = ?", r.id).map((x) => x.u),
    can: { manageCredentials: can.manageCredentials, checkHealth: can.checkHealth, assign: can.assign },
  };
}

function rowOf(ctx: Ctx, id: string) {
  const r = ctx.db.get<Row>(`${SELECT} WHERE ci.id = ?`, id);
  if (!r) throw notFound("Connector");
  return r;
}

/** An instance the caller may see (others "do not exist"). */
function visibleRow(ctx: Ctx, u: AuthUser, id: string) {
  const r = rowOf(ctx, id);
  if (!rights(ctx, u, r).view) throw notFound("Connector");
  return r;
}

export function catalog() {
  return REGISTRY.map((d) => ({
    id: d.id, name: d.name, provider: d.provider, category: d.category, version: d.version, status: d.status,
    authMethods: d.authMethods, implementedAuth: d.implementedAuth, storableAuth: STORABLE_AUTH[d.id] ?? [], scopes: d.scopes,
    actions: d.actions, healthCheck: d.healthCheck, notes: d.notes ?? null,
  }));
}

export function listInstances(ctx: Ctx, hub: ConnectorHub, u: AuthUser): InstanceDto[] {
  return ctx.db.all<Row>(`${SELECT} ORDER BY CASE ci.scope_level WHEN 'GROUP' THEN 0 WHEN 'REGION' THEN 1 ELSE 2 END, s.name, c.name`)
    .filter((r) => rights(ctx, u, r).view)
    .map((r) => toDto(ctx, hub, u, r));
}

/** HQ platform admins: one shared instance for a region or the whole group (credential-free or storable-key connectors). */
export function createSharedInstance(ctx: Ctx, hub: ConnectorHub, u: AuthUser, i: { scopeNodeId: string; connectorId: string }): InstanceDto {
  if (!isPlatformAdmin(u)) throw forbidden();
  const node = ctx.db.get<{ level: string }>("SELECT level FROM org_nodes WHERE id = ?", i.scopeNodeId);
  if (!node || node.level === "UNIT") throw badRequest("Umumiy connector faqat region yoki guruh darajasida bo'ladi");
  const def = definitionOf(i.connectorId);
  if (!def || def.status !== "AVAILABLE" || !(i.connectorId === "web-search" || STORABLE_AUTH[i.connectorId]))
    throw badRequest("Bu connector umumiy instance sifatida qo'llab-quvvatlanmaydi");
  if (ctx.db.get("SELECT 1 FROM connector_installations WHERE scope_node_id = ? AND connector_id = ?", i.scopeNodeId, i.connectorId))
    throw conflict("installed", "Bu darajada connector allaqachon bor");
  const id = uid("ci");
  const t = now();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO connector_installations (id, scope_level, scope_node_id, business_unit_id, connector_id, status, credential_scope, created_by, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'disconnected', ?, ?, ?, ?)`,
      id, node.level, i.scopeNodeId, i.connectorId, STORABLE_AUTH[i.connectorId] ? "SECRET_STORE" : credentialScopeOf(i.connectorId), u.id, t, t,
    );
    audit(ctx.db, { type: "user", id: u.id }, "connector.instance.create", { type: "connector_instance", id }, { scope: i.scopeNodeId, connectorId: i.connectorId });
  });
  return toDto(ctx, hub, u, rowOf(ctx, id));
}

export function assignInstance(ctx: Ctx, hub: ConnectorHub, u: AuthUser, instanceId: string, unitId: string, assign: boolean): InstanceDto {
  const r = visibleRow(ctx, u, instanceId);
  if (!rights(ctx, u, r).assign) throw forbidden();
  ctx.db.tx(() => {
    if (assign) {
      try {
        ctx.db.run("INSERT INTO connector_instance_assignments (instance_id, business_unit_id, granted_by, granted_at) VALUES (?,?,?,?)", instanceId, unitId, u.id, now());
      } catch (e) {
        if (/UNIQUE|PRIMARY/.test((e as Error).message)) throw conflict("assigned", "Allaqachon tayinlangan");
        if (/cross_unit/.test((e as Error).message)) throw badRequest("Umumiy connector faqat shu daraja ostidagi SAG filiallariga tayinlanadi");
        throw e;
      }
      for (const d of ctx.db.all<{ id: string }>("SELECT id FROM departments WHERE business_unit_id = ?", unitId))
        ctx.db.run("INSERT OR IGNORE INTO department_connectors (department_id, connector_id) VALUES (?, ?)", d.id, r.connector_id);
    } else {
      ctx.db.run("DELETE FROM connector_instance_assignments WHERE instance_id = ? AND business_unit_id = ?", instanceId, unitId);
      // the unit's agents lose the grant unless the unit still has the connector another way
      if (!ctx.db.get("SELECT 1 FROM connector_installations WHERE business_unit_id = ? AND connector_id = ? AND enabled = 1", unitId, r.connector_id))
        ctx.db.run("DELETE FROM agent_connector_permissions WHERE connector_id = ? AND agent_id IN (SELECT id FROM agents WHERE business_unit_id = ?)", r.connector_id, unitId);
    }
    audit(ctx.db, { type: "user", id: u.id }, assign ? "connector.assign" : "connector.unassign", { type: "connector_instance", id: instanceId }, { unitId });
  });
  return toDto(ctx, hub, u, rowOf(ctx, instanceId));
}

export function setCredential(
  ctx: Ctx, hub: ConnectorHub, u: AuthUser, instanceId: string, i: { method: AuthMethod; secret: string; expiresAt?: string | null },
): InstanceDto {
  const r = visibleRow(ctx, u, instanceId);
  if (!rights(ctx, u, r).manageCredentials) throw forbidden();
  if (!(STORABLE_AUTH[r.connector_id] ?? []).includes(i.method))
    throw badRequest("Bu connector uchun bu turdagi kalitni saqlash qo'llab-quvvatlanmaydi");
  if (!hub.vault.enabled) throw conflict("no_secrets_key", "SECRETS_KEY sozlanmagan — kalitni shifrlab saqlab bo'lmaydi");
  if (i.expiresAt && i.expiresAt <= now()) throw badRequest("Muddat kelajakda bo'lishi kerak");
  const meta = hub.vault.store(instanceId, i.method as CredentialMethod, i.secret, { by: u.id, expiresAt: i.expiresAt ?? null });
  audit(ctx.db, { type: "user", id: u.id }, meta.rotatedFrom ? "credential.rotate" : "credential.set", { type: "connector_instance", id: instanceId },
    { unitId: r.business_unit_id ?? undefined, method: i.method, fingerprint: meta.fingerprint, expiresAt: meta.expiresAt });
  ctx.db.run("UPDATE connector_installations SET health_status = 'UNKNOWN', consecutive_failures = 0, updated_at = ? WHERE id = ?", now(), instanceId);
  return toDto(ctx, hub, u, rowOf(ctx, instanceId));
}

export function revokeCredential(ctx: Ctx, hub: ConnectorHub, u: AuthUser, instanceId: string, credentialId: string): InstanceDto {
  const r = visibleRow(ctx, u, instanceId);
  if (!rights(ctx, u, r).manageCredentials) throw forbidden();
  if (!ctx.db.get("SELECT 1 FROM connector_credentials WHERE id = ? AND instance_id = ?", credentialId, instanceId)) throw notFound("Kalit");
  const meta = hub.vault.revoke(credentialId, u.id);
  audit(ctx.db, { type: "user", id: u.id }, "credential.revoke", { type: "connector_instance", id: instanceId },
    { unitId: r.business_unit_id ?? undefined, method: meta.method, fingerprint: meta.fingerprint });
  return toDto(ctx, hub, u, rowOf(ctx, instanceId));
}

export async function checkHealth(ctx: Ctx, hub: ConnectorHub, u: AuthUser, instanceId: string) {
  const r = visibleRow(ctx, u, instanceId);
  if (!rights(ctx, u, r).checkHealth) throw forbidden();
  const res = await hub.checkInstance(instanceId);
  audit(ctx.db, { type: "user", id: u.id }, "connector.health", { type: "connector_instance", id: instanceId }, { unitId: r.business_unit_id ?? undefined, ok: res.ok, errorClass: res.errorClass });
  return { result: res, instance: toDto(ctx, hub, u, rowOf(ctx, instanceId)) };
}

/** Connector audit history of the instances the caller may see (never metadata of others, never secrets). */
export function auditHistory(ctx: Ctx, hub: ConnectorHub, u: AuthUser, limit = 100) {
  const ids = new Set(listInstances(ctx, hub, u).map((i) => i.id));
  return ctx.db.all<{ id: number; actor_type: string; actor_id: string | null; action: string; target_id: string | null; metadata: string; created_at: string }>(
    `SELECT id, actor_type, actor_id, action, target_id, metadata, created_at FROM audit_logs
     WHERE target_type = 'connector_instance' ORDER BY id DESC LIMIT 1000`,
  ).filter((a) => a.target_id && ids.has(a.target_id)).slice(0, limit)
    .map((a) => ({ id: a.id, actor: a.actor_id, action: a.action, instanceId: a.target_id, at: a.created_at, details: JSON.parse(a.metadata) }));
}

export function runsOf(ctx: Ctx, u: AuthUser, instanceId: string) {
  visibleRow(ctx, u, instanceId);
  return ctx.db.all("SELECT id, kind, status, error_class errorClass, error, started_at startedAt, finished_at finishedAt, duration_ms durationMs FROM connector_runs WHERE instance_id = ? ORDER BY started_at DESC LIMIT 20", instanceId);
}
