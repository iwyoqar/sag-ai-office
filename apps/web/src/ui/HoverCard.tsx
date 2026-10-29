import type { FloorDto } from "@sag/shared";
import { useOffice } from "../api/office";
import { sumStats, type StatsResponse } from "../api/stats";
import { StatusPill, floorLabel } from "./shared";

function place(x: number, y: number) {
  const w = 260;
  const left = Math.min(x + 18, window.innerWidth - w - 12);
  return { left: Math.max(12, left), top: Math.max(70, y - 20) };
}

export function HoverCard({ floor, x, y, stats }: { floor: FloorDto; x: number; y: number; stats: StatsResponse | null }) {
  const { office } = useOffice();
  const s = stats ? sumStats(stats.departments.filter((d) => floor.departments.includes(d.departmentId))) : null;
  return (
    <div className="hover-card" style={place(x, y)} role="tooltip">
      <div className="hc-head">
        <span className="hc-level">{floorLabel(floor.level)}</span>
        <span className="hc-title">{floor.title}</span>
      </div>
      <div className="hc-deps">
        {floor.departments.map((d) => office?.departments[d] && (
          <span key={d} style={{ color: office.departments[d].color }}>● {office.departments[d].name}</span>
        ))}
      </div>
      <div className="hc-stats">
        <span><b>{s?.agents ?? "–"}</b> agent</span>
        <span><b>{s?.active ?? "–"}</b> faol</span>
        <span><b>{s?.inProgress ?? "–"}</b> vazifa</span>
        <span><b>{s?.waitingApproval ?? "–"}</b> tasdiq</span>
      </div>
      <div className="hc-foot">Bosing — qavatni ochish</div>
    </div>
  );
}

export function AgentTip({ agentId, x, y }: { agentId: string; x: number; y: number }) {
  const { office } = useOffice();
  const a = office?.agents.find((g) => g.id === agentId);
  if (!a) return null;
  return (
    <div className="hover-card agent-tip" style={place(x, y)} role="tooltip">
      <div className="hc-title">{a.name}</div>
      <div className="muted">{a.role}</div>
      <StatusPill status={a.status} />
      {a.lifecycle === "PAUSED" && <span className="muted">To'xtatilgan (paused)</span>}
      {a.currentTask && <div className="tip-task">{a.currentTask.title}</div>}
    </div>
  );
}
