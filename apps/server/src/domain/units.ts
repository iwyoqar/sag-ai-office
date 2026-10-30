// SAG World business units (stores): who may see and do what in a unit, provisioning, directors, employees,
// unit tasks and data-sharing agreements. Every check runs on the server; the UI only mirrors the result.
//
// Access rules (docs/SAG_WORLD_SECURITY_MODEL.md, owner request 2026-10-30):
// - Members of a unit (unit_director / unit_manager / unit_staff) work inside their own unit only.
// - HQ group level (HQ accounts with the admin or director role) sees SAG-owned units (SAG_BRANCH) in detail.
//   HQ memberships on a region/group node with include_descendants do the same for SAG_BRANCH units below it.
// - Franchise / independent units (INDEPENDENT_DEALER): nobody outside the unit sees their data unless an active,
//   approved data-sharing agreement grants it, and then only the agreed data classes at the agreed level.
//   Region membership or the tree position alone never grants anything.
// - HQ platform admins manage structure (assign and invite the real director, approve agreements) without gaining
//   access to a franchise's confidential data.
// - The unit card (name, region, ownership type, status) is network classification, visible to HQ accounts and to
//   the unit's own members; other units' accounts do not see it.
import type {
  AgreementDto, BusinessType, DataClass, NetworkDto, OwnershipModel, ShareLevel, UnitAccessDto, UnitCardDto,
  UnitOverviewDto, UnitPersonDto, UnitRole, UnitTaskDto,
} from "@sag/shared";
import { json, now } from "../db/db.js";
import { type Actor, SYSTEM, audit } from "../lib/audit.js";
import type { AuthUser } from "../lib/auth.js";
import { sha } from "../lib/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { slug, token, uid } from "../lib/ids.js";
import { hashPassword } from "../lib/passwords.js";
import type { Ctx } from "./context.js";
import { createTask } from "./tasks.js";
import { checkPassword } from "./users.js";

export const HQ_UNIT = "hq";
export const GROUP_NODE = "sag-group";
export const DATA_CLASSES: readonly DataClass[] = ["people_counts", "employees", "tasks", "kpi", "ai_usage"];
export const UNIT_ROLES: readonly UnitRole[] = ["unit_director", "unit_manager", "unit_staff"];
/** marker stored in password_hash for accounts that have not set a password yet (never a valid hash) */
export const NO_PASSWORD = "!pending-activation";
const INVITE_TTL_MS = 7 * 24 * 3600_000;

interface NodeRow {
  id: string; level: "GROUP" | "REGION" | "UNIT"; parent_id: string | null; path: string; name: string; code: string;
  business_type: BusinessType | null; ownership_model: OwnershipModel | null; source_brand: string | null;
  source_marker: "HD" | "F" | null; source_label: string | null; status: string; address: string | null; geo: string | null;
  human_director_user_id: string | null; provision_key: string | null;
}

const nodeRow = (ctx: Ctx, id: string) => ctx.db.get<NodeRow>("SELECT * FROM org_nodes WHERE id = ?", id);

function unitRow(ctx: Ctx, id: string): NodeRow {
  const n = nodeRow(ctx, id);
  if (!n || n.level !== "UNIT") throw notFound("Biznes bo'lim");
  return n;
}

const isHq = (u: AuthUser) => u.homeUnitId === HQ_UNIT;
/** HQ accounts acting for SAG GROUP (owner side of the network). */
export const isGroupLevel = (u: AuthUser) => isHq(u) && (u.roles.includes("admin") || u.roles.includes("director"));
/** HQ platform administrators: structure operations only. */
export const isPlatformAdmin = (u: AuthUser) => isHq(u) && u.roles.includes("admin");

function memberRoleIn(ctx: Ctx, userId: string, unitId: string): UnitRole | null {
  const r = ctx.db.get<{ role_id: UnitRole }>(
    `SELECT role_id FROM unit_memberships WHERE user_id = ? AND node_id = ? AND role_id IN ('unit_director','unit_manager','unit_staff')
     ORDER BY CASE role_id WHEN 'unit_director' THEN 0 WHEN 'unit_manager' THEN 1 ELSE 2 END LIMIT 1`,
    userId, unitId,
  );
  return r?.role_id ?? null;
}

const ACTIVE_AGREEMENT = "approved_at IS NOT NULL AND revoked_at IS NULL AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)";

/** Nodes on whose behalf `u` may receive shared data. */
function granteeNodes(ctx: Ctx, u: AuthUser): string[] {
  const out = new Set<string>();
  if (isGroupLevel(u)) out.add(GROUP_NODE);
  if (!isHq(u) && memberRoleIn(ctx, u.id, u.homeUnitId) === "unit_director") out.add(u.homeUnitId);
  if (isHq(u))
    for (const m of ctx.db.all<{ node_id: string }>("SELECT node_id FROM unit_memberships WHERE user_id = ?", u.id)) out.add(m.node_id);
  return [...out];
}

