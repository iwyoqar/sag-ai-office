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
  // human workflow (DONE doubles as "COMPLETED")
  "ASSIGNED", "ACCEPTED", "IN_REVIEW", "CHANGES_REQUESTED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["DONE", "FAILED", "CANCELLED"];
/** Tasks that still belong to an agent's workload. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  "BACKLOG", "QUEUED", "IN_PROGRESS", "WAITING_FOR_DEPENDENCY", "WAITING_APPROVAL", "BLOCKED",
  "ASSIGNED", "ACCEPTED", "IN_REVIEW", "CHANGES_REQUESTED",
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
  // human-only statuses never occur on agent tasks
  ASSIGNED: [],
  ACCEPTED: [],
  IN_REVIEW: [],
  CHANGES_REQUESTED: [],
};

/** Workflow for tasks done by people (kind = "human"). DONE = completed. */
const HUMAN_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  BACKLOG: ["ASSIGNED", "ACCEPTED", "CANCELLED"],
  ASSIGNED: ["ACCEPTED", "BACKLOG", "CANCELLED"], // BACKLOG = declined, back to the manager
  ACCEPTED: ["IN_PROGRESS", "BLOCKED", "CANCELLED", "ASSIGNED"],
  IN_PROGRESS: ["IN_REVIEW", "DONE", "BLOCKED", "CANCELLED", "ASSIGNED"],
  IN_REVIEW: ["DONE", "CHANGES_REQUESTED", "CANCELLED"],
  CHANGES_REQUESTED: ["IN_PROGRESS", "BLOCKED", "CANCELLED", "ASSIGNED"],
  BLOCKED: ["IN_PROGRESS", "ACCEPTED", "CANCELLED", "ASSIGNED"],
  DONE: [],
  CANCELLED: [],
  QUEUED: [], WAITING_FOR_DEPENDENCY: [], WAITING_APPROVAL: [], FAILED: [],
};

export function canTransitionHumanTask(from: TaskStatus, to: TaskStatus): boolean {
  return HUMAN_TASK_TRANSITIONS[from].includes(to);
}

export function allowedHumanTransitions(from: TaskStatus): readonly TaskStatus[] {
  return HUMAN_TASK_TRANSITIONS[from];
}

/** Statuses of a person's task that still count as their work in progress. */
export const HUMAN_ACTIVE_STATUSES: readonly TaskStatus[] = ["ASSIGNED", "ACCEPTED", "IN_PROGRESS", "CHANGES_REQUESTED", "BLOCKED"];

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function allowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const ROLES = ["admin", "director", "department_head", "employee", "hr", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "tasks:read", "tasks:create", "tasks:manage",
  // giving work to AI agents (tasks, agent chat, the AI Director) — spends the AI budget
  "ai_tasks:create",
  "agents:read", "agents:manage", "agents:control",
  "departments:manage", "audit:read", "users:manage", "brain:manage",
  // people & human workflow
  "employees:read_all", "employees:manage_all", "employees:manage_dept",
  "tasks:assign_any", "tasks:assign_dept", "tasks:read_all", "tasks:read_team",
  "permissions:delegate", "workload:configure",
  // sensitive AI data — separate from task visibility (security model §3.5)
  "agent_chat:read_others", "ai_runs:read", "tool_io:read", "budget:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions a grant may be limited to one department for. */
export const SCOPABLE_PERMISSIONS: readonly Permission[] = ["employees:manage_dept", "tasks:assign_dept", "tasks:read_team"];

/** Default role → permission map. Stored in the DB on seed so it can be edited later. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  director: [
    "tasks:read", "tasks:create", "tasks:manage", "ai_tasks:create", "agents:read", "agents:control", "audit:read", "brain:manage",
    "employees:read_all", "tasks:assign_any", "tasks:read_all", "permissions:delegate", "workload:configure",
    "ai_runs:read", "tool_io:read", "budget:read",
  ],
  department_head: ["tasks:read", "tasks:create", "ai_tasks:create", "agents:read", "employees:manage_dept", "tasks:assign_dept"],
  employee: ["tasks:read", "tasks:create", "agents:read"],
  hr: ["tasks:read", "tasks:create", "ai_tasks:create", "agents:read", "agents:manage", "agents:control"],
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
  /** tokens/cost withheld: the viewer lacks budget:read (task figures are already limited to what they can see) */
  usageHidden?: boolean;
}

/** Events pushed over SSE. `type` names match the spec's realtime list. */
export type OfficeEventType =
  | "task.created" | "task.updated" | "task.status" | "task.progress"
  | "agent.updated" | "agent.status" | "agent.paused" | "agent.resumed"
  | "approval.requested" | "connector.activity" | "agent.message"
  // people: content-free signals delivered only to their audience (clients refetch through authorised APIs)
  | "work.updated" | "employee.updated" | "notification.created";

export interface OfficeEvent {
  id: number;
  type: OfficeEventType;
  at: string;
  taskId?: string | null;
  agentId?: string | null;
  departmentId?: string | null;
  /** owning business unit (server-side filtering; HQ streams only carry HQ events) */
  unitId?: string | null;
  data: Record<string, unknown>;
}
export * from "./dto.js";
