// The Brain — instructions (versioned), company memory (reviewed before use), approvals, runtime settings.
import { json, now } from "../db/db.js";
import { type Actor, audit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { uid } from "../lib/ids.js";
import type { Ctx } from "./context.js";
import { getTask, transitionTask } from "./tasks.js";

// ---------------------------------------------------------------- instructions
export type Scope = "GLOBAL" | "DEPARTMENT" | "AGENT";

export interface InstructionDto {
  id: string; scope: Scope; scopeId: string | null; title: string; content: string; version: number;
  isActive: boolean; createdBy: string | null; createdAt: string;
}

const insDto = (r: Record<string, unknown>): InstructionDto => ({
  id: r.id as string, scope: r.scope as Scope, scopeId: r.scope_id as string | null, title: r.title as string,
  content: r.content as string, version: r.version as number, isActive: !!r.is_active,
  createdBy: r.created_by as string | null, createdAt: r.created_at as string,
});

export function listInstructions(ctx: Ctx, scope: Scope, scopeId: string | null, history = false): InstructionDto[] {
  return ctx.db
    .all(
      `SELECT * FROM instructions WHERE scope = ? AND COALESCE(scope_id, '') = ? ${history ? "" : "AND is_active = 1"}
       ORDER BY title, version DESC`,
      scope, scopeId ?? "",
    )
    .map(insDto);
}

/** Saving an instruction creates a new version; the previous version of the same title is kept but retired. */
export function saveInstruction(ctx: Ctx, input: { scope: Scope; scopeId: string | null; title: string; content: string }, actor: Actor): InstructionDto {
  if (input.scope === "GLOBAL" && input.scopeId) throw badRequest("Global ko'rsatma bo'lim/agentga bog'lanmaydi");
  if (input.scope !== "GLOBAL" && !input.scopeId) throw badRequest("Bo'lim yoki agent tanlanmagan");
  if (input.scope === "DEPARTMENT" && !ctx.db.get("SELECT 1 FROM departments WHERE id = ? AND business_unit_id = 'hq'", input.scopeId)) throw notFound("Bo'lim");
  if (input.scope === "AGENT" && !ctx.db.get("SELECT 1 FROM agents WHERE id = ? AND business_unit_id = 'hq'", input.scopeId)) throw notFound("Agent");
  const id = uid("ins");
  ctx.db.tx(() => {
    const prev = ctx.db.get<{ v: number | null }>(
      "SELECT MAX(version) v FROM instructions WHERE scope = ? AND COALESCE(scope_id, '') = ? AND title = ?",
      input.scope, input.scopeId ?? "", input.title,
    );
    ctx.db.run(
      "UPDATE instructions SET is_active = 0 WHERE scope = ? AND COALESCE(scope_id, '') = ? AND title = ?",
      input.scope, input.scopeId ?? "", input.title,
    );
    ctx.db.run(
      "INSERT INTO instructions (id, scope, scope_id, version, title, content, is_active, created_by, created_at) VALUES (?,?,?,?,?,?,1,?,?)",
      id, input.scope, input.scopeId, (prev?.v ?? 0) + 1, input.title, input.content, actor.type === "user" ? actor.id : null, now(),
    );
    audit(ctx.db, actor, "instruction.save", { type: "instruction", id }, { scope: input.scope, scopeId: input.scopeId, title: input.title });
  });
  return insDto(ctx.db.get("SELECT * FROM instructions WHERE id = ?", id)!);
}

export function retireInstruction(ctx: Ctx, id: string, actor: Actor) {
  const r = ctx.db.run("UPDATE instructions SET is_active = 0 WHERE id = ? AND is_active = 1", id);
  if (!r.changes) throw notFound("Faol ko'rsatma");
  audit(ctx.db, actor, "instruction.retire", { type: "instruction", id });
}

// ---------------------------------------------------------------- company memory
export type MemoryKind = "decision" | "correction" | "lesson" | "rule" | "result";
export type MemoryStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface MemoryDto {
  id: string; kind: MemoryKind; content: string; status: MemoryStatus; taskId: string | null;
  departmentId: string | null; createdBy: string | null; createdAt: string; decidedBy: string | null; decidedAt: string | null;
}

export function listMemory(ctx: Ctx, status?: MemoryStatus): MemoryDto[] {
  return ctx.db.all<MemoryDto>(
    `SELECT id, kind, content, status, task_id taskId, department_id departmentId, created_by createdBy, created_at createdAt,
            decided_by decidedBy, decided_at decidedAt
     FROM company_memory ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`,
    ...(status ? [status] : []),
  );
}

/** Agent-generated items always start PENDING; a person must approve them before agents rely on them. */
export function addMemory(
  ctx: Ctx,
  input: { kind: MemoryKind; content: string; departmentId?: string | null; taskId?: string | null; approved?: boolean },
  actor: Actor,
): MemoryDto {
  const id = uid("mem");
  const status: MemoryStatus = input.approved && actor.type === "user" ? "APPROVED" : "PENDING";
  ctx.db.run(
    `INSERT INTO company_memory (id, kind, content, task_id, department_id, created_by, created_at, status, decided_by, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, input.kind, input.content, input.taskId ?? null, input.departmentId ?? null,
    actor.type === "user" ? actor.id : null, now(), status,
    status === "APPROVED" ? actor.id : null, status === "APPROVED" ? now() : null,
  );
  audit(ctx.db, actor, "memory.add", { type: "memory", id }, { kind: input.kind, status });
  return listMemory(ctx).find((m) => m.id === id)!;
}

export function decideMemory(ctx: Ctx, id: string, decision: "APPROVED" | "REJECTED", actor: Actor) {
  const r = ctx.db.run(
    "UPDATE company_memory SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'",
    decision, actor.id, now(), id,
  );
  if (!r.changes) throw conflict("memory_decided", "Bu yozuv allaqachon ko'rib chiqilgan yoki topilmadi");
  audit(ctx.db, actor, "memory.decide", { type: "memory", id }, { decision });
}

/** Approved knowledge an agent may rely on: company-wide + its department, newest first. */
export function approvedMemory(ctx: Ctx, departmentId: string | null, limit = 12) {
  return ctx.db.all<{ kind: string; content: string }>(
    `SELECT kind, content FROM company_memory WHERE status = 'APPROVED' AND (department_id IS NULL OR department_id = ?)
     ORDER BY decided_at DESC LIMIT ?`,
    departmentId, limit,
  );
}

// ---------------------------------------------------------------- approvals
export interface ApprovalDto {
  id: string; taskId: string | null; agentId: string | null; action: string; payload: Record<string, unknown>;
  status: string; requestedAt: string; decidedBy: string | null; decidedAt: string | null; reason: string | null;
  decidedVia: string | null; taskTitle: string | null;
}

export function listApprovals(ctx: Ctx, status = "PENDING"): ApprovalDto[] {
  return ctx.db
    .all<Record<string, unknown>>(
      `SELECT a.*, t.title task_title FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN agents ag ON ag.id = a.agent_id
       WHERE a.status = ? AND COALESCE(t.business_unit_id, ag.business_unit_id, 'hq') = 'hq' ORDER BY a.requested_at DESC LIMIT 100`,
      status,
    )
    .map((r) => ({
      id: r.id as string, taskId: r.task_id as string | null, agentId: r.agent_id as string | null, action: r.action as string,
      payload: json(r.payload, {}), status: r.status as string, requestedAt: r.requested_at as string,
      decidedBy: r.decided_by as string | null, decidedAt: r.decided_at as string | null, reason: r.reason as string | null,
      decidedVia: r.decided_via as string | null, taskTitle: r.task_title as string | null,
    }));
}

export function requestApproval(ctx: Ctx, taskId: string, agentId: string, action: string, payload: Record<string, unknown>) {
  const id = uid("apr");
  ctx.db.run(
    "INSERT INTO approvals (id, task_id, agent_id, action, payload, status, requested_at) VALUES (?,?,?,?,?, 'PENDING', ?)",
    id, taskId, agentId, action, JSON.stringify(payload), now(),
  );
  const t = getTask(ctx, taskId);
  ctx.bus.emit("approval.requested", { taskId, agentId, departmentId: t.departmentId }, { approvalId: id, action, title: t.title });
  return id;
}

/**
 * Human decision on a pending approval. Approve → task DONE. Reject → task goes back to the queue with the
 * reviewer's feedback appended, and the feedback is proposed to company memory as a correction (pending review).
 */
export function decideApproval(
  ctx: Ctx, id: string, decision: "approve" | "reject", reason: string | undefined, actor: Actor, via: "web" | "telegram",
) {
  const a = ctx.db.get<{ id: string; task_id: string; status: string }>("SELECT id, task_id, status FROM approvals WHERE id = ?", id);
  if (!a) throw notFound("Tasdiq so'rovi");
  if (a.status !== "PENDING") throw conflict("approval_decided", "Bu so'rov allaqachon hal qilingan");
  if (decision === "reject" && !reason?.trim()) throw badRequest("Rad etish sababini yozing — agent shu asosda qayta ishlaydi");
  const task = getTask(ctx, a.task_id);
  ctx.db.tx(() => {
    const r = ctx.db.run(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ?, decided_via = ? WHERE id = ? AND status = 'PENDING'",
      decision === "approve" ? "APPROVED" : "REJECTED", actor.type === "user" ? actor.id : null, now(), reason ?? null, via, id,
    );
    if (r.changes !== 1) throw conflict("approval_decided", "Bu so'rov allaqachon hal qilingan");
    if (decision === "approve") {
      transitionTask(ctx, task.id, "DONE", actor, { reason: `approved via ${via}` });
    } else {
      ctx.db.run(
        "UPDATE tasks SET description = description || ? WHERE id = ?",
        `\n\n[Tuzatish talabi (${now().slice(0, 16)})]: ${reason}`, task.id,
      );
      transitionTask(ctx, task.id, "QUEUED", actor, { reason: `rejected via ${via}` });
      addMemory(ctx, { kind: "correction", content: `"${task.title}" bo'yicha tuzatish: ${reason}`, departmentId: task.departmentId, taskId: task.id }, actor);
    }
    audit(ctx.db, actor, "approval.decide", { type: "approval", id }, { decision, via, taskId: task.id });
  });
  return getTask(ctx, task.id);
}

// ---------------------------------------------------------------- settings
export function getSetting<T>(ctx: Ctx, key: string, fallback: T): T {
  const r = ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return r ? json<T>(r.value, fallback) : fallback;
}

export function setSetting(ctx: Ctx, key: string, value: unknown, actor: Actor) {
  ctx.db.run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    key, JSON.stringify(value), actor.type === "user" ? actor.id : null, now(),
  );
  audit(ctx.db, actor, "settings.set", { type: "setting", id: key }, { value });
}