const rank = (l: ShareLevel | undefined) => (l === "DETAIL" ? 2 : l === "AGGREGATE" ? 1 : 0);
const ALL_DETAIL = Object.fromEntries(DATA_CLASSES.map((c) => [c, "DETAIL"])) as Record<DataClass, ShareLevel>;

export interface UnitAccess extends UnitAccessDto {
  unitId: string;
  /** may see the unit card at all */
  card: boolean;
}

/** What `u` may see and do in `unitId`. Throws 404 when the unit is invisible to `u` (never reveals existence). */
export function unitAccess(ctx: Ctx, u: AuthUser, unitId: string): UnitAccess {
  const n = nodeRow(ctx, unitId);
  if (!n || n.level !== "UNIT") throw notFound("Biznes bo'lim");
  const base = { unitId, card: false, memberRole: null, classes: {}, manageStructure: false, canManageEmployees: false, canAssignTasks: false };

  if (u.homeUnitId === unitId && unitId !== HQ_UNIT) {
    const role = memberRoleIn(ctx, u.id, unitId);
    const lead = role === "unit_director" || role === "unit_manager";
    return {
      ...base, card: true, memberRole: role,
      classes: lead ? { ...ALL_DETAIL } : { tasks: "DETAIL" },
      canManageEmployees: role === "unit_director",
      canAssignTasks: lead,
    };
  }

  const classes: Partial<Record<DataClass, ShareLevel>> = {};
  if (isHq(u) && n.business_type === "SAG_BRANCH") {
    const viaTree = isGroupLevel(u) || !!ctx.db.get(
      `SELECT 1 FROM unit_memberships m JOIN org_nodes a ON a.id = m.node_id
       WHERE m.user_id = ? AND m.include_descendants = 1 AND ? LIKE a.path || '%' LIMIT 1`,
      u.id, n.path,
    );
    if (viaTree) Object.assign(classes, ALL_DETAIL);
  }
  const grantees = granteeNodes(ctx, u);
  if (grantees.length) {
    const t = now();
    for (const a of ctx.db.all<{ data_classes: string; level: ShareLevel }>(
      `SELECT data_classes, level FROM data_sharing_agreements
       WHERE unit_id = ? AND grantee_node_id IN (${grantees.map(() => "?").join(",")}) AND ${ACTIVE_AGREEMENT}`,
      unitId, ...grantees, t, t,
    ))
      for (const c of json<DataClass[]>(a.data_classes, []))
        if (DATA_CLASSES.includes(c) && rank(a.level) > rank(classes[c])) classes[c] = a.level;
  }
  const card = isHq(u) || Object.keys(classes).length > 0;
  if (!card) throw notFound("Biznes bo'lim");
  // HQ itself is served by the company-wide routes; here it only appears as a card
  return { ...base, card, classes: unitId === HQ_UNIT ? {} : classes, manageStructure: isPlatformAdmin(u) && unitId !== HQ_UNIT };
}

const can = (a: UnitAccess, c: DataClass, level: ShareLevel = "AGGREGATE") => rank(a.classes[c]) >= rank(level);

function toCard(n: NodeRow, region: NodeRow | undefined): UnitCardDto {
  return {
    id: n.id, name: n.name, code: n.code, regionId: n.parent_id ?? "", regionName: region?.name ?? "",
    businessType: n.business_type!, ownershipModel: n.ownership_model, sourceBrand: n.source_brand, sourceMarker: n.source_marker,
    status: n.status, geo: json<{ lat: number; lng: number } | null>(n.geo, null), address: n.address, isHeadOffice: n.id === HQ_UNIT,
  };
}

// ---------- network & overview ----------

export function network(ctx: Ctx, u: AuthUser): NetworkDto {
  const nodes = ctx.db.all<NodeRow>("SELECT * FROM org_nodes WHERE status <> 'ARCHIVED' ORDER BY level, name");
  const group = nodes.find((n) => n.level === "GROUP")!;
  const regions = nodes.filter((n) => n.level === "REGION");
  const visible = nodes.filter((n) => n.level === "UNIT").filter((n) => {
    try {
      return unitAccess(ctx, u, n.id).card;
    } catch {
      return false;
    }
  });
  return {
    group: { id: group.id, name: group.name },
    regions: regions
      .map((r) => ({ id: r.id, name: r.name, sourceLabel: r.source_label, units: visible.filter((x) => x.parent_id === r.id).map((x) => toCard(x, r)) }))
      // store accounts see only the regions their visible units are in
      .filter((r) => isHq(u) || r.units.length > 0),
  };
}

interface PersonRow {
  id: string; display_name: string; username: string; job_title: string; status: string; activation_status: "ACTIVE" | "PENDING_ACTIVATION";
}

