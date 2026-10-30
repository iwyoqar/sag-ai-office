// API shapes shared by server responses and the web client.
import type { AgentLifecycle, AgentStatus, Permission, Role, TaskPriority, TaskStatus } from "./index.js";

export interface UserDto {
  id: string; username: string; displayName: string; roles: Role[]; permissions: Permission[];
  /** employee context (null for technical accounts) */
  departmentId?: string | null;
  /** departments this user manages (head or delegated grant) */
  managedDepartments?: string[];
  /** departments this user heads (departments.head_user_id): where they may hire agents */
  headOf?: string[];
  /** business unit of the account ('hq' = SAG Head Office); store accounts only use the unit routes */
  homeUnitId?: string;
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
  /** imported / invited, has not set a password with the one-time code yet */
  pendingActivation: boolean;
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
  usage: { inputTokens: number; outputTokens: number; costUsd: number; runs: number; /** withheld without budget:read */ hidden?: boolean };
}

export interface TaskLimits {
  maxAgents?: number; maxIterations?: number; maxTokens?: number; maxCostUsd?: number; maxDurationMs?: number;
}

export interface TaskDto {
  id: string; kind: "single" | "orchestrate" | "human";
  /** a person must approve the result before the task counts as done */
  requiresApproval: boolean; scheduledFor: string | null; title: string; description: string; createdBy: string | null; parentId: string | null;
  /** a revision subtask: the earlier subtask it redoes after the AI Director's evaluation */
  revisionOf?: string | null;
  departmentId: string | null; agentId: string | null; priority: TaskPriority; deadline: string | null;
  status: TaskStatus; progress: number | null; stage: string | null; result: string | null; error: string | null;
  attempts: number; maxAttempts: number; limits: TaskLimits; dependsOn: string[];
  startedAt: string | null; completedAt: string | null; tokensIn: number; tokensOut: number; costUsd: number;
  createdAt: string; updatedAt: string;
  /** owning business unit ('hq' = SAG Head Office) */
  businessUnitId: string;
  /** human workflow (kind = "human") */
  assigneeUserId?: string | null; assignedBy?: string | null; reviewerUserId?: string | null;
  estimateHours?: number | null; actualHours?: number | null; isOptional?: boolean; weight?: number;
  declineReason?: string | null; acceptedAt?: string | null; submittedAt?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// SAG World: organisation tree, business units (stores), data sharing

export type BusinessType = "SAG_BRANCH" | "INDEPENDENT_DEALER" | "SUBSIDIARY";
export type OwnershipModel = "SAG_OWNED" | "FRANCHISE" | "INDEPENDENT" | "GROUP_OWNED";
export type UnitRole = "unit_director" | "unit_manager" | "unit_staff";
export type DataClass = "people_counts" | "employees" | "tasks" | "kpi" | "ai_usage" | "budget" | "knowledge";

/** What a business unit does — independent of its ownership type (a franchise may be RETAIL and DEALER). */
export const BUSINESS_FUNCTIONS = ["RETAIL", "WAREHOUSE", "FACTORY", "OFFICE", "LOGISTICS", "DEALER", "HEADQUARTERS"] as const;
export type BusinessFunction = (typeof BUSINESS_FUNCTIONS)[number];
export type ShareLevel = "AGGREGATE" | "DETAIL";

/** Network-level classification of a unit: never contains confidential unit data. */
export interface UnitCardDto {
  id: string; name: string; code: string; regionId: string; regionName: string;
  businessType: BusinessType; ownershipModel: OwnershipModel | null;
  sourceBrand: string | null; sourceMarker: "HD" | "F" | null; status: string;
  /** real coordinates only; null = unknown (the world view then uses a labelled placeholder layout) */
  geo: { lat: number; lng: number } | null;
  address: string | null;
  isHeadOffice: boolean;
  functions: BusinessFunction[];
}

export interface NetworkDto {
  group: { id: string; name: string };
  regions: { id: string; name: string; sourceLabel: string | null; units: UnitCardDto[] }[];
}

export interface UnitAccessDto {
  memberRole: UnitRole | null;
  classes: Partial<Record<DataClass, ShareLevel>>;
  manageStructure: boolean;
  canManageEmployees: boolean;
  canAssignTasks: boolean;
}

export interface UnitPersonDto {
  id: string; displayName: string; username: string; jobTitle: string; role: UnitRole | null;
  status: string; activation: "ACTIVE" | "PENDING_ACTIVATION";
}

export interface UnitTaskDto {
  id: string; kind: "single" | "orchestrate" | "human"; title: string; status: string; priority: string;
  assigneeUserId: string | null; agentId: string | null; createdAt: string; updatedAt: string; result: string | null;
}

export interface UnitOverviewDto {
  unit: UnitCardDto;
  access: UnitAccessDto;
  director: { assigned: boolean; activation: "ACTIVE" | "PENDING_ACTIVATION" | null; displayName?: string; username?: string };
  aiDirector: { id: string; name: string; status: string; lifecycle: string } | null;
  employeeCount?: number;
  employees?: UnitPersonDto[];
  taskCounts?: Record<string, number>;
  tasks?: UnitTaskDto[];
  kpis?: { employees: number; openTasks: number; doneTasks30d: number; aiCostUsd30d?: number };
  /** sections hidden from this viewer (franchise confidentiality, missing agreement) */
  restricted: string[];
}

export type AgreementAccess = "READ" | "READ_WRITE";
export type AgreementStatus = "PENDING" | "SCHEDULED" | "ACTIVE" | "EXPIRED" | "REVOKED";
export interface AgreementDto {
  id: string; unitId: string; granteeNodeId: string; dataClasses: DataClass[]; level: ShareLevel;
  /** READ_WRITE is only meaningful for tasks (the grantee may assign work into the unit) */
  access: AgreementAccess;
  validFrom: string; validTo: string | null; contractRef: string; active: boolean; status: AgreementStatus;
  approvedAt: string | null; revokedAt: string | null; createdAt: string;
}

// ---------- unit budgets (UZS, integer minor units; amounts travel as decimal strings) ----------
export type BudgetCategory = "OPERATIONS" | "AI" | "MARKETING" | "PAYROLL" | "INVENTORY" | "OTHER";
export type BudgetStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "CLOSED";
export interface BudgetDto {
  id: string; unitId: string; period: string; category: BudgetCategory; currency: "UZS"; status: BudgetStatus;
  /** exact amounts as decimal strings in UZS ("1250000.00"); never floating-point numbers */
  allocated: string; spent: string; remaining: string;
  note: string; createdBy: string; submittedAt: string | null; decidedBy: string | null; decidedAt: string | null; decisionReason: string | null;
}
export interface BudgetEntryDto {
  id: string; budgetId: string; amount: string; originalAmount: string; originalCurrency: string;
  fxRate: string | null; fxRateDate: string | null; fxSource: string | null; description: string; occurredOn: string;
  recordedBy: string; createdAt: string;
}
/** aggregate view (AGGREGATE sharing): totals only */
export interface BudgetSummaryDto { period: string; category: BudgetCategory; status: BudgetStatus; allocated: string; spent: string; remaining: string }

// ---------- connectors per unit (credentials are never part of any DTO) ----------
export interface ConnectorInstallationDto {
  id: string; unitId: string; connectorId: string; name: string; enabled: boolean;
  status: "disconnected" | "connected" | "error"; credentialScope: "NONE" | "SERVER_ENV" | "SECRET_STORE";
  lastHealthAt: string | null; lastError: string | null;
}

// ---------------------------------------------------------------- agent marketplace (W4)

/** A connector a template may grant, with the actions allowed on it (mirrors agent_connector_permissions). */
export interface TemplateTool { connectorId: string; actions: ("read" | "write")[] }

export interface TemplateVersionDto {
  version: number; role: string; responsibilities: string; skills: string[]; instructions: string; tools: TemplateTool[];
  model: string | null; maxTokensPerTask: number | null;
  /** estimated monthly cost, UZS tiyin (0 = not entered yet) */
  estMonthlyMinor: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  approvedAt: string | null; approvedNote: string | null;
}

export interface TemplateDto {
  id: string; name: string; category: string; status: "DRAFT" | "APPROVED" | "RETIRED"; allowedDepartments: string[];
  currentVersion: number | null; current: TemplateVersionDto | null; draft: TemplateVersionDto | null;
  /** non-archived agents hired from this template */
  hiredCount: number;
}

export type HireCheckId =
  | "template_approved" | "department_allowed" | "tools_within" | "pending_cap"
  | "agent_count" | "budget" | "auto_listed" | "risk";
/** hard: failing rejects the request; soft: failing sends it to the admin */
export interface HireCheck { id: HireCheckId; ok: boolean; hard: boolean; detail: string }
export type HireOutcome = "hire" | "pending" | "reject";

export interface HireRequestDto {
  id: string; templateId: string; templateVersion: number; templateName: string; departmentId: string;
  requestedBy: { id: string; name: string }; justification: string; checks: HireCheck[];
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"; decidedVia: "user" | "policy" | null;
  decidedBy: string | null; decisionReason: string | null; override: boolean; agentId: string | null;
  createdAt: string; decidedAt: string | null;
}

export interface HiringLimitDto {
  departmentId: string; maxAgents: number | null; monthlyBudgetMinor: number | null; autoTemplates: string[];
  /** active + paused agents now */
  activeAgents: number;
  /** Σ estimated monthly cost of the department's templated agents, UZS tiyin */
  committedMinor: number;
}
