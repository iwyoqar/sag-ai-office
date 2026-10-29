import { useState } from "react";
import type { FloorDto, StatsRange } from "@sag/shared";
import { STATUS_META } from "../config/status";
import { useOffice } from "../api/office";
import { sumStats, useStats } from "../api/stats";
import { ConnectorRow, DeptChip, Stat, StatusPill, fmtTokens, fmtUsd, floorLabel } from "./shared";

const RANGES: [StatsRange, string][] = [["today", "Bugun"], ["7d", "7 kun"], ["30d", "30 kun"], ["custom", "Oraliq"]];

/** Today's date in Asia/Tashkent as YYYY-MM-DD. */
const tashkentToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

export function FloorPanel({ floor, onBack, onAgent, selectedAgent }: {
  floor: FloorDto; onBack: () => void; onAgent: (id: string) => void; selectedAgent: string | null;
}) {
  const { office } = useOffice();
  const [range, setRange] = useState<StatsRange>("today");
  const [from, setFrom] = useState(tashkentToday);
  const [to, setTo] = useState(tashkentToday);
  const { data, error } = useStats(range, from, to);
  if (!office) return null;

  const deps = floor.departments.map((d) => office.departments[d]).filter(Boolean);
  const s = data ? sumStats(data.departments.filter((d) => floor.departments.includes(d.departmentId))) : null;
  const connectorIds = new Set(deps.flatMap((d) => d.connectors));
  const connectors = office.connectors.filter((c) => connectorIds.has(c.id));
  const connected = connectors.filter((c) => c.status === "connected").length;
  const v = (n: number | undefined) => (n === undefined ? "–" : n);

  return (
    <aside className="panel floor-panel" aria-label={`${floor.title} paneli`}>
      <div className="panel-head">
        <button className="back" onClick={onBack} aria-label="Butun binoga qaytish">← Bino</button>
      </div>
      <h2 className="panel-title">
        <span className="lvl">{floorLabel(floor.level)}</span>
        {floor.title}
      </h2>
      <div className="chips">{deps.map((d) => <DeptChip key={d.id} dep={d} />)}</div>

      <section>
        <h3>Connectorlar · {connected}/{connectors.length} ulangan</h3>
        <ConnectorRow connectors={connectors} />
        {connected === 0 && <p className="hint">Hali hech biri ulanmagan. Ulash The Brain → Connectors Manager orqali (Phase 7).</p>}
      </section>

      <section>
        <div className="sec-head">
          <h3>Statistika</h3>
          <div className="seg" role="group" aria-label="Vaqt oralig'i">
            {RANGES.map(([r, l]) => (
              <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{l}</button>
            ))}
          </div>
        </div>
        {range === "custom" && (
          <div className="custom-range">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Boshlanish" />
            <span>—</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Tugash" />
          </div>
        )}
        {error && <p className="hint err">Statistika yuklanmadi: {error}</p>}
        <div className="stats">
          <Stat label="Agentlar" value={v(s?.agents)} />
          <Stat label="Faol" value={v(s?.active)} tone={STATUS_META.WORKING.color} />
          <Stat label="Bo'sh" value={v(s?.idle)} tone={STATUS_META.IDLE.color} />
          <Stat label="Bajarilmoqda" value={v(s?.inProgress)} />
          <Stat label="Navbatda" value={v(s?.queued)} />
          <Stat label="Tasdiq kutmoqda" value={v(s?.waitingApproval)} tone={STATUS_META.WAITING_APPROVAL.color} />
          <Stat label="Tugallangan" value={v(s?.completed)} tone={STATUS_META.COMPLETED.color} />
          <Stat label="Xatolar" value={v(s?.errors)} tone={STATUS_META.ERROR.color} />
          <Stat label="O'rt. vaqt" value={s ? (s.avgMinutes === null ? "—" : `${s.avgMinutes} min`) : "–"} />
          <Stat label="Tokenlar" value={s ? fmtTokens(s.tokens) : "–"} />
          <Stat label="API xarajat" value={s ? fmtUsd(s.costUsd) : "–"} />
        </div>
        <p className="hint">Hisoblash vaqti: Asia/Tashkent. Xarajat — Claude API usage yozuvlaridan (Phase 3 dan boshlab).</p>
      </section>

      {deps.map((d) => (
        <section key={d.id}>
          <h3 style={{ color: d.color }}>{d.name}</h3>
          <p className="focus">{d.focus.join(" · ")}</p>
          <ul className="agent-list">
            {office.agents.filter((a) => a.departmentId === d.id).map((a) => (
              <li key={a.id}>
                <button className={selectedAgent === a.id ? "on" : ""} onClick={() => onAgent(a.id)}>
                  <span className="av" style={{ background: a.lifecycle === "PAUSED" ? "#9aa0a8" : d.color }}>{a.name[0]}</span>
                  <span className="who">
                    <b>{a.name}</b>
                    <small>{a.currentTask ? a.currentTask.title : a.role}</small>
                  </span>
                  {a.lifecycle === "PAUSED" ? <span className="status-pill paused">Paused</span> : <StatusPill status={a.status} />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
