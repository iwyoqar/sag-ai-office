// Unit budgets: one budget per unit, month and category, in the reporting currency UZS, integer minor units (tiyin).
// Spending entries keep their original amount and currency plus the exact rate used. Not an accounting system:
// allocation, approval, spending against it, remaining.
//
// Rights (security model §3.6):
// - own unit: the unit director drafts, submits and records; a unit manager records and views; staff see nothing.
// - SAG_BRANCH budgets are approved by an HQ director (never the person who submitted them).
// - INDEPENDENT_DEALER / SUBSIDIARY budgets are governed by the unit itself: its director approves (audited as such);
//   HQ sees them only through an active agreement that includes the "budget" class (AGGREGATE = totals, DETAIL =
//   budgets and entries) and can never change them.
// - HQ's own budgets: HQ directors.
import type { BudgetCategory, BudgetDto, BudgetEntryDto, BudgetStatus, BudgetSummaryDto } from "@sag/shared";
import { now } from "../db/db.js";
import { audit } from "../lib/audit.js";
import type { AuthUser } from "../lib/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import { convert, formatAmount, parseAmount, parseRate } from "../lib/money.js";
import type { Ctx } from "./context.js";
import { HQ_UNIT, can, isGroupLevel, unitAccess } from "./units.js";

const REPORTING = "UZS";

export interface BudgetRights { view: "NONE" | "AGGREGATE" | "DETAIL"; edit: boolean; record: boolean; approve: boolean; selfGoverned: boolean }

const isHqDirector = (u: AuthUser) => u.homeUnitId === HQ_UNIT && u.roles.includes("director");

export function budgetRights(ctx: Ctx, u: AuthUser, unitId: string): BudgetRights {
  const none: BudgetRights = { view: "NONE", edit: false, record: false, approve: false, selfGoverned: false };
  if (unitId === HQ_UNIT) {
    if (!isGroupLevel(u)) return none;
    return { view: "DETAIL", edit: isHqDirector(u), record: isHqDirector(u), approve: isHqDirector(u), selfGoverned: false };
  }
  const a = unitAccess(ctx, u, unitId); // 404 when the unit is invisible to u
  const type = ctx.db.get<{ business_type: string }>("SELECT business_type FROM org_nodes WHERE id = ?", unitId)!.business_type;
  const selfGoverned = type !== "SAG_BRANCH";
  if (a.memberRole === "unit_director") return { view: "DETAIL", edit: true, record: true, approve: selfGoverned, selfGoverned };
  if (a.memberRole === "unit_manager") return { view: "DETAIL", edit: false, record: true, approve: false, selfGoverned };
  if (a.memberRole) return none; // staff
  const view = can(a, "budget", "DETAIL") ? "DETAIL" : can(a, "budget") ? "AGGREGATE" : "NONE";
  // outside parties never change a unit's budget, except HQ directors approving SAG-owned branches' budgets
  return { view, edit: false, record: false, approve: !selfGoverned && isHqDirector(u) && view === "DETAIL", selfGoverned };
}

interface BudgetRow {
  id: string; business_unit_id: string; period: string; category: BudgetCategory; allocated_minor: number; currency: "UZS";
  status: BudgetStatus; note: string; created_by: string; submitted_by: string | null; submitted_at: string | null;
  decided_by: string | null; decided_at: string | null; decision_reason: string | null;
}

const minorUnits = (ctx: Ctx, code: string) => {
  const c = ctx.db.get<{ minor_units: number }>("SELECT minor_units FROM currencies WHERE code = ?", code);
  if (!c) throw badRequest(`Valyuta qo'llab-quvvatlanmaydi: ${code}`);
  return c.minor_units;
};

function spentMinor(ctx: Ctx, budgetId: string): bigint {
  // SUM over integers stays exact in SQLite (64-bit) — read as text, converted to BigInt
  const r = ctx.db.get<{ s: string }>("SELECT CAST(COALESCE(SUM(amount_minor), 0) AS TEXT) s FROM unit_budget_entries WHERE budget_id = ?", budgetId)!;
  return BigInt(r.s);
}

