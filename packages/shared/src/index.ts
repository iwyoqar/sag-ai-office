// Single source of truth for statuses and their allowed transitions (server + web).

export const AGENT_STATUSES = [
  "IDLE", "WORKING", "THINKING", "COMMUNICATING",
  "WAITING_APPROVAL", "BLOCKED", "ERROR", "COMPLETED",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Whether the agent accepts work at all (HR / admin controlled). Independent of AgentStatus. */
export const AGENT_LIFECYCLES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];

export const ACTIVE_AGENT_STATUSES: readonly AgentStatus[] = ["WORKING", "THINKING", "COMMUNICATING"];

export const TASK_STATUSES = [
  "BACKLOG", "QUEUED", "IN_PROGRESS", "WAITING_FOR_DEPENDENCY",
  "WAITING_APPROVAL", "BLOCKED", "FAILED", "DONE", "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["DONE", "FAILED", "CANCELLED"];
/** Tasks that still belong to an agent's workload. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  "BACKLOG", "QUEUED", "IN_PROGRESS", "WAITING_FOR_DEPENDENCY", "WAITING_APPROVAL", "BLOCKED",
];

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  BACKLOG: ["QUEUED", "CANCELLED"],
  QUEUED: ["IN_PROGRESS", "WAITING_FOR_DEPENDENCY", "BACKLOG", "CANCELLED"],
  IN_PROGRESS: ["WAITING_APPROVAL", "WAITING_FOR_DEPENDENCY", "BLOCKED", "FAILED", "DONE", "CANCELLED", "QUEUED"],
  WAITING_FOR_DEPENDENCY: ["QUEUED", "BLOCKED", "CANCELLED"],
  // approved → DONE; rejected → QUEUED (rework with feedback)
  WAITING_APPROVAL: ["DONE", "IN_PROGRESS", "QUEUED", "FAILED", "CANCELLED"],
  BLOCKED: ["QUEUED", "FAILED", "CANCELLED"],
  // A failed task can be retried; done/cancelled are final.
  FAILED: ["QUEUED"],
  DONE: [],
  CANCELLED: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function allowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const ROLES = ["admin", "director", "hr", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "tasks:read", "tasks:create", "tasks:manage",
  "agents:read", "agents:manage", "agents:control",
  "departments:manage", "audit:read", "users:manage", "brain:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Default role → permission map. Stored in the DB on seed so it can be edited later. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  director: ["tasks:read", "tasks:create", "tasks:manage", "agents:read", "agents:control", "audit:read", "brain:manage"],
  hr: ["tasks:read", "tasks:create", "agents:read", "agents:manage", "agents:control"],
  member: ["tasks:read", "tasks:create", "agents:read"],
  viewer: ["tasks:read", "agents:read"],
};

export type StatsRange = "today" | "7d" | "30d" | "custom";

export interface DeptStats {
  departmentId: string;
  agents: number;
  active: number;
  idle: number;
  inProgress: number;
  queued: number;
  waitingApproval: number;
  completed: number;
  errors: number;
  avgMinutes: number | null;
  tokens: number;
  costUsd: number;
}

/** Events pushed over SSE. `type` names match the spec's realtime list. */
export type OfficeEventType =
  | "task.created" | "task.updated" | "task.status" | "task.progress"
  | "agent.updated" | "agent.status" | "agent.paused" | "agent.resumed"
  | "approval.requested" | "connector.activity" | "agent.message";

export interface OfficeEvent {
  id: number;
  type: OfficeEventType;
  at: string;
  taskId?: string | null;
  agentId?: string | null;
  departmentId?: string | null;
  data: Record<string, unknown>;
}
export * from "./dto.js";
