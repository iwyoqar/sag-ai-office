// API shapes shared by server responses and the web client.
import type { AgentLifecycle, AgentStatus, Permission, Role, TaskPriority, TaskStatus } from "./index.js";

export interface UserDto {
  id: string; username: string; displayName: string; roles: Role[]; permissions: Permission[];
  /** employee context (null for technical accounts) */
  departmentId?: string | null;
  /** departments this user manages (head or delegated grant) */
  managedDepartments?: string[];
}

export type EmployeeStatus = "active" | "inactive" | "archived";
export type WorkloadLevel = "GREEN" | "YELLOW" | "ORANGE" | "RED";

export interface WorkloadDto {
  level: WorkloadLevel;
  /** demand / capacity over the planning horizon, % */
  percent: number;
  demandHours: number;
  capacityHours: number;
  activeTasks: number;
  overdue: number;
  dueSoon: number;
  blocked: number;
  /** "low" when some estimates were missing and defaults were used */
  confidence: "high" | "low";
  summary: string;
  reasons: string[];
}

/** Basic directory card: visible to every signed-in user. */
export interface EmployeeCardDto {
  id: string; displayName: string; jobTitle: string; departmentId: string | null; floorId: string | null;
  status: EmployeeStatus; hasAvatar: boolean; roles: Role[]; managerId: string | null;
}

/** Full profile: self, managers in scope, and company-wide readers only. */
export interface EmployeeDto extends EmployeeCardDto {
  username: string; email: string | null; startDate: string | null;
  capacityHoursWeek: number; workStart: string; workEnd: string; timezone: string;
  lastActivityAt: string | null; lastLoginAt: string | null; createdAt: string;
  grants: { id: string; permission: Permission; departmentId: string | null; canDelegate: boolean; grantedBy: string | null }[];
  workload: WorkloadDto;
  /** what the viewer may do with this record */
  can: { edit: boolean; editOrg: boolean; changeStatus: boolean; changeRoles: boolean; grant: boolean; assignTasks: boolean };
}

/** Presence for the 3D office: derived only from real task data and activity timestamps. */
export type PresenceState = "available" | "working" | "reviewing" | "blocked" | "away";
export interface PresenceDto {
  id: string; displayName: string; jobTitle: string; departmentId: string; floorId: string | null; state: PresenceState;
  /** stable desk number inside the department (people are seated from the far end of its desks) */
  desk: number | null;
}

export interface NotificationDto {
  id: string; kind: string; taskId: string | null; title: string; body: string; readAt: string | null; createdAt: string;
}

export interface FloorDto { id: string; level: number; title: string; departments: string[] }

export interface DepartmentDto {
  id: string; floorId: string; name: string; short: string; color: string; weight: number;
  focus: string[]; connectors: string[]; isActive: boolean;
}

export interface ConnectorDto {
  id: string; name: string; kind: string; authStatus: string; status: string;
  allowedActions: string[]; departments: string[]; lastSyncAt: string | null; lastHealthAt: string | null; lastError: string | null;
}

export interface AgentDto {
  id: string; name: string; role: string; departmentId: string; status: AgentStatus; lifecycle: AgentLifecycle;
  model: string | null; skills: string[]; responsibilities: string;
  maxTokensPerTask: number | null; maxCostPerTaskUsd: number | null;
  createdAt: string; updatedAt: string; archivedAt: string | null;
  /** Stable desk index inside the department (null when archived). */
  workstation: number | null;
  currentTask: { id: string; title: string; status: string; progress: number | null; stage: string | null } | null;
  openTasks: number;
}

export interface AgentProfileDto {
  agent: AgentDto;
  recentTasks: { id: string; title: string; status: TaskStatus; completedAt: string | null; updatedAt: string }[];
  connectors: { id: string; name: string; status: string; authStatus: string; granted: boolean; allowedActions: string[] }[];
  instructions: { id: string; scope: string; title: string; version: number; content: string }[];
  errors: { taskId: string; title: string; error: string; at: string }[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number; runs: number };
}

export interface TaskLimits {
  maxAgents?: number; maxIterations?: number; maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number;
}

export interface TaskDto {
  id: string; kind: "single" | "orchestrate" | "human";
  /** a person must approve the result before the task counts as done */
  requiresApproval: boolean; scheduledFor: string | null; title: string; description: string; createdBy: string | null; parentId: string | null;
  departmentId: string | null; agentId: string | null; priority: TaskPriority; deadline: string | null;
  status: TaskStatus; progress: number | null; stage: string | null; result: string | null; error: string | null;
  attempts: number; maxAttempts: number; limits: TaskLimits; dependsOn: string[];
  startedAt: string | null; completedAt: string | null; tokensIn: number; tokensOut: number; costUsd: number;
  createdAt: string; updatedAt: string;
  /** human workflow (kind = "human") */
  assigneeUserId?: string | null; assignedBy?: string | null; reviewerUserId?: string | null;
  estimateHours?: number | null; actualHours?: number | null; isOptional?: boolean; weight?: number;
  declineReason?: string | null; acceptedAt?: string | null; submittedAt?: string | null;
}