function toDto(ctx: Ctx, r: BudgetRow): BudgetDto {
  const mu = minorUnits(ctx, REPORTING);
  const allocated = BigInt(r.allocated_minor);
  const spent = spentMinor(ctx, r.id);
  return {
    id: r.id, unitId: r.business_unit_id, period: r.period, category: r.category, currency: REPORTING, status: r.status,
    allocated: formatAmount(allocated, mu), spent: formatAmount(spent, mu), remaining: formatAmount(allocated - spent, mu),
    note: r.note, createdBy: r.created_by, submittedAt: r.submitted_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
  };
}

function budgetOf(ctx: Ctx, unitId: string, budgetId: string): BudgetRow {
  const r = ctx.db.get<BudgetRow>("SELECT * FROM unit_budgets WHERE id = ?", budgetId);
  if (!r || r.business_unit_id !== unitId) throw notFound("Budjet");
  return r;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function listBudgets(ctx: Ctx, u: AuthUser, unitId: string, period?: string): BudgetDto[] | BudgetSummaryDto[] {
  const rights = budgetRights(ctx, u, unitId);
  if (rights.view === "NONE") throw forbidden("Bu bo'lim budjetini ko'rish uchun ruxsat yo'q");
  const rows = ctx.db.all<BudgetRow>(
    `SELECT * FROM unit_budgets WHERE business_unit_id = ? ${period ? "AND period = ?" : ""} ORDER BY period DESC, category`,
    ...(period ? [unitId, period] : [unitId]),
  );
  const dtos = rows.map((r) => toDto(ctx, r));
  if (rights.view === "DETAIL") return dtos;
  return dtos.map(({ period: p, category, status, allocated, spent, remaining }) => ({ period: p, category, status, allocated, spent, remaining }));
}

export function createBudget(ctx: Ctx, u: AuthUser, unitId: string, i: { period: string; category: BudgetCategory; allocated: string; note?: string }): BudgetDto {
  if (!budgetRights(ctx, u, unitId).edit) throw forbidden();
  if (!PERIOD.test(i.period)) throw badRequest("Davr YYYY-MM ko'rinishida bo'lishi kerak");
  const allocated = amount(ctx, i.allocated, REPORTING);
  if (allocated < 0n) throw badRequest("Ajratilgan summa manfiy bo'lishi mumkin emas");
  if (ctx.db.get("SELECT 1 FROM unit_budgets WHERE business_unit_id = ? AND period = ? AND category = ?", unitId, i.period, i.category))
    throw conflict("budget_exists", "Bu davr va toifa uchun budjet allaqachon bor");
  const id = uid("bdg");
  const t = now();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO unit_budgets (id, business_unit_id, period, category, allocated_minor, note, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id, unitId, i.period, i.category, allocated, i.note ?? "", u.id, t, t,
    );
    audit(ctx.db, { type: "user", id: u.id }, "budget.create", { type: "budget", id }, { unitId, period: i.period, category: i.category, allocated: i.allocated });
  });
  return toDto(ctx, budgetOf(ctx, unitId, id));
}