function people(ctx: Ctx, unitId: string): UnitPersonDto[] {
  return ctx.db.all<PersonRow>(
    "SELECT id, display_name, username, job_title, status, activation_status FROM users WHERE home_unit_id = ? AND status <> 'archived' ORDER BY display_name",
    unitId,
  ).map((p) => ({
    id: p.id, displayName: p.display_name, username: p.username, jobTitle: p.job_title, role: memberRoleIn(ctx, p.id, unitId),
    status: p.status, activation: p.activation_status,
  }));
}

interface UnitTaskRow {
  id: string; kind: UnitTaskDto["kind"]; title: string; status: string; priority: string; assignee_user_id: string | null;
  agent_id: string | null; created_at: string; updated_at: string; result: string | null; created_by: string | null;
}
const toTask = (r: UnitTaskRow): UnitTaskDto => ({
  id: r.id, kind: r.kind, title: r.title, status: r.status, priority: r.priority, assigneeUserId: r.assignee_user_id,
  agentId: r.agent_id, createdAt: r.created_at, updatedAt: r.updated_at, result: r.result,
});

export function listUnitTasks(ctx: Ctx, u: AuthUser, unitId: string): UnitTaskDto[] {
  const a = unitAccess(ctx, u, unitId);
  if (!can(a, "tasks", "DETAIL")) throw forbidden("Bu bo'lim vazifalarini ko'rish uchun ruxsat yo'q");
  const own = a.memberRole === "unit_staff";
  return ctx.db.all<UnitTaskRow>(
    `SELECT id, kind, title, status, priority, assignee_user_id, agent_id, created_at, updated_at, result, created_by FROM tasks
     WHERE business_unit_id = ? AND parent_id IS NULL ${own ? "AND (assignee_user_id = ? OR created_by = ?)" : ""}
     ORDER BY created_at DESC LIMIT 200`,
    ...(own ? [unitId, u.id, u.id] : [unitId]),
  ).map(toTask);
}

export function unitOverview(ctx: Ctx, u: AuthUser, unitId: string): UnitOverviewDto {
  const a = unitAccess(ctx, u, unitId);
  const n = unitRow(ctx, unitId);
  const region = n.parent_id ? nodeRow(ctx, n.parent_id) : undefined;
  const restricted: string[] = [];
  const dir = n.human_director_user_id
    ? ctx.db.get<PersonRow>("SELECT id, display_name, username, job_title, status, activation_status FROM users WHERE id = ?", n.human_director_user_id)
    : undefined;
  const seeDirector = can(a, "employees", "DETAIL") || a.manageStructure;
  const ai = ctx.db.get<{ id: string; name: string; status: string; lifecycle: string }>(
    "SELECT id, name, status, lifecycle FROM agents WHERE business_unit_id = ? AND is_primary_director = 1 AND lifecycle <> 'ARCHIVED'", unitId,
  );
  const out: UnitOverviewDto = {
    unit: toCard(n, region),
    access: { memberRole: a.memberRole, classes: a.classes, manageStructure: a.manageStructure, canManageEmployees: a.canManageEmployees, canAssignTasks: a.canAssignTasks },
    director: {
      assigned: !!dir, activation: dir?.activation_status ?? null,
      ...(dir && seeDirector ? { displayName: dir.display_name, username: dir.username } : {}),
    },
    aiDirector: ai ?? null,
    restricted,
  };
  if (!seeDirector && dir) restricted.push("director_identity");

  const staff = people(ctx, unitId);
  if (can(a, "employees", "DETAIL")) {
    out.employees = a.memberRole === "unit_staff" ? undefined : staff;
    out.employeeCount = staff.length;
  } else if (can(a, "people_counts")) out.employeeCount = staff.length;
  else restricted.push("employees");

  if (can(a, "tasks", "DETAIL")) out.tasks = listUnitTasks(ctx, u, unitId);
  else restricted.push("tasks");
  if (can(a, "tasks") && a.memberRole !== "unit_staff") {
    out.taskCounts = Object.fromEntries(ctx.db.all<{ status: string; n: number }>(
      "SELECT status, COUNT(*) n FROM tasks WHERE business_unit_id = ? AND parent_id IS NULL GROUP BY status", unitId,
    ).map((r) => [r.status, r.n]));
  }

  if (can(a, "kpi")) {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const k = ctx.db.get<{ open: number; done: number }>(
      `SELECT SUM(CASE WHEN status NOT IN ('DONE','CANCELLED','FAILED') THEN 1 ELSE 0 END) open,
              SUM(CASE WHEN status = 'DONE' AND completed_at >= ? THEN 1 ELSE 0 END) done
       FROM tasks WHERE business_unit_id = ? AND parent_id IS NULL`, since, unitId,
    );
    out.kpis = { employees: staff.length, openTasks: k?.open ?? 0, doneTasks30d: k?.done ?? 0 };
    if (can(a, "ai_usage"))
      out.kpis.aiCostUsd30d = ctx.db.get<{ c: number }>(
        "SELECT COALESCE(SUM(cost_usd), 0) c FROM tasks WHERE business_unit_id = ? AND created_at >= ?", unitId, since,
      )?.c ?? 0;
  } else restricted.push("kpi");
  return out;
}

