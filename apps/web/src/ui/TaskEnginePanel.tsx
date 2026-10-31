// T1 Unified Task Engine panel: lifecycle, assignments (person or AI agent, with role and state), the transitions
// this viewer may make and recent activity. Shared by the AI task modal and the people's-work modal. Every button
// comes from the server's `can` (GET /api/tasks/:id/engine); the server re-checks each action.
import { useEffect, useState } from "react";
import type { AssigneeType, AssignmentRole, EmployeeCardDto, TaskEngineView, TaskLifecycle } from "@sag/shared";
import { api } from "../api/client";
import { useOffice } from "../api/office";

export const LIFECYCLE_LABEL: Record<TaskLifecycle, string> = {
  BACKLOG: "Backlog", PLANNED: "Rejalashtirilgan", ASSIGNED: "Biriktirilgan", IN_PROGRESS: "Bajarilmoqda", BLOCKED: "Bloklangan",
  IN_REVIEW: "Tekshiruvda", REVISION: "Qayta ishlashda", APPROVED: "Tasdiqlangan", COMPLETED: "Yakunlangan", CANCELLED: "Bekor qilingan",
};
const ACTION: Record<TaskLifecycle, string> = {
  BACKLOG: "Backlogga qaytarish", PLANNED: "Rejalashtirish", ASSIGNED: "Ishga berish", IN_PROGRESS: "Boshlash", BLOCKED: "Bloklash",
  IN_REVIEW: "Tekshiruvga topshirish", REVISION: "Qayta ishlashga qaytarish", APPROVED: "Tasdiqlash", COMPLETED: "Yakunlash", CANCELLED: "Bekor qilish",
};
const ROLE: Record<AssignmentRole, string> = { OWNER: "Ijrochi", CONTRIBUTOR: "Yordamchi", REVIEWER: "Tekshiruvchi", APPROVER: "Tasdiqlovchi" };
const STATE: Record<string, string> = { ASSIGNED: "kutilmoqda", ACCEPTED: "qabul qilgan", DECLINED: "rad etgan", RELEASED: "olib tashlangan" };
const NEEDS_REASON: TaskLifecycle[] = ["BLOCKED", "REVISION"];
const PRIORITY: Record<string, string> = { LOW: "Past", MEDIUM: "O'rta", HIGH: "Yuqori", CRITICAL: "Kritik" };

export function LifecycleTag({ lifecycle }: { lifecycle: TaskLifecycle }) {
  return <span className={`tag lc lc-${lifecycle.toLowerCase()}`}>{LIFECYCLE_LABEL[lifecycle]}</span>;
}