/** Change the allocation of a draft (or a rejected budget, which returns to draft). */
export function updateBudget(ctx: Ctx, u: AuthUser, unitId: string, budgetId: string, p: { allocated?: string; note?: string }): BudgetDto {
  if (!budgetRights(ctx, u, unitId).edit) throw forbidden();
  const r = budgetOf(ctx, unitId, budgetId);
  if (r.status !== "DRAFT" && r.status !== "REJECTED") throw conflict("budget_locked", "Faqat qoralama yoki rad etilgan budjet o'zgartiriladi");
  const allocated = p.allocated === undefined ? BigInt(r.allocated_minor) : amount(ctx, p.allocated, REPORTING);
  if (allocated < 0n) throw badRequest("Ajratilgan summa manfiy bo'lishi mumkin emas");
  ctx.db.tx(() => {
    const ch = ctx.db.run(
      "UPDATE unit_budgets SET allocated_minor = ?, note = ?, status = 'DRAFT', updated_at = ? WHERE id = ? AND status = ?",
      allocated, p.note ?? r.note, now(), budgetId, r.status,
    ).changes;
    if (!ch) throw conflict("budget_changed", "Budjet boshqa foydalanuvchi tomonidan o'zgartirildi");
    audit(ctx.db, { type: "user", id: u.id }, "budget.update", { type: "budget", id: budgetId },
      { unitId, before: formatAmount(BigInt(r.allocated_minor), 2), after: formatAmount(allocated, 2) });
  });
  return toDto(ctx, budgetOf(ctx, unitId, budgetId));
}

function transition(ctx: Ctx, u: AuthUser, unitId: string, budgetId: string, from: BudgetStatus, to: BudgetStatus, set: string, params: unknown[], action: string, meta: Record<string, unknown> = {}) {
  ctx.db.tx(() => {
    const ch = ctx.db.run(`UPDATE unit_budgets SET status = ?, ${set}, updated_at = ? WHERE id = ? AND status = ?`, to, ...(params as string[]), now(), budgetId, from).changes;
    if (!ch) throw conflict("budget_status", `Budjet ${from} holatida emas`);
    audit(ctx.db, { type: "user", id: u.id }, action, { type: "budget", id: budgetId }, { unitId, from, to, ...meta });
  });
  return toDto(ctx, budgetOf(ctx, unitId, budgetId));
}

export function submitBudget(ctx: Ctx, u: AuthUser, unitId: string, budgetId: string): BudgetDto {
  if (!budgetRights(ctx, u, unitId).edit) throw forbidden();
  budgetOf(ctx, unitId, budgetId);
  return transition(ctx, u, unitId, budgetId, "DRAFT", "SUBMITTED", "submitted_by = ?, submitted_at = ?", [u.id, now()], "budget.submit");
}

export function decideBudget(ctx: Ctx, u: AuthUser, unitId: string, budgetId: string, decision: "APPROVED" | "REJECTED", reason?: string): BudgetDto {
  const rights = budgetRights(ctx, u, unitId);
  if (!rights.approve) throw forbidden();
  const r = budgetOf(ctx, unitId, budgetId);
  // separation of duties wherever someone else decides (HQ over branches, HQ's own budgets)
  if (!rights.selfGoverned && r.submitted_by === u.id) throw forbidden("Budjetni yuborgan odam uni tasdiqlay olmaydi");
  if (decision === "REJECTED" && !reason?.trim()) throw badRequest("Rad etish sababini yozing");
  return transition(ctx, u, unitId, budgetId, "SUBMITTED", decision, "decided_by = ?, decided_at = ?, decision_reason = ?", [u.id, now(), reason ?? null],
    decision === "APPROVED" ? "budget.approve" : "budget.reject", { selfApproved: rights.selfGoverned && r.submitted_by === u.id });
}

export function closeBudget(ctx: Ctx, u: AuthUser, unitId: string, budgetId: string): BudgetDto {
  const rights = budgetRights(ctx, u, unitId);
  if (!rights.approve) throw forbidden();
  budgetOf(ctx, unitId, budgetId);
  return transition(ctx, u, unitId, budgetId, "APPROVED", "CLOSED", "decided_by = decided_by", [], "budget.close");
}

function amount(ctx: Ctx, text: string, currency: string): bigint {
  try {
    return parseAmount(text, minorUnits(ctx, currency));
  } catch (e) {
    throw badRequest(`Summa noto'g'ri: ${(e as Error).message}`);
  }
}