// ---------- provisioning (import) ----------

export interface ProvisionStoreInput {
  provisionKey: string;
  regionId: string;
  name: string;
  sourceLabel: string;
  businessType: BusinessType;
  ownershipModel: OwnershipModel;
  sourceBrand: string;
  sourceMarker: "HD" | "F";
  importBatchId: string | null;
}

export interface ProvisionResult {
  unitId: string;
  created: boolean;
  directorCreated: boolean;
  aiDirectorCreated: boolean;
}

function uniqueCode(ctx: Ctx, base: string): string {
  const b = slug(base) || "store";
  for (let i = 1; ; i++) {
    const c = i === 1 ? b : `${b}-${i}`;
    if (!ctx.db.get("SELECT 1 FROM org_nodes WHERE code = ?", c)) return c;
  }
}

function uniqueUsername(ctx: Ctx, base: string): string {
  for (let i = 1; ; i++) {
    const c = i === 1 ? base : `${base}-${i}`;
    if (!ctx.db.get("SELECT 1 FROM users WHERE username = ?", c)) return c;
  }
}

/**
 * Creates (or completes) one store unit: the unit, its policy (hiring APPROVAL), its store team department, exactly
 * one human director account (PENDING_ACTIVATION, no password, no identity invented) and exactly one AI Director
 * agent on the existing agent runtime. Idempotent by provisionKey; one transaction (all or nothing).
 */
export function provisionStoreUnit(ctx: Ctx, i: ProvisionStoreInput, actor: Actor = SYSTEM): ProvisionResult {
  return ctx.db.tx(() => {
    const t = now();
    const region = nodeRow(ctx, i.regionId);
    if (!region || region.level !== "REGION") throw badRequest(`Region topilmadi: ${i.regionId}`);
    let n = ctx.db.get<NodeRow>("SELECT * FROM org_nodes WHERE provision_key = ?", i.provisionKey);
    const created = !n;
    if (!n) {
      const id = uid("bu");
      const code = uniqueCode(ctx, i.name);
      ctx.db.run(
        `INSERT INTO org_nodes (id, level, parent_id, path, name, code, business_type, ownership_model, source_brand, source_marker,
           source_label, import_batch_id, legal_entity_id, functions, provision_key, created_by, created_at, updated_at)
         VALUES (?, 'UNIT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '["RETAIL"]', ?, ?, ?, ?)`,
        id, region.id, `${region.path}${id}/`, i.name, code, i.businessType, i.ownershipModel, i.sourceBrand, i.sourceMarker,
        i.sourceLabel, i.importBatchId, i.businessType === "SAG_BRANCH" ? "le-sag" : null, i.provisionKey,
        actor.type === "user" ? actor.id : null, t, t,
      );
      ctx.db.run("INSERT INTO unit_policies (business_unit_id, hiring_policy, updated_at) VALUES (?, 'APPROVAL', ?)", id, t);
      ctx.db.run(
        `INSERT INTO departments (id, business_unit_id, floor_id, name, short, color, weight, sort, focus, created_at)
         VALUES (?, ?, NULL, 'Do''kon jamoasi', 'Store', ?, 1, 0, '["Savdo","Mijozlar","Ombor","Kassa"]', ?)`,
        `dep_${id}`, id, i.businessType === "SAG_BRANCH" ? "#1f5f8b" : "#b7791f", t,
      );
      audit(ctx.db, actor, "unit.provision", { type: "unit", id }, { businessType: i.businessType, ownership: i.ownershipModel, marker: i.sourceMarker });
      n = unitRow(ctx, id);
    }
    const unitId = n.id;
    const deptId = `dep_${unitId}`;

    let directorCreated = false;
    if (!n.human_director_user_id) {
      const userId = uid("usr");
      ctx.db.run(
        `INSERT INTO users (id, username, display_name, password_hash, is_active, status, activation_status, home_unit_id, department_id,
           job_title, created_at)
         VALUES (?, ?, ?, ?, 0, 'inactive', 'PENDING_ACTIVATION', ?, ?, 'Do''kon direktori', ?)`,
        userId, uniqueUsername(ctx, `dir.${n.code}`), `Direktor — ${n.name} (tayinlanmagan)`, NO_PASSWORD, unitId, deptId, t,
      );
      ctx.db.run(
        "INSERT INTO unit_memberships (user_id, node_id, role_id, granted_by, granted_at) VALUES (?, ?, 'unit_director', ?, ?)",
        userId, unitId, actor.type === "user" ? actor.id : null, t,
      );
      ctx.db.run("UPDATE org_nodes SET human_director_user_id = ?, updated_at = ? WHERE id = ?", userId, t, unitId);
      ctx.db.run("UPDATE departments SET head_user_id = ? WHERE id = ?", userId, deptId);
      audit(ctx.db, actor, "unit.director.provision", { type: "unit", id: unitId }, { userId, activation: "PENDING_ACTIVATION" });
      directorCreated = true;
    }

    let aiDirectorCreated = false;
    if (!ctx.db.get("SELECT 1 FROM agents WHERE business_unit_id = ? AND is_primary_director = 1 AND lifecycle <> 'ARCHIVED'", unitId)) {
      const agentId = `${n.code}-ai-director`;
      ctx.db.run(
        `INSERT INTO agents (id, name, role, department_id, business_unit_id, is_primary_director, skills, responsibilities, workstation,
           created_at, updated_at)
         VALUES (?, ?, 'AI Director', ?, ?, 1, ?, ?, 0, ?, ?)`,
        agentId, `AI Direktor — ${n.name}`, deptId, unitId,
        JSON.stringify(["Savdo tahlili", "Rejalashtirish", "Hisobot", "Xodimlar bilan ishlash"]),
        "Do'kon direktoriga yordam beradi: savdo va ombor holatini tahlil qiladi, kunlik reja va hisobot tayyorlaydi. Faqat o'z do'koni ma'lumotlari bilan ishlaydi. Yangi agent yollash faqat odam tasdig'i bilan (APPROVAL).",
        t, t,
      );
      audit(ctx.db, actor, "unit.ai_director.provision", { type: "unit", id: unitId }, { agentId });
      aiDirectorCreated = true;
    }
    return { unitId, created, directorCreated, aiDirectorCreated };
  });
}

