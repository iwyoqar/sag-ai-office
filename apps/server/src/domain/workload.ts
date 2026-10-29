// Explainable workload-risk indicator for people. Operational only — never a medical statement, and never used to
// restrict anyone automatically. Computed on read from live task data, so it is always current.
//
// Method (documented in docs/WORKLOAD.md):
//  1. Active work = the person's human tasks in ASSIGNED / ACCEPTED / IN_PROGRESS / CHANGES_REQUESTED / BLOCKED.
//     Completed, cancelled and submitted (IN_REVIEW) work is excluded. A task that has open subtasks is skipped,
//     because its subtasks carry the work (no double counting).
//  2. Remaining effort = estimate − actual hours (or estimate × (1 − progress)); missing estimate → default hours
//     by priority, and the result is marked "low confidence".
//  3. Demand inside the planning horizon: work due within the horizon (or overdue) counts fully, work due later
//     counts pro rata (horizon ÷ days until deadline), work without a deadline counts at `noDeadlineFactor`.
//     Blocked work counts at `blockedFactor` (it cannot progress, but it will come back).
//  4. Capacity = weekly capacity ÷ 5 × horizon working days.
//  5. Level by percent thresholds, then escalated by deadline risk: overdue tasks / several deadlines within 24 h.
import type { TaskPriority, WorkloadDto, WorkloadLevel } from "@sag/shared";
import { getSetting } from "./brain.js";
import type { Ctx } from "./context.js";

export interface WorkloadPolicy {
  /** upper bounds (exclusive) in % of capacity: below yellow → GREEN, below orange → YELLOW, below red → ORANGE */
  yellow: number;
  orange: number;
  red: number;
  horizonDays: number;
  defaultHours: Record<TaskPriority, number>;
  noDeadlineFactor: number;
  blockedFactor: number;
  dueSoonHours: number;
  /** this many deadlines within dueSoonHours → at least ORANGE */
  dueSoonOrange: number;
  /** this many overdue tasks → RED */
  overdueRed: number;
}

export const DEFAULT_POLICY: WorkloadPolicy = {
  yellow: 60, orange: 80, red: 100, horizonDays: 5,
  defaultHours: { LOW: 2, MEDIUM: 4, HIGH: 8, URGENT: 8 },
  noDeadlineFactor: 0.5, blockedFactor: 0.25, dueSoonHours: 24, dueSoonOrange: 3, overdueRed: 2,
};

export function workloadPolicy(ctx: Ctx): WorkloadPolicy {
  const s = getSetting<Partial<WorkloadPolicy>>(ctx, "workload", {});
  return { ...DEFAULT_POLICY, ...s, defaultHours: { ...DEFAULT_POLICY.defaultHours, ...(s.defaultHours ?? {}) } };
}

interface Row {
  status: string; priority: TaskPriority; deadline: string | null; estimate_hours: number | null;
  actual_hours: number | null; progress: number | null;
}

const RANK: Record<WorkloadLevel, number> = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 };
const atLeast = (a: WorkloadLevel, b: WorkloadLevel): WorkloadLevel => (RANK[a] >= RANK[b] ? a : b);
export const levelRank = (l: WorkloadLevel | null | undefined) => (l ? RANK[l] : -1);

