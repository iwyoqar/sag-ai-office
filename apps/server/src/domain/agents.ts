import type { AgentLifecycle, AgentStatus } from "@sag/shared";
import { OPEN_TASK_STATUSES } from "@sag/shared";
import { json, now } from "../db/db.js";
import { type Actor, audit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { slug, uid } from "../lib/ids.js";
import type { Ctx } from "./context.js";
import { getDepartment } from "./org.js";

export type { AgentDto } from "@sag/shared";
import type { AgentDto } from "@sag/shared";

interface AgentRow {
  id: string; name: string; role: string; department_id: string; status: AgentStatus; lifecycle: AgentLifecycle;
  model: string | null; skills: string; responsibilities: string; max_tokens_per_task: number | null;
  max_cost_per_task_usd: number | null; created_at: string; updated_at: string; archived_at: string | null;
  workstation: number | null;
}

const OPEN = OPEN_TASK_STATUSES.map((s) => `'${s}'`).join(",");

function toDto(ctx: Ctx, a: AgentRow): AgentDto {
  const current = ctx.db.get<{ id: string; title: string; status: string; progress: number | null; stage: string | null }>(
    `SELECT id, title, status, progress, stage FROM tasks WHERE agent_id = ? AND status IN (${OPEN})
     ORDER BY CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'WAITING_APPROVAL' THEN 1 ELSE 2 END, created_at LIMIT 1`,
    a.id,
  );
  const open = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM tasks WHERE agent_id = ? AND status IN (${OPEN})`, a.id)!.n;
  return {
    id: a.id, name: a.name, role: a.role, departmentId: a.department_id, status: a.status, lifecycle: a.lifecycle,
    model: a.model, skills: json(a.skills, []), responsibilities: a.responsibilities,
    maxTokensPerTask: a.max_tokens_per_task, maxCostPerTaskUsd: a.max_cost_per_task_usd,
    createdAt: a.created_at, updatedAt: a.updated_at, archivedAt: a.archived_at, workstation: a.workstation,
    currentTask: current ?? null, openTasks: open,
  };
}

/** Smallest desk index not used by a non-archived agent of the department. */
export function nextWorkstation(ctx: Ctx, departmentId: string): number {
  const used = new Set(
    ctx.db
      .all<{ workstation: number }>(
        "SELECT workstation FROM agents WHERE department_id = ? AND lifecycle <> 'ARCHIVED' AND workstation IS NOT NULL", departmentId,
      )
      .map((r) => r.workstation),
  );
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

function row(ctx: Ctx, id: string): AgentRow {
  const a = ctx.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  if (!a) throw notFound("Agent");
  return a;
}

export function listAgents(ctx: Ctx, f: { departmentId?: string; includeArchived?: boolean } = {}): AgentDto[] {
  // company-wide list = HQ agents; store AI Directors are served through their unit
  const where = ["business_unit_id = 'hq'"];
  const p: string[] = [];
  if (f.departmentId) {
    where.push("department_id = ?");
    p.push(f.departmentId);
  }
  if (!f.includeArchived) where.push("lifecycle <> 'ARCHIVED'");
  return ctx.db.all<AgentRow>(`SELECT * FROM agents WHERE ${where.join(" AND ")} ORDER BY department_id, created_at`, ...p).map((a) => toDto(ctx, a));
}

export function getAgent(ctx: Ctx, id: string): AgentDto {
  return toDto(ctx, row(ctx, id));
}

/** Profile = agent + history, usage, connectors, recent errors, active instructions. */
export function getAgentProfile(ctx: Ctx, id: string) {
  const agent = getAgent(ctx, id);
  const { db } = ctx;
  const recentTasks = db.all(
    `SELECT id, title, status, completed_at completedAt, updated_at updatedAt FROM tasks
     WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 10`, id,
  );
  const usage = db.get<{ tin: number; tout: number; cost: number; runs: number }>(
    `SELECT COALESCE(SUM(input_tokens),0) tin, COALESCE(SUM(output_tokens),0) tout, COALESCE(SUM(cost_usd),0) cost, COUNT(*) runs
     FROM usage_records WHERE agent_id = ?`, id,
  )!;
  const errors = db.all(
    `SELECT id taskId, title, error, updated_at at FROM tasks WHERE agent_id = ? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 5`, id,
  );
  const deptConnectors = getDepartment(ctx, agent.departmentId).connectors;
  const grants = db.all<{ connector_id: string; allowed_actions: string }>(
    "SELECT connector_id, allowed_actions FROM agent_connector_permissions WHERE agent_id = ?", id,
  );
  const connectors = db
    .all<{ id: string; name: string; status: string; auth_status: string }>("SELECT id, name, status, auth_status FROM connectors")
    .filter((c) => deptConnectors.includes(c.id))
    .map((c) => {
      const g = grants.find((x) => x.connector_id === c.id);
      return { id: c.id, name: c.name, status: c.status, authStatus: c.auth_status, granted: !!g, allowedActions: g ? json(g.allowed_actions, []) : [] };
    });
  const instructions = db.all(
    `SELECT id, scope, title, version, content FROM instructions
     WHERE is_active = 1 AND (scope = 'GLOBAL' OR (scope = 'DEPARTMENT' AND scope_id = ?) OR (scope = 'AGENT' AND scope_id = ?))
     ORDER BY CASE scope WHEN 'GLOBAL' THEN 0 WHEN 'DEPARTMENT' THEN 1 ELSE 2 END`,
    agent.departmentId, id,
  );
  return {
    agent, recentTasks, connectors, instructions, errors,
    usage: { inputTokens: usage.tin, outputTokens: usage.tout, costUsd: usage.cost, runs: usage.runs },
  };
}

export interface AgentInput {
  name: string; role: string; departmentId: string; model?: string | null; skills?: string[];
  responsibilities?: string; instructions?: string; connectorIds?: string[];
  maxTokensPerTask?: number | null; maxCostPerTaskUsd?: number | null;
}

function checkConnectors(ctx: Ctx, departmentId: string, ids: string[]) {
  const allowed = getDepartment(ctx, departmentId).connectors;
  const bad = ids.filter((c) => !allowed.includes(c));
  // An agent can never hold a connector its department is not allowed to use.
  if (bad.length) throw badRequest(`Bu connectorlar bo'limga ruxsat etilmagan: ${bad.join(", ")}`, { connectors: bad });
}

export function createAgent(ctx: Ctx, input: AgentInput, actor: Actor): AgentDto {
  const dep = getDepartment(ctx, input.departmentId);
  if (!dep.isActive) throw badRequest("Bo'lim faol emas");
  checkConnectors(ctx, dep.id, input.connectorIds ?? []);
  const t = now();
  let id = `${dep.id}-${slug(input.name) || "agent"}`;
  if (ctx.db.get("SELECT id FROM agents WHERE id = ?", id)) id = uid(dep.id);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO agents (id, name, role, department_id, workstation, model, skills, responsibilities, max_tokens_per_task, max_cost_per_task_usd, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.name, input.role, dep.id, nextWorkstation(ctx, dep.id), input.model ?? null, JSON.stringify(input.skills ?? []), input.responsibilities ?? "",
      input.maxTokensPerTask ?? null, input.maxCostPerTaskUsd ?? null, t, t,
    );
    for (const c of input.connectorIds ?? [])
      ctx.db.run("INSERT INTO agent_connector_permissions (agent_id, connector_id, allowed_actions) VALUES (?, ?, '[\"read\"]')", id, c);
    if (input.instructions?.trim())
      ctx.db.run(
        "INSERT INTO instructions (id, scope, scope_id, version, title, content, created_by, created_at) VALUES (?, 'AGENT', ?, 1, 'Agent ko''rsatmasi', ?, ?, ?)",
        uid("ins"), id, input.instructions.trim(), actor.id, t,
      );
    audit(ctx.db, actor, "agent.create", { type: "agent", id }, { name: input.name, role: input.role, departmentId: dep.id });
  });
  ctx.bus.emit("agent.updated", { agentId: id, departmentId: dep.id }, { change: "created" }, actor.id);
  return getAgent(ctx, id);
}