// ---------- directors, invitations, activation ----------

function issueInvitation(ctx: Ctx, by: AuthUser, unitId: string, userId: string, role: UnitRole) {
  const raw = token(32);
  const t = now();
  ctx.db.run("UPDATE user_invitations SET revoked_at = ? WHERE user_id = ? AND accepted_at IS NULL AND revoked_at IS NULL", t, userId);
  ctx.db.run(
    "INSERT INTO user_invitations (id, node_id, user_id, role_id, token_hash, invited_by, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
    uid("inv"), unitId, userId, role, sha(raw), by.id, new Date(Date.now() + INVITE_TTL_MS).toISOString(), t,
  );
  return { activationToken: raw, expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
}

/**
 * HQ platform admin records the real director of a unit and gets a one-time activation token to hand over.
 * The account stays PENDING_ACTIVATION until the director sets a password with the token.
 */
export function assignDirector(ctx: Ctx, u: AuthUser, unitId: string, i: { displayName: string; username?: string; email?: string | null }) {
  const a = unitAccess(ctx, u, unitId);
  if (!a.manageStructure) throw forbidden();
  const n = unitRow(ctx, unitId);
  if (!n.human_director_user_id) throw conflict("no_director", "Direktor hisobi yo'q — avval provisioning");
  const dir = ctx.db.get<{ activation_status: string }>("SELECT activation_status FROM users WHERE id = ?", n.human_director_user_id)!;
  if (dir.activation_status === "ACTIVE") throw conflict("director_active", "Direktor hisobi allaqachon faollashtirilgan");
  return ctx.db.tx(() => {
    if (i.username) {
      const taken = ctx.db.get("SELECT 1 FROM users WHERE username = ? AND id <> ?", i.username, n.human_director_user_id);
      if (taken) throw conflict("username_taken", "Bu login band");
    }
    ctx.db.run(
      "UPDATE users SET display_name = ?, username = COALESCE(?, username), email = COALESCE(?, email) WHERE id = ?",
      i.displayName, i.username ?? null, i.email?.toLowerCase() ?? null, n.human_director_user_id,
    );
    const inv = issueInvitation(ctx, u, unitId, n.human_director_user_id!, "unit_director");
    audit(ctx.db, { type: "user", id: u.id }, "unit.director.assign", { type: "unit", id: unitId }, { userId: n.human_director_user_id });
    const username = ctx.db.get<{ username: string }>("SELECT username FROM users WHERE id = ?", n.human_director_user_id)!.username;
    return { userId: n.human_director_user_id!, username, ...inv };
  });
}

/** One-time activation: the token's owner sets a password; the account becomes active in its own unit only. */
export async function activateAccount(ctx: Ctx, rawToken: string, password: string) {
  checkPassword(password);
  const inv = ctx.db.get<{ id: string; user_id: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }>(
    "SELECT id, user_id, expires_at, accepted_at, revoked_at FROM user_invitations WHERE token_hash = ?", sha(rawToken),
  );
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < now()) throw badRequest("Taklif havolasi yaroqsiz yoki muddati o'tgan");
  const hash = await hashPassword(password);
  return ctx.db.tx(() => {
    // re-check inside the transaction: a token is used exactly once
    const ok = ctx.db.run("UPDATE user_invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL", now(), inv.id);
    if (!ok.changes) throw badRequest("Taklif havolasi yaroqsiz yoki muddati o'tgan");
    ctx.db.run(
      "UPDATE users SET password_hash = ?, is_active = 1, status = 'active', activation_status = 'ACTIVE' WHERE id = ?", hash, inv.user_id,
    );
    audit(ctx.db, { type: "user", id: inv.user_id }, "user.activate", { type: "user", id: inv.user_id });
    return { username: ctx.db.get<{ username: string }>("SELECT username FROM users WHERE id = ?", inv.user_id)!.username };
  });
}

