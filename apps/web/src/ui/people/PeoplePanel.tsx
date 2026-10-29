// "Xodimlar" hub: directory, org chart, team, work views, workload policy; plus the notifications bell.
import { useEffect, useRef, useState } from "react";
import type { EmployeeCardDto, NotificationDto, WorkloadLevel } from "@sag/shared";
import { api } from "../../api/client";
import { useOffice } from "../../api/office";
import { WORKLOAD_META } from "../../config/status";
import { Avatar, Empty, Loading, Msg, fmtDate, run, useLoad, type Note } from "./common";
import { Directory, EmployeeForm } from "./Employees";
import { WorkBoard } from "./Work";

type Tab = "work" | "people" | "org" | "settings";

export function PeoplePanel({ onClose, onOpenEmployee, onOpenTask, onNewTask, initialTab = "work" }: {
  onClose: () => void; onOpenEmployee: (id: string) => void; onOpenTask: (id: string) => void; onNewTask: () => void; initialTab?: Tab;
}) {
  const { can, user } = useOffice();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [adding, setAdding] = useState(false);
  const canAdd = can("users:manage") || can("employees:manage_all") || !!user?.managedDepartments?.length;
  const canOrg = can("employees:read_all") || can("employees:manage_all") || !!user?.managedDepartments?.length;
  const tabs: [Tab, string][] = [
    ["work", "Vazifalar"], ["people", "Xodimlar"], ...(canOrg ? [["org", "Tuzilma"] as [Tab, string]] : []),
    ...(can("workload:configure") ? [["settings", "Yuklama sozlamasi"] as [Tab, string]] : []),
  ];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal brain people" role="dialog" aria-label="Xodimlar va vazifalar" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">Inson xodimlar, tashkiliy tuzilma va ularning vazifalari (AI agentlardan alohida)</div>
            <h2>Xodimlar</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="brain-tabs" role="tablist">
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <div className="modal-body">
          {tab === "work" && <WorkBoard onOpen={onOpenTask} onNew={onNewTask} />}
          {tab === "people" && (adding ? (
            <section className="ins-card new">
              <b>Yangi xodim</b>
              <EmployeeForm onCancel={() => setAdding(false)} onSaved={(id) => { setAdding(false); onOpenEmployee(id); }} />
            </section>
          ) : <Directory onOpen={onOpenEmployee} onCreate={canAdd ? () => setAdding(true) : undefined} />)}
          {tab === "org" && <OrgChart onOpen={onOpenEmployee} />}
          {tab === "settings" && <WorkloadSettings />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- org chart

interface Org {
  directors: string[];
  departments: { id: string; name: string; color: string; floorId: string; headId: string | null; members: string[]; agents: number }[];
  people: (EmployeeCardDto & { workload: WorkloadLevel })[];
}

function OrgChart({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useOffice();
  const { data, error, reload } = useLoad<Org>("/api/org-chart");
  const [msg, setMsg] = useState<Note>(null);
  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <Loading />;
  const byId = new Map(data.people.map((p) => [p.id, p]));
  const canHead = can("users:manage") || can("permissions:delegate");
  const Node = ({ id, role }: { id: string; role?: string }) => {
    const p = byId.get(id);
    if (!p) return null;
    return (
      <button className="org-node" onClick={() => onOpen(id)}>
        <Avatar p={p} size={28} />
        <span><b>{p.displayName}</b><span className="muted">{role ?? p.jobTitle}</span></span>
        <i className="wl-dot" style={{ background: WORKLOAD_META[p.workload].color }} title={`Yuklama: ${WORKLOAD_META[p.workload].label}`} />
      </button>
    );
  };
  return (
    <div className="org">
      <Msg m={msg} />
      {data.directors.length > 0 && <div className="org-top">{data.directors.map((d) => <Node key={d} id={d} role="Direktor" />)}</div>}
      <div className="org-deps">
        {data.departments.map((d) => {
          const members = d.members.filter((m) => m !== d.headId);
          return (
            <div key={d.id} className="org-dep" style={{ ["--dep" as string]: d.color }}>
              <div className="org-dep-head"><b>{d.name}</b><span className="muted">{d.members.length} xodim · {d.agents} AI agent</span></div>
              {d.headId ? <Node id={d.headId} role="Bo'lim rahbari" /> : <span className="muted">Rahbar tayinlanmagan</span>}
              {canHead && (
                <select aria-label={`${d.name} rahbari`} value={d.headId ?? ""} onChange={(e) =>
                  void run(() => api.put(`/api/departments/${d.id}/head`, { userId: e.target.value || null }), setMsg, "Rahbar tayinlandi.").then(reload)}>
                  <option value="">— rahbar tanlash —</option>
                  {data.people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </select>
              )}
              <div className="org-members">
                {members.map((m) => <Node key={m} id={m} />)}
                {!members.length && <span className="muted">Xodim yo'q</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- workload policy

interface Policy {
  yellow: number; orange: number; red: number; horizonDays: number; defaultHours: Record<"LOW" | "MEDIUM" | "HIGH" | "URGENT", number>;
  noDeadlineFactor: number; blockedFactor: number; dueSoonHours: number; dueSoonOrange: number; overdueRed: number;
}

function WorkloadSettings() {
  const { data } = useLoad<{ policy: Policy; defaults: Policy }>("/api/settings/workload");
  const [p, setP] = useState<Policy | null>(null);
  const [msg, setMsg] = useState<Note>(null);
  useEffect(() => { if (data && !p) setP(data.policy); }, [data, p]);
  if (!p || !data) return <Loading />;
  const num = (k: keyof Policy, label: string, step = 1) => (
    <label className="field">{label}<input type="number" step={step} value={p[k] as number} onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })} /></label>
  );
  const bad = !(p.yellow < p.orange && p.orange < p.red);
  return (
    <form className="ins-card" onSubmit={(e) => { e.preventDefault(); void run(() => api.put("/api/settings/workload", p), setMsg, "Saqlandi — yuklama darhol qayta hisoblanadi."); }}>
      <b>Yuklama ko'rsatkichi</b>
      <p className="hint">
        Talab = qolgan ish (baho − sarflangan, yoki baho × (1 − foiz)) × muddat koeffitsienti; sig'im = haftalik soat ÷ 5 × reja kunlari.
        Foiz bo'yicha rang, keyin muddat xavfi bo'yicha oshiriladi. Ko'rib chiqishdagi, bajarilgan va bekor qilingan ishlar hisobga kirmaydi.
      </p>
      <div className="form-grid">
        {num("yellow", "Sariq chegarasi, %")}{num("orange", "To'q sariq chegarasi, %")}{num("red", "Qizil chegarasi, %")}
        {num("horizonDays", "Reja oralig'i, ish kuni")}{num("dueSoonHours", "“Yaqin muddat”, soat")}{num("dueSoonOrange", "Shuncha yaqin muddat → to'q sariq")}
        {num("overdueRed", "Shuncha kechikkan → qizil")}{num("noDeadlineFactor", "Muddatsiz ish koeffitsienti", 0.05)}{num("blockedFactor", "Bloklangan ish koeffitsienti", 0.05)}
        {(["LOW", "MEDIUM", "HIGH", "URGENT"] as const).map((k) => (
          <label key={k} className="field">Baho yo'q — {k}, soat<input type="number" step={0.5} value={p.defaultHours[k]} onChange={(e) => setP({ ...p, defaultHours: { ...p.defaultHours, [k]: Number(e.target.value) } })} /></label>
        ))}
      </div>
      {bad && <span className="err">Chegaralar o'sib borishi kerak: sariq &lt; to'q sariq &lt; qizil</span>}
      <div className="row-end">
        <Msg m={msg} />
        <button type="button" className="link" onClick={() => setP(data.defaults)}>Standartga qaytarish</button>
        <button className="primary small" disabled={bad}>Saqlash</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- notifications bell

export function NotificationsBell({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { data, reload } = useLoad<{ items: NotificationDto[]; unread: number }>("/api/notifications");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const unread = data?.unread ?? 0;
  return (
    <div className="bell-wrap" ref={ref}>
      <button className={`tasks-btn${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-label={`Bildirishnomalar: ${unread} ta o'qilmagan`}>
        🔔{unread ? <b>{unread > 99 ? "99+" : unread}</b> : null}
      </button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label="Bildirishnomalar">
          <div className="sec-head"><b>Bildirishnomalar</b>{unread > 0 && <button className="link" onClick={() => void api.post("/api/notifications/read", { ids: "all" }).then(reload)}>Hammasini o'qildi</button>}</div>
          {!data ? <Loading /> : !data.items.length ? <Empty>Hozircha hech narsa yo'q.</Empty> : (
            <ul>
              {data.items.map((n) => (
                <li key={n.id} className={n.readAt ? "" : "unread"}>
                  <button onClick={() => {
                    void api.post("/api/notifications/read", { ids: [n.id] }).then(reload);
                    if (n.taskId) { onOpenTask(n.taskId); setOpen(false); }
                  }}>
                    <b>{n.title}</b>
                    {n.body && <span className="muted">{n.body}</span>}
                    <span className="muted">{fmtDate(n.createdAt, true)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
