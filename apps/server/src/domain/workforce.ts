// The AI workforce of a unit, as the AI Director sees it: who the director is, which active agents can take a piece
// of work (by skills, role and current load — never an agent of another unit, never a paused or archived one), and
// the live state shown on the workforce dashboard. Real rows only: no estimated progress.
import { OPEN_TASK_STATUSES } from "@sag/shared";
import { json } from "../db/db.js";
import type { Ctx } from "./context.js";
import { ORCHESTRATOR_DEPARTMENT } from "./tasks.js";

const OPEN = OPEN_TASK_STATUSES.map((s) => `'${s}'`).join(",");

export interface DirectorSettings {
  agentId: string | null; provider: "gemini" | "anthropic" | null; model: string | null;
  maxSubtasks: number; maxRevisions: number; maxAiHireRequests: number; budgetAlertPct: number;
}

export function directorSettings(ctx: Ctx, unitId = "hq"): DirectorSettings {
  const r = ctx.db.get<{ agent_id: string | null; provider: DirectorSettings["provider"]; model: string | null; max_subtasks: number; max_revisions: number; max_ai_hire_requests: number; budget_alert_pct: number }>(
    "SELECT * FROM ai_director_settings WHERE business_unit_id = ?", unitId,
  );
  return {
    agentId: r?.agent_id ?? null, provider: r?.provider ?? null, model: r?.model ?? null,
    maxSubtasks: r?.max_subtasks ?? 6, maxRevisions: r?.max_revisions ?? 2, maxAiHireRequests: r?.max_ai_hire_requests ?? 3,
    budgetAlertPct: r?.budget_alert_pct ?? 80,
  };
}

/** The unit's AI Director: the configured agent if active, else HQ's active orchestrator-department agent. */
export function directorAgent(ctx: Ctx, unitId = "hq"): string | null {
  const s = directorSettings(ctx, unitId);
  if (s.agentId && ctx.db.get("SELECT 1 FROM agents WHERE id = ? AND lifecycle = 'ACTIVE' AND business_unit_id = ?", s.agentId, unitId)) return s.agentId;
  return ctx.db.get<{ id: string }>(
    "SELECT id FROM agents WHERE department_id = ? AND business_unit_id = ? AND lifecycle = 'ACTIVE' ORDER BY created_at LIMIT 1",
    ORCHESTRATOR_DEPARTMENT, unitId,
  )?.id ?? null;
}

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));

export interface AgentChoice { agentId: string; score: number; reason: string }

/**
 * Best active agent of the unit for a piece of work: skills/role/responsibilities overlap with the required skills
 * and the title, preferring the planned department, then the least loaded. Null when nobody fits — the caller asks
 * for a hire instead of handing the work to an unsuitable agent.
 */
export function selectAgent(
  ctx: Ctx, i: { unitId: string; departmentId?: string | null; skills: string[]; title: string; exclude?: string[]; planned?: Map<string, number> },
): AgentChoice | null {
  const rows = ctx.db.all<{ id: string; name: string; role: string; department_id: string; skills: string; responsibilities: string; open: number }>(
    `SELECT a.id, a.name, a.role, a.department_id, a.skills, a.responsibilities,
       (SELECT COUNT(*) FROM tasks t WHERE t.agent_id = a.id AND t.status IN (${OPEN})) open
     FROM agents a WHERE a.business_unit_id = ? AND a.lifecycle = 'ACTIVE' AND a.department_id <> ?`,
    i.unitId, ORCHESTRATOR_DEPARTMENT,
  ).filter((a) => !(i.exclude ?? []).includes(a.id));
  const want = new Set([...i.skills.flatMap((s) => [...words(s)]), ...words(i.title)]);
  let best: AgentChoice | null = null;
  for (const a of rows) {
    const have = words(`${a.role} ${a.responsibilities} ${json<string[]>(a.skills, []).join(" ")}`);
    const hits = [...want].filter((w) => have.has(w) || [...have].some((h) => h.length > 4 && (h.startsWith(w) || w.startsWith(h))));
    const inDept = !!i.departmentId && a.department_id === i.departmentId;
    // a department match alone is enough to qualify; outside the department the agent needs a skill match
    if (!inDept && !hits.length) continue;
    // work already given out in the same plan counts as load, so pieces spread across suitable agents
    const load = a.open + (i.planned?.get(a.id) ?? 0);
    const score = hits.length * 10 + (inDept ? 15 : 0) - load * 3;
    if (!best || score > best.score)
      best = { agentId: a.id, score, reason: `${a.name} (${a.role})${hits.length ? `: ${hits.slice(0, 4).join(", ")}` : ""}${inDept ? " — bo'limi mos" : ""}${a.open ? `, ${a.open} ta ochiq vazifa` : ""}` };
  }
  return best;
}