export interface EntryInput {
  amount: string; currency: string; description: string; occurredOn: string;
  /** required when currency ≠ UZS: UZS per 1 unit of the currency, decimal string, with its date and source */
  fxRate?: string; fxRateDate?: string; fxSource?: string;
}

/** Records spending against an approved budget; amounts in another currency are converted with the given rate. */
export function recordEntry(ctx: Ctx, u: AuthUser, unitId: string, budgetId: string, i: EntryInput): BudgetEntryDto {
  if (!budgetRights(ctx, u, unitId).record) throw forbidden();
  const r = budgetOf(ctx, unitId, budgetId);
  if (r.status !== "APPROVED") throw conflict("budget_not_approved", "Xarajat faqat tasdiqlangan budjetga yoziladi");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.occurredOn)) throw badRequest("Sana YYYY-MM-DD ko'rinishida bo'lishi kerak");
  const currency = i.currency.toUpperCase();
  const original = amount(ctx, i.amount, currency);
  if (original === 0n) throw badRequest("Summa noldan farq qilishi kerak");
  let reporting = original;
  let rateE8: bigint | null = null;
  if (currency !== REPORTING) {
    if (!i.fxRate || !i.fxRateDate || !i.fxSource) throw badRequest("Boshqa valyutada kurs, kurs sanasi va manbasi kerak");
    try {
      rateE8 = parseRate(i.fxRate);
    } catch (e) {
      throw badRequest(`Kurs noto'g'ri: ${(e as Error).message}`);
    }
    reporting = convert(original, minorUnits(ctx, currency), rateE8, minorUnits(ctx, REPORTING));
    if (reporting === 0n) throw badRequest("Konvertatsiyadan keyin summa nolga teng");
  }
  const id = uid("bde");
  const t = now();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO unit_budget_entries (id, budget_id, business_unit_id, amount_minor, original_amount_minor, original_currency, fx_rate_e8,
         fx_rate_date, fx_source, description, occurred_on, recorded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, budgetId, unitId, reporting, original, currency, rateE8, rateE8 ? i.fxRateDate : null, rateE8 ? i.fxSource : null,
      i.description, i.occurredOn, u.id, t,
    );
    audit(ctx.db, { type: "user", id: u.id }, "budget.entry", { type: "budget", id: budgetId },
      { unitId, amount: formatAmount(reporting, 2), original: `${i.amount} ${currency}` });
  });
  return listEntries(ctx, u, unitId, budgetId).find((e) => e.id === id)!;
}

export function listEntries(ctx: Ctx, u: AuthUser, unitId: string, budgetId: string): BudgetEntryDto[] {
  if (budgetRights(ctx, u, unitId).view !== "DETAIL") throw forbidden();
  budgetOf(ctx, unitId, budgetId);
  const mu = minorUnits(ctx, REPORTING);
  return ctx.db.all<{
    id: string; budget_id: string; a: string; o: string; original_currency: string; fx: string | null; fx_rate_date: string | null;
    fx_source: string | null; description: string; occurred_on: string; recorded_by: string; created_at: string;
  }>(
    `SELECT id, budget_id, CAST(amount_minor AS TEXT) a, CAST(original_amount_minor AS TEXT) o, original_currency,
            CAST(fx_rate_e8 AS TEXT) fx, fx_rate_date, fx_source, description, occurred_on, recorded_by, created_at
     FROM unit_budget_entries WHERE budget_id = ? ORDER BY occurred_on, created_at`, budgetId,
  ).map((e) => ({
    id: e.id, budgetId: e.budget_id, amount: formatAmount(BigInt(e.a), mu), originalAmount: formatAmount(BigInt(e.o), minorUnits(ctx, e.original_currency)),
    originalCurrency: e.original_currency, fxRate: e.fx ? formatAmount(BigInt(e.fx), 8) : null, fxRateDate: e.fx_rate_date, fxSource: e.fx_source,
    description: e.description, occurredOn: e.occurred_on, recordedBy: e.recorded_by, createdAt: e.created_at,
  }));
}