export function updateAgent(
  ctx: Ctx, id: string,
  patch: Partial<Pick<AgentInput, "name" | "role" | "model" | "skills" | "responsibilities" | "maxTokensPerTask" | "maxCostPerTaskUsd">>,
  actor: Actor,
): AgentDto {
  const a = row(ctx, id);
  if (a.lifecycle === "ARCHIVED") throw conflict("agent_archived", "Arxivlangan agentni tahrirlab bo'lmaydi");
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const map: Record<string, string> = {
    name: "name", role: "role", model: "model", responsibilities: "responsibilities",
    maxTokensPerTask: "max_tokens_per_task", maxCostPerTaskUsd: "max_cost_per_task_usd",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      sets.push(`${col} = ?`);
      vals.push((patch as Record<string, string | number | null>)[k] ?? null);
    }
  }
  if (patch.skills) {
    sets.push("skills = ?");
    vals.push(JSON.stringify(patch.skills));
  }
  if (!sets.length) return getAgent(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE agents SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...vals, now(), id);
    audit(ctx.db, actor, "agent.update", { type: "agent", id }, patch);
  });
  ctx.bus.emit("agent.updated", { agentId: id, departmentId: a.department_id }, { change: "updated", fields: Object.keys(patch) }, actor.id);
  return getAgent(ctx, id);
}

