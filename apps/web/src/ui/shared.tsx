import type { ReactNode } from "react";
import type { ConnectorDto, DepartmentDto, TaskStatus } from "@sag/shared";
import { STATUS_META, TASK_STATUS_META, type AgentStatus } from "../config/status";

export function StatusPill({ status }: { status: AgentStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="status-pill" style={{ ["--c" as string]: m.color }}>
      <i />
      {m.label}
    </span>
  );
}

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  const m = TASK_STATUS_META[status];
  return (
    <span className="status-pill" style={{ ["--c" as string]: m.color }}>
      <i />
      {m.label}
    </span>
  );
}

export function DeptChip({ dep }: { dep: DepartmentDto }) {
  return (
    <span className="dept-chip" style={{ ["--dep" as string]: dep.color }}>
      <i />
      {dep.name}
    </span>
  );
}

const CONNECTOR_STATE: Record<string, string> = {
  connected: "ulangan",
  disconnected: "ulanmagan",
  error: "xato",
};

/** Connector row: shows the backend's real connection status, never an assumed one. */
export function ConnectorRow({ connectors }: { connectors: ConnectorDto[] }) {
  return (
    <div className="connector-row" aria-label="Connectorlar">
      {connectors.map((c) => (
        <span
          key={c.id}
          className={`connector ${c.status === "connected" ? "on" : c.status === "error" ? "err" : "off"}`}
          title={`${c.name} — ${CONNECTOR_STATE[c.status] ?? c.status}${c.lastError ? `: ${c.lastError}` : ""}`}
        >
          <b>{c.name.replace(/^Google /, "").slice(0, 2)}</b>
          <span>{c.name}</span>
        </span>
      ))}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="stat" style={tone ? { ["--tone" as string]: tone } : undefined}>
      <span className="stat-v">{value}</span>
      <span className="stat-l">{label}</span>
    </div>
  );
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const fmtUsd = (n: number) => `$${n < 1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
export const floorLabel = (level: number) => (level === -1 ? "B" : String(level));