// ---------- employees (unit director) ----------

const STAFF_ROLES: readonly UnitRole[] = ["unit_manager", "unit_staff"];

export function listUnitEmployees(ctx: Ctx, u: AuthUser, unitId: string): UnitPersonDto[] {
  const a = unitAccess(ctx, u, unitId);
  if (!can(a, "employees", "DETAIL") || a.memberRole === "unit_staff") throw forbidden();
  return people(ctx, unitId);
}

export function addUnitEmployee(ctx: Ctx, u: AuthUser, unitId: string, i: { displayName: string; jobTitle?: string; role: UnitRole; username?: string }) {
  const a = unitAccess(ctx, u, unitId);
  if (!a.canManageEmployees) throw forbidden();
  if (!STAFF_ROLES.includes(i.role)) throw forbidden("Direktor faqat menejer yoki xodim rolini bera oladi");
  const n = unitRow(ctx, unitId);
  return ctx.db.tx(() => {
    const id = uid("usr");
    const username = i.username ? i.username : uniqueUsername(ctx, `${slug(i.displayName) || "xodim"}.${n.code}`.slice(0, 60));
    if (ctx.db.get("SELECT 1 FROM users WHERE username = ?", username)) throw conflict("username_taken", "Bu login band");
    ctx.db.run(
      `INSERT INTO users (id, username, display_name, password_hash, is_active, status, activation_status, home_unit_id, department_id,
         job_title, created_by, created_at)
       VALUES (?, ?, ?, ?, 0, 'inactive', 'PENDING_ACTIVATION', ?, ?, ?, ?, ?)`,
      id, username, i.displayName, NO_PASSWORD, unitId, `dep_${unitId}`, i.jobTitle ?? "", u.id, now(),
    );
    ctx.db.run("INSERT INTO unit_memberships (user_id, node_id, role_id, granted_by, granted_at) VALUES (?,?,?,?,?)", id, unitId, i.role, u.id, now());
    const inv = issueInvitation(ctx, u, unitId, id, i.role);
    audit(ctx.db, { type: "user", id: u.id }, "unit.employee.create", { type: "user", id }, { unitId, role: i.role });
    return { userId: id, username, ...inv };
  });
}

export function updateUnitEmployee(ctx: Ctx, u: AuthUser, unitId: string, userId: string, p: { role?: UnitRole; status?: "active" | "inactive" }) {
  const a = unitAccess(ctx, u, unitId);
  if (!a.canManageEmployees) throw forbidden();
  if (userId === u.id) throw forbidden("O'z rolingiz yoki holatingizni o'zgartira olmaysiz");
  const target = ctx.db.get<{ home_unit_id: string; activation_status: string }>("SELECT home_unit_id, activation_status FROM users WHERE id = ?", userId);
  if (!target || target.home_unit_id !== unitId) throw notFound("Xodim");
  const current = memberRoleIn(ctx, userId, unitId);
  if (current === "unit_director") throw forbidden();
  if (p.role && !STAFF_ROLES.includes(p.role)) throw forbidden("Direktor faqat menejer yoki xodim rolini bera oladi");
  ctx.db.tx(() => {
    if (p.role) {
      ctx.db.run("DELETE FROM unit_memberships WHERE user_id = ? AND node_id = ?", userId, unitId);
      ctx.db.run("INSERT INTO unit_memberships (user_id, node_id, role_id, granted_by, granted_at) VALUES (?,?,?,?,?)", userId, unitId, p.role, u.id, now());
    }
    if (p.status) {
      if (p.status === "active" && target.activation_status !== "ACTIVE") throw conflict("pending_activation", "Xodim hali hisobini faollashtirmagan");
      ctx.db.run("UPDATE users SET status = ?, is_active = ? WHERE id = ?", p.status, p.status === "active" ? 1 : 0, userId);
      if (p.status === "inactive") ctx.db.run("DELETE FROM sessions WHERE user_id = ?", userId);
    }
    audit(ctx.db, { type: "user", id: u.id }, "unit.employee.update", { type: "user", id: userId }, { unitId, ...p });
  });
  return people(ctx, unitId).find((x) => x.id === userId)!;
}