/** Grants: read for every listed connector; `writeIds` (a subset) may also propose write actions (still approved per call). */
export function setAgentConnectors(ctx: Ctx, id: string, connectorIds: string[], actor: Actor, writeIds: string[] = []) {
  const a = row(ctx, id);
  checkConnectors(ctx, a.department_id, connectorIds);
  const write = new Set(writeIds.filter((w) => connectorIds.includes(w)));
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM agent_connector_permissions WHERE agent_id = ?", id);
    for (const c of connectorIds)
      ctx.db.run("INSERT INTO agent_connector_permissions (agent_id, connector_id, allowed_actions) VALUES (?, ?, ?)", id, c, JSON.stringify(write.has(c) ? ["read", "write"] : ["read"]));
    audit(ctx.db, actor, "agent.connectors.set", { type: "agent", id }, { connectorIds, writeIds: [...write] });
  });
  ctx.bus.emit("agent.updated", { agentId: id, departmentId: a.department_id }, { change: "connectors" }, actor.id);
  return getAgentProfile(ctx, id);
}

export function setLifecycle(ctx: Ctx, id: string, to: "ACTIVE" | "PAUSED", actor: Actor): AgentDto {
  const a = row(ctx, id);
  if (a.lifecycle === "ARCHIVED") throw conflict("agent_archived", "Agent arxivlangan");
  if (a.lifecycle === to) return getAgent(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE agents SET lifecycle = ?, updated_at = ? WHERE id = ?", to, now(), id);
    audit(ctx.db, actor, to === "PAUSED" ? "agent.pause" : "agent.resume", { type: "agent", id });
  });
  ctx.bus.emit(to === "PAUSED" ? "agent.paused" : "agent.resumed", { agentId: id, departmentId: a.department_id }, {}, actor.id);
  return getAgent(ctx, id);
}

/**
 * Stop: aborts only this agent's in-flight work. Its in-progress tasks become BLOCKED (retryable / reassignable),
 * the agent goes back to IDLE. Parent tasks and other agents are untouched.
 */
export function stopAgent(ctx: Ctx, id: string, actor: Actor) {
  const a = row(ctx, id);
  const t = now();
  const stopped = ctx.db.tx(() => {
    const ids = ctx.db
      .all<{ id: string }>("SELECT id FROM tasks WHERE agent_id = ? AND status IN ('IN_PROGRESS', 'WAITING_APPROVAL')", id)
      .map((r) => r.id);
    for (const tid of ids)
      ctx.db.run(
        `UPDATE tasks SET status = 'BLOCKED', error = 'Foydalanuvchi agentni to''xtatdi', lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE id = ? AND status IN ('IN_PROGRESS', 'WAITING_APPROVAL')`, t, tid,
      );
    ctx.db.run("UPDATE agents SET status = 'IDLE', updated_at = ? WHERE id = ?", t, id);
    audit(ctx.db, actor, "agent.stop", { type: "agent", id }, { tasks: ids });
    return ids;
  });
  for (const tid of stopped)
    ctx.bus.emit("task.status", { taskId: tid, agentId: id, departmentId: a.department_id }, { to: "BLOCKED", reason: "agent stopped" }, actor.id);
  ctx.bus.emit("agent.status", { agentId: id, departmentId: a.department_id }, { status: "IDLE" }, actor.id);
  return { agent: getAgent(ctx, id), stoppedTasks: stopped };
}

export type OpenTaskStrategy = { strategy: "reassign"; toAgentId: string } | { strategy: "cancel" };

function openTasksOf(ctx: Ctx, id: string) {
  return ctx.db.all<{ id: string; title: string; status: string }>(
    `SELECT id, title, status FROM tasks WHERE agent_id = ? AND status IN (${OPEN})`, id,
  );
}

