// T1 Unified Task Engine: the business lifecycle and the assignment model shared by people and AI agents
// (WORK_MANAGEMENT_ROADMAP.md T1). The legacy `status` stays the AI execution / legacy-flow status; `lifecycle` is the
// business state every person and agent works with. Server: apps/server/src/domain/taskEngine.ts.

export const TASK_LIFECYCLES = [
  "BACKLOG", "PLANNED", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "REVISION", "APPROVED", "COMPLETED", "CANCELLED",
] as const;
export type TaskLifecycle = (typeof TASK_LIFECYCLES)[number];

/**
 * Transitions a person may request through the engine. The AI runtime and the legacy flows move the lifecycle through
 * the execution status (e.g. ASSIGNED → IN_PROGRESS when an agent claims the task); those are recorded too.
 * Approval and completion are separate steps: IN_REVIEW → APPROVED → COMPLETED.
 */
export const LIFECYCLE_TRANSITIONS: Record<TaskLifecycle, readonly TaskLifecycle[]> = {
  BACKLOG: ["PLANNED", "ASSIGNED", "CANCELLED"],
  PLANNED: ["BACKLOG", "ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "BLOCKED", "BACKLOG", "CANCELLED"],
  IN_PROGRESS: ["IN_REVIEW", "COMPLETED", "BLOCKED", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "ASSIGNED", "CANCELLED"],
  IN_REVIEW: ["APPROVED", "REVISION", "CANCELLED"],
  REVISION: ["IN_PROGRESS", "BLOCKED", "CANCELLED"],
  APPROVED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
export const canMoveLifecycle = (from: TaskLifecycle, to: TaskLifecycle) => LIFECYCLE_TRANSITIONS[from].includes(to);
export const CLOSED_LIFECYCLES: readonly TaskLifecycle[] = ["COMPLETED", "CANCELLED"];

export const ASSIGNEE_TYPES = ["HUMAN", "AI_AGENT"] as const;
export type AssigneeType = (typeof ASSIGNEE_TYPES)[number];
export const ASSIGNMENT_ROLES = ["OWNER", "CONTRIBUTOR", "REVIEWER", "APPROVER"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];
export const ASSIGNMENT_STATES = ["ASSIGNED", "ACCEPTED", "DECLINED", "RELEASED"] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export interface TaskAssignmentDto {
  id: string; taskId: string; assigneeType: AssigneeType; assigneeId: string; assigneeName: string | null;
  role: AssignmentRole; state: AssignmentState; assignedBy: string | null; assignedAt: string;
  acceptedAt: string | null; releasedAt: string | null; reason: string | null;
}

export interface TaskTransitionDto {
  id: number; from: TaskLifecycle | null; to: TaskLifecycle; status: string;
  /** "user:<id>", "agent:<id>" or "system" */
  actor: string; actorName: string | null; reason: string | null; at: string;
}

/** Everything the task screen needs from the engine, with what this viewer may do now (computed on the server). */
export interface TaskEngineView {
  task: {
    id: string; title: string; kind: "single" | "orchestrate" | "human"; lifecycle: TaskLifecycle; status: string;
    priority: string; version: number; startAt: string | null; dueAt: string | null; completedAt: string | null;
    businessUnitId: string; departmentId: string | null; blockedReason: string | null; requiresApproval: boolean;
  };
  assignments: TaskAssignmentDto[];
  transitions: TaskTransitionDto[];
  can: { manage: boolean; assign: boolean; transitions: TaskLifecycle[] };
}