export function reissueInvitation(ctx: Ctx, u: AuthUser, unitId: string, userId: string) {
  const a = unitAccess(ctx, u, unitId);
  const target = ctx.db.get<{ home_unit_id: string; activation_status: string }>("SELECT home_unit_id, activation_status FROM users WHERE id = ?", userId);
  if (!target || target.home_unit_id !== unitId) throw notFound("Xodim");
  const role = memberRoleIn(ctx, userId, unitId);
  // directors' invitations come from HQ (assignDirector); staff invitations from the unit director
  if (role === "unit_director" ? !a.manageStructure : !a.canManageEmployees) throw forbidden();
  if (target.activation_status === "ACTIVE") throw conflict("already_active", "Hisob allaqachon faol");
  return ctx.db.tx(() => issueInvitation(ctx, u, unitId, userId, role ?? "unit_staff"));
}

// ---------- unit tasks ----------

export function createUnitTask(
  ctx: Ctx, u: AuthUser, unitId: string,
  i: { title: string; description?: string; priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; assigneeUserId?: string; toAiDirector?: boolean },
): UnitTaskDto {
  const a = unitAccess(ctx, u, unitId);
  if (!a.canAssignTasks) throw forbidden();
  if (!!i.assigneeUserId === !!i.toAiDirector) throw badRequest("Xodimni yoki AI Direktorni tanlang");
  let id: string;
  if (i.toAiDirector) {
    const ai = ctx.db.get<{ id: string }>(
      "SELECT id FROM agents WHERE business_unit_id = ? AND is_primary_director = 1 AND lifecycle = 'ACTIVE'", unitId,
    );
    if (!ai) throw conflict("no_ai_director", "Faol AI Direktor yo'q");
    id = createTask(ctx, { title: i.title, description: i.description, agentId: ai.id, priority: i.priority, unitId }, { type: "user", id: u.id }).id;
  } else {
    const p = ctx.db.get<{ home_unit_id: string; status: string }>("SELECT home_unit_id, status FROM users WHERE id = ?", i.assigneeUserId);
    if (!p || p.home_unit_id !== unitId) throw notFound("Xodim");
    if (p.status !== "active") throw conflict("inactive", "Xodim faol emas");
    id = uid("tsk");
    const t = now();
    ctx.db.run(
      `INSERT INTO tasks (id, business_unit_id, kind, title, description, created_by, department_id, priority, status, assignee_user_id,
         assigned_by, created_at, updated_at)
       VALUES (?, ?, 'human', ?, ?, ?, ?, ?, 'ASSIGNED', ?, ?, ?, ?)`,
      id, unitId, i.title, i.description ?? "", u.id, `dep_${unitId}`, i.priority ?? "MEDIUM", i.assigneeUserId, u.id, t, t,
    );
    audit(ctx.db, { type: "user", id: u.id }, "unit.task.create", { type: "task", id }, { unitId, assignee: i.assigneeUserId });
  }
  return listUnitTasks(ctx, u, unitId).find((x) => x.id === id)!;
}

const HUMAN_FLOW: Record<string, { to: string[]; who: "assignee" | "lead" | "both" }> = {
  ASSIGNED: { to: ["ACCEPTED", "CANCELLED"], who: "both" },
  ACCEPTED: { to: ["IN_PROGRESS", "CANCELLED"], who: "both" },
  IN_PROGRESS: { to: ["IN_REVIEW", "CANCELLED"], who: "both" },
  IN_REVIEW: { to: ["DONE", "CHANGES_REQUESTED"], who: "lead" },
  CHANGES_REQUESTED: { to: ["IN_PROGRESS"], who: "both" },
};

export function moveUnitTask(ctx: Ctx, u: AuthUser, unitId: string, taskId: string, to: string): UnitTaskDto {
  const a = unitAccess(ctx, u, unitId);
  const t = ctx.db.get<UnitTaskRow & { business_unit_id: string }>("SELECT * FROM tasks WHERE id = ?", taskId);
  if (!t || t.business_unit_id !== unitId || t.kind !== "human") throw notFound("Vazifa");
  const lead = a.canAssignTasks;
  const mine = t.assignee_user_id === u.id;
  if (!lead && !mine) throw notFound("Vazifa");
  const rule = HUMAN_FLOW[t.status];
  if (!rule || !rule.to.includes(to)) throw conflict("bad_transition", `${t.status} → ${to} mumkin emas`);
  if (to === "CANCELLED" && !lead) throw forbidden();
  if (rule.who === "lead" && !lead) throw forbidden();
  ctx.db.run(
    "UPDATE tasks SET status = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('DONE','CANCELLED') THEN ? ELSE completed_at END WHERE id = ?",
    to, now(), to, now(), taskId,
  );
  audit(ctx.db, { type: "user", id: u.id }, "unit.task.transition", { type: "task", id: taskId }, { unitId, from: t.status, to });
  return listUnitTasks(ctx, u, unitId).find((x) => x.id === taskId) ?? toTask({ ...t, status: to });
}

// ---------- data-sharing agreements ----------

