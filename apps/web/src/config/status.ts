import type { AgentStatus, TaskStatus } from "@sag/shared";
export { ACTIVE_AGENT_STATUSES, AGENT_STATUSES, type AgentStatus } from "@sag/shared";

export const STATUS_META: Record<AgentStatus, { label: string; color: string }> = {
  IDLE: { label: "Bo'sh", color: "#94a3b8" },
  WORKING: { label: "Ishlayapti", color: "#2563eb" },
  THINKING: { label: "O'ylayapti", color: "#8b5cf6" },
  COMMUNICATING: { label: "Aloqada", color: "#06b6d4" },
  WAITING_APPROVAL: { label: "Tasdiq kutmoqda", color: "#f59e0b" },
  BLOCKED: { label: "Bloklangan", color: "#ea580c" },
  ERROR: { label: "Xato", color: "#dc2626" },
  COMPLETED: { label: "Tugatdi", color: "#16a34a" },
};

export const TASK_STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  BACKLOG: { label: "Backlog", color: "#94a3b8" },
  QUEUED: { label: "Navbatda", color: "#64748b" },
  IN_PROGRESS: { label: "Bajarilmoqda", color: "#2563eb" },
  WAITING_FOR_DEPENDENCY: { label: "Bog'liqlikni kutmoqda", color: "#8b5cf6" },
  WAITING_APPROVAL: { label: "Tasdiq kutmoqda", color: "#f59e0b" },
  BLOCKED: { label: "Bloklangan", color: "#ea580c" },
  FAILED: { label: "Xato", color: "#dc2626" },
  DONE: { label: "Bajarildi", color: "#16a34a" },
  CANCELLED: { label: "Bekor qilindi", color: "#6b7280" },
};