function resolveOpenTasks(ctx: Ctx, id: string, how: OpenTaskStrategy | undefined, actor: Actor, newDeptId?: string) {
  const open = openTasksOf(ctx, id);
  if (!open.length) return [];
  if (!how)
    throw conflict("agent_has_open_tasks", "Agentda ochiq vazifalar bor. Ularni boshqa agentga topshiring yoki bekor qiling.", { tasks: open });
  const t = now();
  if (how.strategy === "reassign") {
    const to = row(ctx, how.toAgentId);
    if (to.id === id) throw badRequest("Vazifani o'sha agentning o'ziga topshirib bo'lmaydi");
    if (to.lifecycle !== "ACTIVE") throw badRequest("Qabul qiluvchi agent faol emas");
    if (newDeptId && to.department_id !== newDeptId && to.department_id !== row(ctx, id).department_id)
      throw badRequest("Qabul qiluvchi agent mos bo'limda emas");
    for (const task of open) {
      // In-flight work restarts under the new owner.
      ctx.db.run(
        `UPDATE tasks SET agent_id = ?, department_id = ?, lease_owner = NULL, lease_until = NULL,
           status = CASE WHEN status IN ('IN_PROGRESS','WAITING_APPROVAL','BLOCKED') THEN 'QUEUED' ELSE status END, updated_at = ?
         WHERE id = ?`, to.id, to.department_id, t, task.id,
      );
    }
    audit(ctx.db, actor, "tasks.reassign_bulk", { type: "agent", id }, { to: to.id, tasks: open.map((x) => x.id) });
  } else {
    for (const task of open)
      ctx.db.run("UPDATE tasks SET status = 'CANCELLED', completed_at = ?, updated_at = ? WHERE id = ?", t, t, task.id);
    audit(ctx.db, actor, "tasks.cancel_bulk", { type: "agent", id }, { tasks: open.map((x) => x.id) });
  }
  return open.map((x) => x.id);
}

/** Archive ("fire"): stops new work, keeps all history. Open tasks must be reassigned or cancelled. */
export function archiveAgent(ctx: Ctx, id: string, how: OpenTaskStrategy | undefined, actor: Actor) {
  const a = row(ctx, id);
  if (a.lifecycle === "ARCHIVED") return { agent: getAgent(ctx, id), affectedTasks: [] };
  const t = now();
  const affected = ctx.db.tx(() => {
    const ids = resolveOpenTasks(ctx, id, how, actor);
    ctx.db.run("UPDATE agents SET lifecycle = 'ARCHIVED', status = 'IDLE', workstation = NULL, archived_at = ?, updated_at = ? WHERE id = ?", t, t, id);
    audit(ctx.db, actor, "agent.archive", { type: "agent", id }, { strategy: how?.strategy ?? "none" });
    return ids;
  });
  for (const tid of affected) ctx.bus.emit("task.updated", { taskId: tid }, { change: how?.strategy }, actor.id);
  ctx.bus.emit("agent.updated", { agentId: id, departmentId: a.department_id }, { change: "archived" }, actor.id);
  return { agent: getAgent(ctx, id), affectedTasks: affected };
}

export function transferAgent(ctx: Ctx, id: string, departmentId: string, how: OpenTaskStrategy | undefined, actor: Actor) {
  const a = row(ctx, id);
  if (a.lifecycle === "ARCHIVED") throw conflict("agent_archived", "Agent arxivlangan");
  if (a.department_id === departmentId) return { agent: getAgent(ctx, id), affectedTasks: [] };
  const dep = getDepartment(ctx, departmentId);
  const affected = ctx.db.tx(() => {
    const ids = resolveOpenTasks(ctx, id, how, actor, dep.id);
    ctx.db.run("UPDATE agents SET department_id = ?, workstation = ?, updated_at = ? WHERE id = ?", dep.id, nextWorkstation(ctx, dep.id), now(), id);
    // Grants the new department does not allow are dropped.
    ctx.db.run(
      `DELETE FROM agent_connector_permissions WHERE agent_id = ?
       AND connector_id NOT IN (SELECT connector_id FROM department_connectors WHERE department_id = ?)`, id, dep.id,
    );
    audit(ctx.db, actor, "agent.transfer", { type: "agent", id }, { from: a.department_id, to: dep.id });
    return ids;
  });
  ctx.bus.emit("agent.updated", { agentId: id, departmentId: dep.id }, { change: "transferred", from: a.department_id }, actor.id);
  return { agent: getAgent(ctx, id), affectedTasks: affected };
}