interface AgreementRow {
  id: string; unit_id: string; grantee_node_id: string; data_classes: string; level: ShareLevel; valid_from: string; valid_to: string | null;
  contract_ref: string; signed_by_owner: string; approved_by: string | null; approved_at: string | null; revoked_at: string | null; created_at: string;
}
function toAgreement(r: AgreementRow): AgreementDto {
  const t = now();
  return {
    id: r.id, unitId: r.unit_id, granteeNodeId: r.grantee_node_id, dataClasses: json(r.data_classes, []), level: r.level,
    validFrom: r.valid_from, validTo: r.valid_to, contractRef: r.contract_ref, approvedAt: r.approved_at, revokedAt: r.revoked_at,
    createdAt: r.created_at, active: !!r.approved_at && !r.revoked_at && r.valid_from <= t && (!r.valid_to || r.valid_to > t),
  };
}

/** The owning unit's director proposes sharing; it takes effect only when the grantee side approves. */
export function proposeAgreement(
  ctx: Ctx, u: AuthUser, unitId: string,
  i: { granteeNodeId: string; dataClasses: DataClass[]; level: ShareLevel; contractRef: string; validFrom?: string; validTo?: string | null },
): AgreementDto {
  const a = unitAccess(ctx, u, unitId);
  if (a.memberRole !== "unit_director") throw forbidden("Faqat bo'lim direktori ma'lumot ulashishni taklif qila oladi");
  const g = nodeRow(ctx, i.granteeNodeId);
  if (!g || g.id === unitId) throw badRequest("Qabul qiluvchi noto'g'ri");
  const classes = [...new Set(i.dataClasses)];
  if (!classes.length || classes.some((c) => !DATA_CLASSES.includes(c))) throw badRequest("Ma'lumot turlari noto'g'ri");
  const id = uid("dsa");
  ctx.db.run(
    `INSERT INTO data_sharing_agreements (id, unit_id, grantee_node_id, data_classes, level, valid_from, valid_to, contract_ref, signed_by_owner, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, unitId, g.id, JSON.stringify(classes), i.level, i.validFrom ?? now(), i.validTo ?? null, i.contractRef, u.id, now(),
  );
  audit(ctx.db, { type: "user", id: u.id }, "agreement.propose", { type: "agreement", id }, { unitId, grantee: g.id, classes, level: i.level });
  return toAgreement(ctx.db.get<AgreementRow>("SELECT * FROM data_sharing_agreements WHERE id = ?", id)!);
}

function agreementRow(ctx: Ctx, id: string) {
  const r = ctx.db.get<AgreementRow>("SELECT * FROM data_sharing_agreements WHERE id = ?", id);
  if (!r) throw notFound("Kelishuv");
  return r;
}

const actsForGrantee = (ctx: Ctx, u: AuthUser, granteeNodeId: string) =>
  granteeNodeId === GROUP_NODE ? isPlatformAdmin(u) : granteeNodes(ctx, u).includes(granteeNodeId) || isPlatformAdmin(u);

export function approveAgreement(ctx: Ctx, u: AuthUser, id: string): AgreementDto {
  const r = agreementRow(ctx, id);
  if (!actsForGrantee(ctx, u, r.grantee_node_id) || r.signed_by_owner === u.id) throw forbidden();
  if (r.approved_at || r.revoked_at) throw conflict("not_pending", "Kelishuv kutilayotgan holatda emas");
  ctx.db.run("UPDATE data_sharing_agreements SET approved_by = ?, approved_at = ? WHERE id = ?", u.id, now(), id);
  audit(ctx.db, { type: "user", id: u.id }, "agreement.approve", { type: "agreement", id });
  return toAgreement(agreementRow(ctx, id));
}

export function revokeAgreement(ctx: Ctx, u: AuthUser, id: string): AgreementDto {
  const r = agreementRow(ctx, id);
  const owner = u.homeUnitId === r.unit_id && memberRoleIn(ctx, u.id, r.unit_id) === "unit_director";
  if (!owner && !actsForGrantee(ctx, u, r.grantee_node_id)) throw forbidden();
  if (r.revoked_at) throw conflict("revoked", "Kelishuv allaqachon bekor qilingan");
  ctx.db.run("UPDATE data_sharing_agreements SET revoked_at = ?, revoked_by = ? WHERE id = ?", now(), u.id, id);
  audit(ctx.db, { type: "user", id: u.id }, "agreement.revoke", { type: "agreement", id });
  return toAgreement(agreementRow(ctx, id));
}

export function listAgreements(ctx: Ctx, u: AuthUser, unitId: string): AgreementDto[] {
  const a = unitAccess(ctx, u, unitId);
  if (a.memberRole !== "unit_director" && !a.manageStructure) throw forbidden();
  return ctx.db.all<AgreementRow>("SELECT * FROM data_sharing_agreements WHERE unit_id = ? ORDER BY created_at DESC", unitId).map(toAgreement);
}

/** Unit an agent works for (agents never act outside it). */
export const agentUnit = (ctx: Ctx, agentId: string) =>
  ctx.db.get<{ business_unit_id: string }>("SELECT business_unit_id FROM agents WHERE id = ?", agentId)?.business_unit_id ?? null;