export function TaskEnginePanel({ taskId, onChanged }: { taskId: string; onChanged?: () => void }) {
  const { office, tick, user } = useOffice();
  const [v, setV] = useState<TaskEngineView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<AssigneeType>("HUMAN");
  const [who, setWho] = useState("");
  const [role, setRole] = useState<AssignmentRole>("CONTRIBUTOR");
  const [people, setPeople] = useState<EmployeeCardDto[]>([]);

  const load = () => api.get<TaskEngineView>(`/api/tasks/${taskId}/engine`).then((r) => { setV(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { void load(); }, [taskId, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (v?.can.assign && !people.length) api.get<{ employees: EmployeeCardDto[] }>("/api/employees").then((r) => setPeople(r.employees)).catch(() => {});
  }, [v?.can.assign]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      setV(await api.post<TaskEngineView>(`/api/tasks/${taskId}/${path}`, body));
      setErr(null);
      setReason("");
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      void load(); // a stale screen (409) shows the current state again
    } finally {
      setBusy(false);
    }
  };

  if (!v) return err ? <div className="notice warn">{err}</div> : null;
  const t = v.task;
  const active = v.assignments.filter((a) => a.state === "ASSIGNED" || a.state === "ACCEPTED");
  const past = v.assignments.filter((a) => !active.includes(a));
  const agents = (office?.agents ?? []).filter((a) => a.lifecycle === "ACTIVE");
  const roles: AssignmentRole[] = type === "AI_AGENT"
    ? (t.kind === "human" ? ["CONTRIBUTOR", "REVIEWER"] : ["OWNER", "CONTRIBUTOR", "REVIEWER"])
    : ["OWNER", "CONTRIBUTOR", "REVIEWER", "APPROVER"];

  return (
    <section className="engine">
      <div className="engine-head">
        <LifecycleTag lifecycle={t.lifecycle} />
        <span className="muted">Muhimlik: <b>{PRIORITY[t.priority] ?? t.priority}</b></span>
        {t.startAt && <span className="muted">Boshlanish: {new Date(t.startAt).toLocaleDateString()}</span>}
        {t.dueAt && <span className="muted">Muddat: {new Date(t.dueAt).toLocaleDateString()}</span>}
        {t.blockedReason && t.lifecycle === "BLOCKED" && <span className="err">Sabab: {t.blockedReason}</span>}
        <span className="muted small">v{t.version}</span>
      </div>
      {err && <div className="notice warn">{err}</div>}

      <h3>Ijrochilar</h3>
      {active.length ? (
        <table className="runs engine-asg">
          <tbody>
            {active.map((a) => (
              <tr key={a.id}>
                <td><span className={`tag ${a.assigneeType === "AI_AGENT" ? "ai" : "human"}`}>{a.assigneeType === "AI_AGENT" ? "AI" : "Inson"}</span> {a.assigneeName ?? a.assigneeId}</td>
                <td>{ROLE[a.role]}</td>
                <td className="muted">{STATE[a.state]}</td>
                <td className="row-end">
                  {a.assigneeType === "HUMAN" && a.assigneeId === user?.id && a.state === "ASSIGNED" && <>
                    <button className="link" disabled={busy} onClick={() => call(`assignments/${a.id}/accept`)}>Qabul qilish</button>
                    <button className="link danger" disabled={busy || !reason.trim()} title="Sababni pastdagi maydonga yozing"
                      onClick={() => call(`assignments/${a.id}/decline`, { reason })}>Rad etish</button>
                  </>}
                  {v.can.assign && <button className="link danger" disabled={busy} onClick={() => call(`assignments/${a.id}/release`, { version: t.version })}>Olib tashlash</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">Hali hech kim biriktirilmagan.</p>}
      {past.length > 0 && <p className="muted small">Avval: {past.map((a) => `${a.assigneeName ?? a.assigneeId} (${ROLE[a.role]}, ${STATE[a.state]}${a.reason ? `: ${a.reason}` : ""})`).join("; ")}</p>}

      {v.can.assign && (
        <div className="wf-actions engine-add">
          <select value={type} onChange={(e) => { setType(e.target.value as AssigneeType); setWho(""); }} aria-label="Ijrochi turi">
            <option value="HUMAN">Inson</option>
            <option value="AI_AGENT">AI agent</option>
          </select>
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Ijrochi">
            <option value="">Tanlang…</option>
            {type === "HUMAN"
              ? people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)
              : agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {office?.departments[a.departmentId]?.short}</option>)}
          </select>
          <select value={roles.includes(role) ? role : roles[0]} onChange={(e) => setRole(e.target.value as AssignmentRole)} aria-label="Rol">
            {roles.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
          </select>
          <button className="link" disabled={busy || !who}
            onClick={() => call("assignments", { assigneeType: type, assigneeId: who, role: roles.includes(role) ? role : roles[0], version: t.version }).then(() => setWho(""))}>
            Biriktirish
          </button>
        </div>
      )}

      {v.can.transitions.length > 0 && (
        <div className="wf-actions engine-moves">
          {v.can.transitions.map((to) => (
            <button key={to} className={to === "CANCELLED" || to === "REVISION" ? "link danger" : "primary small"} disabled={busy || (NEEDS_REASON.includes(to) && !reason.trim())}
              title={NEEDS_REASON.includes(to) ? "Sababni yozing" : undefined}
              onClick={() => (to !== "CANCELLED" || window.confirm("Vazifa bekor qilinsinmi?")) && call("lifecycle", { to, version: t.version, ...(reason.trim() ? { reason } : {}) })}>
              {ACTION[to]}
            </button>
          ))}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Sabab (bloklash, qaytarish, rad etish uchun)" aria-label="Sabab" />
        </div>
      )}

      {v.transitions.length > 0 && (
        <details className="engine-log">
          <summary>Faoliyat ({v.transitions.length})</summary>
          <ul>
            {v.transitions.slice(0, 12).map((x) => (
              <li key={x.id}>
                <span className="muted">{new Date(x.at).toLocaleString()}</span>{" "}
                {x.from ? `${LIFECYCLE_LABEL[x.from]} → ` : "Yaratildi: "}<b>{LIFECYCLE_LABEL[x.to]}</b>{" "}
                <span className="muted">· {x.actorName ?? (x.actor === "system" ? "tizim" : x.actor)}{x.reason ? ` · ${x.reason}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
