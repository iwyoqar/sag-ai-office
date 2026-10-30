import type { DeptStats, StatsRange } from "@sag/shared";
import { ACTIVE_AGENT_STATUSES } from "@sag/shared";
import { badRequest } from "../lib/errors.js";
import type { Ctx } from "./context.js";

export const TZ = "Asia/Tashkent";
const TZ_OFFSET_MIN = 5 * 60; // Asia/Tashkent is UTC+5 with no DST.

/** Start of "today" in Tashkent, as a UTC ISO string. */
export function startOfTashkentDay(at = new Date()): Date {
  const local = new Date(at.getTime() + TZ_OFFSET_MIN * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - TZ_OFFSET_MIN * 60_000);
}

export function resolveRange(range: StatsRange, from?: string, to?: string, at = new Date()): { from: string; to: string } {
  if (range === "custom") {
    if (!from || !to) throw badRequest("custom oraliq uchun from va to kerak (YYYY-MM-DD)");
    const f = startOfTashkentDay(new Date(`${from}T12:00:00Z`));
    const t = new Date(startOfTashkentDay(new Date(`${to}T12:00:00Z`)).getTime() + 86_400_000);
    if (!(f < t)) throw badRequest("from to'dan oldin bo'lishi kerak");
    return { from: f.toISOString(), to: t.toISOString() };
  }
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  const start = new Date(startOfTashkentDay(at).getTime() - (days - 1) * 86_400_000);
  // `to` is exclusive; pad "now" so records written in the same millisecond are counted.
  return { from: start.toISOString(), to: new Date(at.getTime() + 1000).toISOString() };
}

/** Per-department stats. Snapshot values (agents, in progress, queued…) are "now"; volumes are for the range. */
export function departmentStats(ctx: Ctx, range: { from: string; to: string }): DeptStats[] {
  const { db } = ctx;
  const deps = db.all<{ id: string }>("SELECT id FROM departments WHERE business_unit_id = 'hq' ORDER BY sort");
  const agents = db.all<{ department_id: string; status: string; lifecycle: string }>(
    "SELECT department_id, status, lifecycle FROM agents WHERE lifecycle <> 'ARCHIVED' AND business_unit_id = 'hq'",
  );
  const live = db.all<{ department_id: string; status: string; n: number }>(
    "SELECT department_id, status, COUNT(*) n FROM tasks WHERE business_unit_id = 'hq' AND kind <> 'human' AND status IN ('IN_PROGRESS','QUEUED','WAITING_APPROVAL') GROUP BY department_id, status",
  );
  const closed = db.all<{ department_id: string; status: string; started_at: string | null; completed_at: string }>(
    "SELECT department_id, status, started_at, completed_at FROM tasks WHERE business_unit_id = 'hq' AND kind <> 'human' AND status IN ('DONE','FAILED') AND completed_at >= ? AND completed_at < ?",
    range.from, range.to,
  );
  const usage = db.all<{ department_id: string; tokens: number; cost: number }>(
    `SELECT department_id, COALESCE(SUM(input_tokens + output_tokens),0) tokens, COALESCE(SUM(cost_usd),0) cost
     FROM usage_records WHERE created_at >= ? AND created_at < ?
       AND department_id IN (SELECT id FROM departments WHERE business_unit_id = 'hq') GROUP BY department_id`,
    range.from, range.to,
  );
  const liveCount = (d: string, s: string) => live.find((x) => x.department_id === d && x.status === s)?.n ?? 0;

  return deps.map(({ id }) => {
    const ag = agents.filter((a) => a.department_id === id);
    const done = closed.filter((c) => c.department_id === id && c.status === "DONE");
    const durations = done.filter((c) => c.started_at).map((c) => (Date.parse(c.completed_at) - Date.parse(c.started_at!)) / 60_000);
    const u = usage.find((x) => x.department_id === id);
    return {
      departmentId: id,
      agents: ag.length,
      active: ag.filter((a) => (ACTIVE_AGENT_STATUSES as readonly string[]).includes(a.status)).length,
      idle: ag.filter((a) => a.status === "IDLE" && a.lifecycle === "ACTIVE").length,
      inProgress: liveCount(id, "IN_PROGRESS"),
      queued: liveCount(id, "QUEUED"),
      waitingApproval: liveCount(id, "WAITING_APPROVAL"),
      completed: done.length,
      errors: closed.filter((c) => c.department_id === id && c.status === "FAILED").length + ag.filter((a) => a.status === "ERROR").length,
      avgMinutes: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
      tokens: u?.tokens ?? 0,
      costUsd: Math.round((u?.cost ?? 0) * 10000) / 10000,
    };
  });
}
