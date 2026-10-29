// API shapes shared by server responses and the web client.
import type { AgentLifecycle, AgentStatus, Permission, Role, TaskPriority, TaskStatus } from "./index.js";

export interface UserDto {
  id: string; username: string; displayName: string; roles: Role[]; permissions: Permission[];
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
  id: string; kind: "single" | "orchestrate";
  /** a person must approve the result before the task counts as done */
  requiresApproval: boolean; scheduledFor: string | null; title: string; description: string; createdBy: string | null; parentId: string | null;
  departmentId: string | null; agentId: string | null; priority: TaskPriority; deadline: string | null;
  status: TaskStatus; progress: number | null; stage: string | null; result: string | null; error: string | null;
  attempts: number; maxAttempts: number; limits: TaskLimits; dependsOn: string[];
  startedAt: string | null; completedAt: string | null; tokensIn: number; tokensOut: number; costUsd: number;
  createdAt: string; updatedAt: string;
}