// ---------------------------------------------------------------- dashboard state

export interface WorkforceState {
  director: { agentId: string | null; name: string | null; provider: string | null; model: string | null; limits: Omit<DirectorSettings, "agentId" | "provider" | "model"> };
  templates: number;
  agents: { active: number; available: number; busy: number; suspended: number; archived: number };
  hireRequestsPending: number;
  tasks: { running: number; waiting: number; completed: number; failed: number; blocked: number };
  usage: { tokensIn: number; tokensOut: number; costUsd: number; byProvider: { provider: string; tokens: number; costUsd: number; runs: number }[]; mock: number };
  projects: ProjectView[];
}

export interface ProjectView {
  id: string; title: string; status: string; stage: string | null; error: string | null; createdAt: string; costUsd: number; tokens: number;
  plan: { objective?: string; expectedOutcome?: string; requiredSkills?: string[] } | null;
  subtasks: {
    id: string; title: string; status: string; stage: string | null; error: string | null; agent: string | null; dependsOn: string[];
    revisionOf: string | null; verdict: string | null; issues: string[];
  }[];
  approvals: number;
  hireRequests: { templateName: string; status: string; departmentId: string }[];
}

/** Real counts for the unit (terminal tasks of the last 30 days; projects = orchestrated jobs, newest first). */
export function workforceState(ctx: Ctx, unitId = "hq"): WorkforceState {
  const s = directorSettings(ctx, unitId);
  const dir = directorAgent(ctx, unitId);
  const n = (sql: string, ...p: (string | number)[]) => ctx.db.get<{ n: number }>(sql, ...p)!.n;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const active = n("SELECT COUNT(*) n FROM agents WHERE business_unit_id = ? AND lifecycle = 'ACTIVE'", unitId);
  const busy = n(`SELECT COUNT(*) n FROM agents a WHERE a.business_unit_id = ? AND a.lifecycle = 'ACTIVE' AND EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status = 'IN_PROGRESS')`, unitId);
  const byProvider = ctx.db.all<{ provider: string | null; tokens: number; cost: number; runs: number }>(
    `SELECT u.provider, SUM(u.input_tokens + u.output_tokens) tokens, SUM(u.cost_usd) cost, COUNT(*) runs
     FROM usage_records u JOIN tasks t ON t.id = u.task_id WHERE t.business_unit_id = ? AND u.created_at >= ? GROUP BY u.provider`, unitId, since,
  );
  const tot = ctx.db.get<{ tin: number; tout: number; cost: number }>(
    `SELECT COALESCE(SUM(u.input_tokens), 0) tin, COALESCE(SUM(u.output_tokens), 0) tout, COALESCE(SUM(u.cost_usd), 0) cost
     FROM usage_records u JOIN tasks t ON t.id = u.task_id WHERE t.business_unit_id = ? AND u.created_at >= ?`, unitId, since,
  )!;
  const projects = ctx.db.all<{ id: string; title: string; status: string; stage: string | null; error: string | null; created_at: string; plan: string | null }>(
    "SELECT id, title, status, stage, error, created_at, plan FROM tasks WHERE business_unit_id = ? AND kind = 'orchestrate' ORDER BY created_at DESC LIMIT 10", unitId,
  ).map((p): ProjectView => {
    const fam = ctx.db.get<{ cost: number; tok: number }>("SELECT COALESCE(SUM(cost_usd), 0) cost, COALESCE(SUM(tokens_in + tokens_out), 0) tok FROM tasks WHERE id = ? OR parent_id = ?", p.id, p.id)!;
    const kids = ctx.db.all<{ id: string; title: string; status: string; stage: string | null; error: string | null; agent: string | null; revision_of: string | null; verdict: string | null; issues: string | null }>(
      `SELECT t.id, t.title, t.status, t.stage, t.error, a.name agent, t.revision_of, e.verdict, e.issues
       FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN task_evaluations e ON e.task_id = t.id
       WHERE t.parent_id = ? ORDER BY t.created_at`, p.id,
    );
    return {
      id: p.id, title: p.title, status: p.status, stage: p.stage, error: p.error, createdAt: p.created_at, costUsd: fam.cost, tokens: fam.tok,
      plan: p.plan ? json(p.plan, null) : null,
      subtasks: kids.map((k) => ({
        id: k.id, title: k.title, status: k.status, stage: k.stage, error: k.error, agent: k.agent, revisionOf: k.revision_of, verdict: k.verdict,
        issues: json<string[]>(k.issues ?? "[]", []),
        dependsOn: ctx.db.all<{ d: string }>("SELECT depends_on_id d FROM task_dependencies WHERE task_id = ?", k.id).map((r) => r.d),
      })),
      approvals: n("SELECT COUNT(*) n FROM approvals WHERE status = 'PENDING' AND task_id IN (SELECT id FROM tasks WHERE id = ? OR parent_id = ?)", p.id, p.id),
      hireRequests: ctx.db.all<{ templateName: string; status: string; departmentId: string }>(
        `SELECT t.name templateName, h.status, h.department_id departmentId FROM agent_hire_requests h JOIN agent_templates t ON t.id = h.template_id
         WHERE h.requested_by_type = 'agent' AND h.created_at >= ? AND h.justification LIKE ?`, p.created_at, `%${p.title.slice(0, 60)}%`,
      ),
    };
  });
  return {
    director: {
      agentId: dir, name: dir ? ctx.db.get<{ name: string }>("SELECT name FROM agents WHERE id = ?", dir)?.name ?? null : null,
      provider: s.provider, model: s.model,
      limits: { maxSubtasks: s.maxSubtasks, maxRevisions: s.maxRevisions, maxAiHireRequests: s.maxAiHireRequests, budgetAlertPct: s.budgetAlertPct },
    },
    templates: n("SELECT COUNT(*) n FROM agent_templates WHERE business_unit_id = ? AND status = 'APPROVED'", unitId),
    agents: {
      active, busy, available: active - busy,
      suspended: n("SELECT COUNT(*) n FROM agents WHERE business_unit_id = ? AND lifecycle = 'PAUSED'", unitId),
      archived: n("SELECT COUNT(*) n FROM agents WHERE business_unit_id = ? AND lifecycle = 'ARCHIVED'", unitId),
    },
    hireRequestsPending: n("SELECT COUNT(*) n FROM agent_hire_requests WHERE business_unit_id = ? AND status = 'PENDING'", unitId),
    tasks: {
      running: n("SELECT COUNT(*) n FROM tasks WHERE business_unit_id = ? AND status = 'IN_PROGRESS'", unitId),
      waiting: n("SELECT COUNT(*) n FROM tasks WHERE business_unit_id = ? AND status IN ('QUEUED','WAITING_FOR_DEPENDENCY','WAITING_APPROVAL')", unitId),
      completed: n("SELECT COUNT(*) n FROM tasks WHERE business_unit_id = ? AND status = 'DONE' AND updated_at >= ?", unitId, since),
      failed: n("SELECT COUNT(*) n FROM tasks WHERE business_unit_id = ? AND status = 'FAILED' AND updated_at >= ?", unitId, since),
      blocked: n("SELECT COUNT(*) n FROM tasks WHERE business_unit_id = ? AND status = 'BLOCKED'", unitId),
    },
    usage: {
      tokensIn: tot.tin, tokensOut: tot.tout, costUsd: tot.cost,
      byProvider: byProvider.map((r) => ({ provider: r.provider ?? "noma'lum", tokens: r.tokens, costUsd: r.cost, runs: r.runs })),
      mock: n("SELECT COUNT(*) n FROM agent_runs r JOIN tasks t ON t.id = r.task_id WHERE t.business_unit_id = ? AND r.mode = 'mock' AND r.started_at >= ?", unitId, since),
    },
    projects,
  };
}
