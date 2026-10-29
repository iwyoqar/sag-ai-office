import { STATUS_META } from "../config/status";
import { useOffice } from "../api/office";
import { sumStats, type StatsResponse } from "../api/stats";
import type { ReactNode } from "react";
import { Stat, fmtTokens, fmtUsd, floorLabel } from "./shared";

export function CompanyPanel({ onSelect, stats, onBack, children }: {
  onSelect: (id: string) => void; stats: StatsResponse | null; onBack?: () => void; children?: ReactNode;
}) {
  const { office } = useOffice();
  if (!office) return null;
  const all = stats ? sumStats(stats.departments) : null;
  const ofFloor = (deps: string[]) => (stats ? sumStats(stats.departments.filter((d) => deps.includes(d.departmentId))) : null);
  return (
    <aside className="panel company-panel" aria-label="Kompaniya holati">
      <div className="panel-head">
        {onBack && <button className="back" onClick={onBack}>← Kampus</button>}
        <h2 className="panel-title small">Kompaniya holati · bugun</h2>
      </div>
      <div className="stats compact">
        <Stat label="Agentlar" value={all?.agents ?? "–"} />
        <Stat label="Faol" value={all?.active ?? "–"} tone={STATUS_META.WORKING.color} />
        <Stat label="Tasdiq" value={all?.waitingApproval ?? "–"} tone={STATUS_META.WAITING_APPROVAL.color} />
        <Stat label="Xatolar" value={all?.errors ?? "–"} tone={STATUS_META.ERROR.color} />
        <Stat label="Tokenlar" value={all ? fmtTokens(all.tokens) : "–"} />
        <Stat label="API xarajat" value={all ? fmtUsd(all.costUsd) : "–"} />
      </div>
      <table className="floor-table">
        <thead>
          <tr><th>Qavat</th><th>Agent</th><th>Faol</th><th>Vazifa</th></tr>
        </thead>
        <tbody>
          {office.floors.map((f) => {
            const fs = ofFloor(f.departments);
            return (
              <tr key={f.id} onClick={() => onSelect(f.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(f.id)}>
                <td>
                  <span className="lvl-s" style={{ background: office.departments[f.departments[0]]?.color }}>{floorLabel(f.level)}</span>
                  {f.title}
                </td>
                <td>{fs?.agents ?? "–"}</td>
                <td>{fs?.active ?? "–"}</td>
                <td>{fs ? fs.inProgress + fs.queued || "—" : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">{onBack ? "Qavat ustiga olib boring yoki bosing." : "Qavatni tanlang yoki binoni bosing."}</p>
      {children}
    </aside>
  );
}
