import type { FloorDto } from "@sag/shared";
import { useOffice } from "../api/office";
import type { SystemStatus } from "../api/system";
import { NotificationsBell } from "./people/PeoplePanel";

export function TopBar({ floor, building, inOffice, onCampus, onOffice, onTasks, tasksOpen, system, onBrain, onCalendar, onAccount, onPeople, onOpenWork, onNetwork }: {
  floor?: FloorDto; building?: string; inOffice: boolean; onCampus?: () => void; onOffice?: () => void;
  onTasks?: () => void; tasksOpen?: boolean; system?: SystemStatus | null; onBrain?: () => void; onCalendar?: () => void; onAccount?: () => void;
  onPeople?: () => void; onOpenWork?: (id: string) => void; onNetwork?: () => void;
}) {
  const { user, live, auth, logout } = useOffice();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <i /><i /><i />
        </span>
        <span className="brand-name">SAG <b>AI OFFICE</b></span>
      </div>
      <nav className="crumbs" aria-label="Navigatsiya">
        <button className="crumb" onClick={onCampus} disabled={!onCampus}>Kampus</button>
        {building && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb current">{building}</span>
          </>
        )}
        {inOffice && (
          <>
            <span className="crumb-sep">/</span>
            <button className={`crumb${floor ? "" : " current"}`} onClick={onOffice} disabled={!onOffice}>SAG Headquarters</button>
          </>
        )}
        {floor && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb current">{floor.level === -1 ? "Podval" : `${floor.level}-qavat`} · {floor.title}</span>
          </>
        )}
      </nav>
      {auth === "authenticated" && (
        <div className="top-status">
          {system && <AiChip s={system} />}
          {onNetwork && <button className="tasks-btn" onClick={onNetwork} title="Home Design do'konlar tarmog'i (3D)">Do'konlar</button>}
          {onPeople && <button className="tasks-btn" onClick={onPeople}>Xodimlar</button>}
          {onBrain && <button className="tasks-btn" onClick={onBrain}>The Brain</button>}
          {onCalendar && <button className="tasks-btn" onClick={onCalendar}>Kalendar</button>}
          {onTasks && (
            <button className={`tasks-btn${tasksOpen ? " on" : ""}`} onClick={onTasks} title="AI agentlar vazifalari">
              AI vazifalar{system?.worker.active ? <b>{system.worker.active}</b> : null}
            </button>
          )}
          {onOpenWork && <NotificationsBell onOpenTask={onOpenWork} />}
          <span
            className={`backend ${live ? "on" : "off"}`}
            title={live ? "Real vaqt oqimi ulangan (SSE)" : "Real vaqt oqimi uzildi — qayta ulanmoqda"}
          >
            <i /> {live ? "Live" : "Qayta ulanmoqda…"}
          </span>
          <button className="user crumb" title={`${user?.roles.join(", ")} — hisob va parol`} onClick={onAccount}>{user?.displayName}</button>
          <button className="crumb" onClick={() => void logout()}>Chiqish</button>
        </div>
      )}
    </header>
  );
}

/** Which AI powers the agents — live provider, test mock, or not configured. Never ambiguous. */
function AiChip({ s }: { s: SystemStatus }) {
  const l = s.llm;
  if (!l.configured) return <span className="ai-chip off" title={l.reason}>AI: ulanmagan</span>;
  if (l.mode === "mock") return <span className="ai-chip mock" title="Sinov rejimi: javoblar haqiqiy AI emas">AI: MOCK</span>;
  const bad = l.health && !l.health.ok;
  return (
    <span className={`ai-chip ${bad ? "err" : "on"}`} title={bad ? l.health?.detail : `${l.provider} · ${l.model}`}>
      AI: {l.provider === "gemini" ? "Gemini" : l.provider}{bad ? " · xato" : ""}
    </span>
  );
}