export function computeWorkload(ctx: Ctx, userId: string, at = Date.now()): WorkloadDto {
  const pol = workloadPolicy(ctx);
  const cap = ctx.db.get<{ capacity_hours_week: number }>("SELECT capacity_hours_week FROM users WHERE id = ?", userId);
  const capacityHours = Math.round(((cap?.capacity_hours_week ?? 40) / 5) * pol.horizonDays * 10) / 10;
  const rows = ctx.db.all<Row>(
    `SELECT status, priority, deadline, estimate_hours, actual_hours, progress FROM tasks t
     WHERE t.kind = 'human' AND t.assignee_user_id = ?
       AND t.status IN ('ASSIGNED','ACCEPTED','IN_PROGRESS','CHANGES_REQUESTED','BLOCKED')
       AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status NOT IN ('DONE','CANCELLED'))`,
    userId,
  );
  let demand = 0, overdue = 0, dueSoon = 0, blocked = 0, missing = 0;
  const horizonMs = pol.horizonDays * 86_400_000;
  for (const r of rows) {
    let remaining: number;
    if (r.estimate_hours != null) {
      const byProgress = r.estimate_hours * (1 - (r.progress ?? 0) / 100);
      remaining = r.actual_hours != null ? Math.max(0, Math.min(byProgress, r.estimate_hours - r.actual_hours)) : byProgress;
      if (r.actual_hours != null && r.actual_hours >= r.estimate_hours) remaining = Math.max(remaining, r.estimate_hours * 0.1);
    } else {
      missing++;
      remaining = pol.defaultHours[r.priority] * (1 - (r.progress ?? 0) / 100);
    }
    let factor = pol.noDeadlineFactor;
    if (r.deadline) {
      const left = Date.parse(r.deadline) - at;
      if (left < 0) overdue++;
      else if (left <= pol.dueSoonHours * 3_600_000) dueSoon++;
      factor = left <= horizonMs ? 1 : horizonMs / left;
    }
    if (r.status === "BLOCKED") {
      blocked++;
      factor *= pol.blockedFactor;
    }
    demand += remaining * factor;
  }
  const percent = capacityHours > 0 ? Math.round((demand / capacityHours) * 100) : rows.length ? 999 : 0;
  let level: WorkloadLevel = percent >= pol.red ? "RED" : percent >= pol.orange ? "ORANGE" : percent >= pol.yellow ? "YELLOW" : "GREEN";
  const reasons: string[] = [];
  const n = rows.length;
  if (overdue >= pol.overdueRed) level = "RED";
  else if (overdue > 0) level = atLeast(level, "ORANGE");
  if (dueSoon >= pol.dueSoonOrange) level = atLeast(level, "ORANGE");
  else if (dueSoon > 0) level = atLeast(level, "YELLOW");

  if (overdue) reasons.push(`Muddati o'tgan: ${overdue} ta vazifa`);
  if (dueSoon) reasons.push(`${pol.dueSoonHours} soat ichida ${dueSoon} ta muddat`);
  if (percent >= pol.red) reasons.push(`Taxminiy ish hajmi (${round(demand)} soat) mavjud vaqtdan (${capacityHours} soat) oshadi`);
  else if (n) reasons.push(`Yuklama ${percent}%: ${round(demand)} / ${capacityHours} soat (${pol.horizonDays} ish kuni)`);
  if (blocked) reasons.push(`${blocked} ta vazifa bloklangan (tashqi javob kutilmoqda)`);
  if (missing) reasons.push(`${missing} ta vazifada baho yo'q — standart soatlar ishlatildi (aniqlik past)`);

  const summary =
    level === "RED"
      ? overdue >= pol.overdueRed ? `OVERLOADED — muddati o'tgan: ${overdue} ta vazifa` : percent >= pol.red ? "OVERLOADED — ish hajmi mavjud vaqtdan oshadi" : "HIGH WORKLOAD RISK"
      : level === "ORANGE"
        ? dueSoon >= pol.dueSoonOrange ? `Yuqori yuklama: ${dueSoon} ta muddat 24 soat ichida` : overdue ? `Muddati o'tgan vazifa bor` : `Yuqori yuklama: ${percent}%`
        : level === "YELLOW"
          ? dueSoon && percent < pol.yellow ? "Muddat yaqinlashmoqda" : `Sig'imga yaqinlashmoqda: ${n} ta faol vazifa`
          : n ? `Yuklama past: ${n} ta faol vazifa` : "Faol vazifa yo'q";
  return {
    level, percent, demandHours: round(demand), capacityHours, activeTasks: n, overdue, dueSoon, blocked,
    confidence: missing ? "low" : "high", summary, reasons,
  };
}

const round = (x: number) => Math.round(x * 10) / 10;
