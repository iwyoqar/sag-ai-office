// W4 agent marketplace, HQ first (docs/superpowers/specs/2026-10-30-agent-marketplace-design.md): templates with
// immutable approved versions, per-department hiring limits, and the hire checks. Hard checks reject a request; soft
// checks send a head's request to the admin (AUTO policy: everything passing hires at once).
import type { HireCheck, HireOutcome, HiringLimitDto, TemplateDto, TemplateTool, TemplateVersionDto } from "@sag/shared";
import { json, now } from "../db/db.js";
import type { AuthUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { slug } from "../lib/ids.js";
import { has } from "./access.js";
import type { Ctx } from "./context.js";
import { riskOf } from "./templatesFromAgents.js";

/** most PENDING requests a department may have at once */
export const PENDING_CAP = 5;

export const isAdmin = (u: AuthUser) => has(u, "users:manage");
const actor = (u: AuthUser) => ({ type: "user" as const, id: u.id });

export function headDepartments(ctx: Ctx, userId: string): string[] {
  return ctx.db.all<{ id: string }>("SELECT id FROM departments WHERE head_user_id = ? AND is_active = 1", userId).map((r) => r.id);
}

// ---------------------------------------------------------------- rows → DTOs

interface TemplateRow {
  id: string; name: string; category: string; status: TemplateDto["status"]; allowed_departments: string; current_version: number | null;
}
interface VersionRow {
  template_id: string; version: number; role: string; responsibilities: string; skills: string; instructions: string; tools: string;
  model: string | null; max_tokens_per_task: number | null; est_monthly_minor: number; risk_level: TemplateVersionDto["riskLevel"];
  approved_at: string | null; approved_note: string | null;
}

const toVersion = (v: VersionRow): TemplateVersionDto => ({
  version: v.version, role: v.role, responsibilities: v.responsibilities, skills: json(v.skills, []), instructions: v.instructions,
  tools: json(v.tools, []), model: v.model, maxTokensPerTask: v.max_tokens_per_task, estMonthlyMinor: v.est_monthly_minor,
  riskLevel: v.risk_level, approvedAt: v.approved_at, approvedNote: v.approved_note,
});

function templateRow(ctx: Ctx, id: string): TemplateRow {
  const t = ctx.db.get<TemplateRow>("SELECT * FROM agent_templates WHERE id = ? AND business_unit_id = 'hq'", id);
  if (!t) throw notFound("Andoza");
  return t;
}

export function versionRow(ctx: Ctx, templateId: string, version: number): VersionRow | undefined {
  return ctx.db.get<VersionRow>("SELECT * FROM agent_template_versions WHERE template_id = ? AND version = ?", templateId, version);
}

/** the newest unapproved version above the published one, if any */
function draftRow(ctx: Ctx, t: TemplateRow): VersionRow | undefined {
  return ctx.db.get<VersionRow>(
    "SELECT * FROM agent_template_versions WHERE template_id = ? AND approved_at IS NULL AND version > ? ORDER BY version DESC LIMIT 1",
    t.id, t.current_version ?? 0,
  );
}

function toTemplate(ctx: Ctx, t: TemplateRow): TemplateDto {
  const cur = t.current_version != null ? versionRow(ctx, t.id, t.current_version) : undefined;
  const draft = draftRow(ctx, t);
  return {
    id: t.id, name: t.name, category: t.category, status: t.status, allowedDepartments: json(t.allowed_departments, []),
    currentVersion: t.current_version, current: cur ? toVersion(cur) : null, draft: draft ? toVersion(draft) : null,
    hiredCount: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE template_id = ? AND lifecycle <> 'ARCHIVED'", t.id)!.n,
  };
}

// ---------------------------------------------------------------- templates

export interface VersionInput {
  role: string; responsibilities: string; skills: string[]; instructions: string; tools: TemplateTool[];
  model: string | null; maxTokensPerTask: number | null; estMonthlyMinor: number;
}

function requireAdmin(u: AuthUser) {
  if (!isAdmin(u)) throw forbidden("Faqat administrator");
}

function checkDepartments(ctx: Ctx, ids: string[]) {
  for (const d of ids) if (!ctx.db.get("SELECT 1 FROM departments WHERE id = ? AND business_unit_id = 'hq'", d)) throw notFound(`Bo'lim ${d}`);
}

function insertVersion(ctx: Ctx, u: AuthUser, templateId: string, version: number, v: VersionInput) {
  if (!v.role.trim()) throw badRequest("Rol kerak");
  ctx.db.run(
    `INSERT INTO agent_template_versions (template_id, version, role, responsibilities, skills, instructions, tools, model, max_tokens_per_task,
       est_monthly_minor, risk_level, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    templateId, version, v.role.trim(), v.responsibilities, JSON.stringify(v.skills), v.instructions, JSON.stringify(v.tools), v.model,
    v.maxTokensPerTask, v.estMonthlyMinor, riskOf(v.tools), u.id, now(),
  );
}

export function listTemplates(ctx: Ctx, u: AuthUser): TemplateDto[] {
  const rows = ctx.db.all<TemplateRow>(
    `SELECT * FROM agent_templates WHERE business_unit_id = 'hq' ${isAdmin(u) ? "" : "AND status = 'APPROVED'"} ORDER BY category, name`,
  );
  return rows.map((t) => toTemplate(ctx, t));
}

export function createTemplate(ctx: Ctx, u: AuthUser, i: { name: string; category: string; allowedDepartments: string[]; version: VersionInput }): TemplateDto {
  requireAdmin(u);
  if (!i.name.trim()) throw badRequest("Nom kerak");
  checkDepartments(ctx, i.allowedDepartments);
  const base = slug(i.name) || "andoza";
  let id = base;
  for (let n = 2; ctx.db.get("SELECT 1 FROM agent_templates WHERE id = ?", id); n++) id = `${base}-${n}`;
  ctx.db.tx(() => {
    ctx.db.run(
      "INSERT INTO agent_templates (id, name, category, status, allowed_departments, created_by, created_at) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?)",
      id, i.name.trim(), i.category, JSON.stringify(i.allowedDepartments), u.id, now(),
    );
    insertVersion(ctx, u, id, 1, i.version);
    audit(ctx.db, actor(u), "marketplace.template.create", { type: "agent_template", id }, { name: i.name });
  });
  return toTemplate(ctx, templateRow(ctx, id));
}

/** Edits go to a draft: a new version above the published one (an existing draft is replaced in place). */
export function addVersion(ctx: Ctx, u: AuthUser, templateId: string, v: VersionInput): TemplateDto {
  requireAdmin(u);
  const t = templateRow(ctx, templateId);
  if (t.status === "RETIRED") throw conflict("template_retired", "Andoza eskirgan");
  const draft = draftRow(ctx, t);
  ctx.db.tx(() => {
    let version: number;
    if (draft) {
      version = draft.version;
      ctx.db.run("DELETE FROM agent_template_versions WHERE template_id = ? AND version = ?", t.id, version);
    } else version = (ctx.db.get<{ m: number }>("SELECT MAX(version) m FROM agent_template_versions WHERE template_id = ?", t.id)!.m ?? 0) + 1;
    insertVersion(ctx, u, t.id, version, v);
    audit(ctx.db, actor(u), "marketplace.template.draft", { type: "agent_template", id: t.id }, { version });
  });
  return toTemplate(ctx, templateRow(ctx, t.id));
}

/** Publishes a draft: it becomes the current version and can never change again. */
export function approveVersion(ctx: Ctx, u: AuthUser, templateId: string, version: number): TemplateDto {
  requireAdmin(u);
  const t = templateRow(ctx, templateId);
  if (t.status === "RETIRED") throw conflict("template_retired", "Andoza eskirgan");
  const v = versionRow(ctx, t.id, version);
  if (!v) throw notFound("Versiya");
  if (v.approved_at || version <= (t.current_version ?? 0)) throw conflict("version_not_draft", "Bu versiya qoralama emas");
  ctx.db.tx(() => {
    ctx.db.run("UPDATE agent_template_versions SET approved_by = ?, approved_at = ? WHERE template_id = ? AND version = ?", u.id, now(), t.id, version);
    ctx.db.run("UPDATE agent_templates SET current_version = ?, status = 'APPROVED' WHERE id = ?", version, t.id);
    audit(ctx.db, actor(u), "marketplace.template.approve", { type: "agent_template", id: t.id }, { version });
  });
  return toTemplate(ctx, templateRow(ctx, t.id));
}

export function retireTemplate(ctx: Ctx, u: AuthUser, templateId: string): TemplateDto {
  requireAdmin(u);
  const t = templateRow(ctx, templateId);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE agent_templates SET status = 'RETIRED' WHERE id = ?", t.id);
    audit(ctx.db, actor(u), "marketplace.template.retire", { type: "agent_template", id: t.id });
  });
  return toTemplate(ctx, templateRow(ctx, t.id));
}

// ---------------------------------------------------------------- limits

interface LimitRow { department_id: string; max_agents: number | null; monthly_budget_minor: number | null; auto_templates: string }

function limitRow(ctx: Ctx, departmentId: string): LimitRow {
  return ctx.db.get<LimitRow>("SELECT * FROM department_hiring_limits WHERE department_id = ?", departmentId)
    ?? { department_id: departmentId, max_agents: null, monthly_budget_minor: null, auto_templates: "[]" };
}

const activeAgents = (ctx: Ctx, departmentId: string) =>
  ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM agents WHERE department_id = ? AND lifecycle <> 'ARCHIVED'", departmentId)!.n;

/** Σ estimated monthly cost of the department's non-archived agents, by the template version each was hired from. */
const committed = (ctx: Ctx, departmentId: string) =>
  ctx.db.get<{ s: number | null }>(
    `SELECT SUM(v.est_monthly_minor) s FROM agents a JOIN agent_template_versions v ON v.template_id = a.template_id AND v.version = a.template_version
     WHERE a.department_id = ? AND a.lifecycle <> 'ARCHIVED'`, departmentId,
  )!.s ?? 0;

function toLimit(ctx: Ctx, r: LimitRow): HiringLimitDto {
  return {
    departmentId: r.department_id, maxAgents: r.max_agents, monthlyBudgetMinor: r.monthly_budget_minor, autoTemplates: json(r.auto_templates, []),
    activeAgents: activeAgents(ctx, r.department_id), committedMinor: committed(ctx, r.department_id),
  };
}

export function getLimits(ctx: Ctx, u: AuthUser): HiringLimitDto[] {
  const own = isAdmin(u) ? null : new Set(headDepartments(ctx, u.id));
  return ctx.db.all<{ id: string }>("SELECT id FROM departments WHERE business_unit_id = 'hq' AND is_active = 1 ORDER BY sort")
    .filter((d) => !own || own.has(d.id))
    .map((d) => toLimit(ctx, limitRow(ctx, d.id)));
}

export function setLimit(
  ctx: Ctx, u: AuthUser, departmentId: string, p: { maxAgents?: number | null; monthlyBudgetMinor?: number | null; autoTemplates?: string[] },
): HiringLimitDto {
  requireAdmin(u);
  checkDepartments(ctx, [departmentId]);
  for (const t of p.autoTemplates ?? []) templateRow(ctx, t);
  const cur = limitRow(ctx, departmentId);
  const next = {
    max: p.maxAgents !== undefined ? p.maxAgents : cur.max_agents,
    budget: p.monthlyBudgetMinor !== undefined ? p.monthlyBudgetMinor : cur.monthly_budget_minor,
    auto: p.autoTemplates !== undefined ? JSON.stringify([...new Set(p.autoTemplates)]) : cur.auto_templates,
  };
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO department_hiring_limits (department_id, max_agents, monthly_budget_minor, auto_templates, updated_by, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (department_id) DO UPDATE SET max_agents = excluded.max_agents, monthly_budget_minor = excluded.monthly_budget_minor,
         auto_templates = excluded.auto_templates, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      departmentId, next.max, next.budget, next.auto, u.id, now(),
    );
    audit(ctx.db, actor(u), "marketplace.limit.set", { type: "department", id: departmentId }, p);
  });
  return toLimit(ctx, limitRow(ctx, departmentId));
}

// ---------------------------------------------------------------- checks

const fmt = (minor: number) => `${Math.round(minor / 100).toLocaleString("ru-RU")} so'm`;

/**
 * Every check, in the spec's order, with what it found. `outcome`: a failing hard check rejects; for a head a failing
 * soft check means the admin decides; the admin's own hire needs only the hard checks (soft ones need an override).
 */
export function checkHire(
  ctx: Ctx, i: { templateId: string; version?: number; departmentId: string; requester: "admin" | "head" },
): { checks: HireCheck[]; outcome: HireOutcome; grants: TemplateTool[] } {
  const t = templateRow(ctx, i.templateId);
  const version = i.version ?? t.current_version ?? 0;
  const v = versionRow(ctx, t.id, version);
  const checks: HireCheck[] = [];
  const add = (id: HireCheck["id"], hard: boolean, ok: boolean, detail: string) => checks.push({ id, hard, ok, detail });

  add("template_approved", true, t.status === "APPROVED" && !!v?.approved_at && version === t.current_version,
    t.status === "RETIRED" ? "andoza eskirgan" : t.status !== "APPROVED" ? "andoza tasdiqlanmagan"
      : version !== t.current_version ? `andoza yangilangan: joriy versiya v${t.current_version}` : `andoza tasdiqlangan (v${version})`);

  const dep = ctx.db.get<{ id: string; is_active: number }>("SELECT id, is_active FROM departments WHERE id = ? AND business_unit_id = 'hq'", i.departmentId);
  const allowed = json<string[]>(t.allowed_departments, []);
  add("department_allowed", true, !!dep?.is_active && (!allowed.length || allowed.includes(i.departmentId)),
    !dep ? "bo'lim topilmadi" : !dep.is_active ? "bo'lim faol emas"
      : allowed.length && !allowed.includes(i.departmentId) ? `andoza faqat: ${allowed.join(", ")}` : "bo'limga mos");

  const depConnectors = new Set(ctx.db.all<{ connector_id: string }>("SELECT connector_id FROM department_connectors WHERE department_id = ?", i.departmentId).map((r) => r.connector_id));
  const tools: TemplateTool[] = v ? json(v.tools, []) : [];
  const grants = tools.filter((x) => depConnectors.has(x.connectorId));
  const dropped = tools.filter((x) => !depConnectors.has(x.connectorId)).map((x) => x.connectorId);
  add("tools_within", true, true,
    `beriladi: ${grants.map((g) => g.connectorId).join(", ") || "hech biri"}${dropped.length ? `; bo'limga ulanmagan, berilmaydi: ${dropped.join(", ")}` : ""}`);

  const pending = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_hire_requests WHERE department_id = ? AND status = 'PENDING'", i.departmentId)!.n;
  add("pending_cap", true, pending < PENDING_CAP, `kutilayotgan so'rovlar: ${pending}/${PENDING_CAP}`);

  const lim = limitRow(ctx, i.departmentId);
  const count = activeAgents(ctx, i.departmentId);
  add("agent_count", false, lim.max_agents == null || count + 1 <= lim.max_agents,
    lim.max_agents == null ? `agentlar: ${count} (limit yo'q)` : `agentlar: ${count}/${lim.max_agents}`);

  const cost = v?.est_monthly_minor ?? 0, spent = committed(ctx, i.departmentId);
  add("budget", false, lim.monthly_budget_minor == null || spent + cost <= lim.monthly_budget_minor,
    lim.monthly_budget_minor == null ? `oylik narx ${fmt(cost)} (byudjet limiti yo'q)`
      : `${fmt(spent)} + ${fmt(cost)} / ${fmt(lim.monthly_budget_minor)}`);

  add("auto_listed", false, json<string[]>(lim.auto_templates, []).includes(t.id),
    json<string[]>(lim.auto_templates, []).includes(t.id) ? "bo'lim o'zi yollay oladigan andoza" : "bo'limning avto-ro'yxatida yo'q");

  const risk = v?.risk_level ?? "LOW";
  add("risk", false, risk !== "HIGH", risk === "HIGH" ? "yozish huquqli tool'lar bor (HIGH)" : `xavf: ${risk}`);

  const hardFail = checks.some((c) => c.hard && !c.ok);
  const softFail = checks.some((c) => !c.hard && !c.ok);
  const outcome: HireOutcome = hardFail ? "reject" : softFail && i.requester === "head" ? "pending" : "hire";
  return { checks, outcome, grants };
}
