import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { TaskDto, TaskPriority } from "@sag/shared";
import { api } from "../api/client";
import { useOffice } from "../api/office";
import type { SystemStatus } from "../api/system";
import { TaskStatusPill } from "./shared";

const FILTERS: [string, string][] = [
  ["ALL", "Hammasi"], ["BACKLOG", "Navbat"], ["IN_PROGRESS", "Jarayonda"], ["WAITING", "Kutmoqda"], ["DONE", "Bajarildi"], ["FAILED", "Xato"],
];
const PRIORITIES: [TaskPriority, string][] = [["LOW", "Past"], ["MEDIUM", "O'rta"], ["HIGH", "Yuqori"], ["URGENT", "Shoshilinch"]];

export function TaskPanel({ onClose, onOpen, system }: { onClose: () => void; onOpen: (id: string) => void; system: SystemStatus | null }) {
  const { office, tick, can } = useOffice();
  const [filter, setFilter] = useState("ALL");
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => setBucket(tick), 400);
    return () => window.clearTimeout(t);
  }, [tick]);

  useEffect(() => {
    let alive = true;
    api
      .get<{ tasks: TaskDto[] }>(`/api/tasks?group=${filter}&topLevel=true&limit=100`)
      .then((r) => alive && (setTasks(r.tasks), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [filter, bucket]);

  const agentName = (id: string | null) => office?.agents.find((a) => a.id === id)?.name ?? "—";
  const depName = (id: string | null) => (id ? office?.departments[id]?.name ?? id : "Yo'naltirilmagan");

  return (
    <aside className="task-drawer" aria-label="Vazifalar">
      <div className="drawer-head">
        <h2>Vazifalar</h2>
        <button className="close" onClick={onClose} aria-label="Yopish">×</button>
      </div>
      {system && !system.llm.configured && (
        <div className="notice warn">
          AI ulanmagan: {system.llm.reason}. Vazifalar navbatda qoladi — <code>.env</code> ga <code>GEMINI_API_KEY</code> qo'shing.
        </div>
      )}
      {system?.llm.mode === "mock" && <div className="notice">MOCK rejim: javoblar sinov uchun, haqiqiy AI emas.</div>}
      {can("tasks:create") && <NewTask />}
      <div className="seg wide" role="group" aria-label="Filtr">
        {FILTERS.map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      {error && <p className="hint err">{error}</p>}
      <ul className="task-cards">
        {tasks.map((t) => (
          <li key={t.id}>
            <button onClick={() => onOpen(t.id)}>
              <div className="tc-top">
                <span className="tc-title">{t.title}</span>
                <TaskStatusPill status={t.status} />
              </div>
              <div className="tc-meta">
                {t.kind === "orchestrate" ? <span className="badge">Bo'limlararo</span> : <span>{agentName(t.agentId)}</span>}
                <span>·</span>
                <span>{depName(t.departmentId)}</span>
                <span>·</span>
                <span className={`prio p-${t.priority}`}>{PRIORITIES.find((p) => p[0] === t.priority)?.[1]}</span>
                <span className="tc-time">{t.deadline ? `muddat ${t.deadline.slice(0, 10)}` : new Date(t.createdAt).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              {(t.status === "IN_PROGRESS" || t.status === "WAITING_FOR_DEPENDENCY" || t.progress !== null) && t.status !== "DONE" && (
                <div className="tc-progress">
                  {t.progress !== null && <div className="bar"><i style={{ width: `${t.progress}%` }} /></div>}
                  {t.stage && <span>{t.stage}</span>}
                </div>
              )}
            </button>
          </li>
        ))}
        {!tasks.length && !error && <li className="empty">Hozircha vazifa yo'q.</li>}
      </ul>
    </aside>
  );
}

function NewTask() {
  const { office } = useOffice();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dep, setDep] = useState("");
  const [agent, setAgent] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM");
  const [deadline, setDeadline] = useState("");
  const [approval, setApproval] = useState(false);
  const [lim, setLim] = useState({ tokens: "", cost: "", minutes: "", agents: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);

  const deps = useMemo(() => Object.values(office?.departments ?? {}), [office]);
  const agents = useMemo(() => office?.agents.filter((a) => a.departmentId === dep && a.lifecycle === "ACTIVE") ?? [], [office, dep]);

  /** Only the ceilings the user filled in; empty → server defaults. */
  const limits = () => {
    const l: Record<string, number> = {};
    if (+lim.tokens > 0) l.maxTokens = Math.round(+lim.tokens);
    if (+lim.cost > 0) l.maxCostUsd = +lim.cost;
    if (+lim.minutes > 0) l.maxDurationMs = Math.round(+lim.minutes * 60_000);
    if (+lim.agents > 0) l.maxAgents = Math.round(+lim.agents);
    return Object.keys(l).length ? l : undefined;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ task: TaskDto }>("/api/tasks", {
        title: title.trim(),
        description: description.trim() || undefined,
        departmentId: dep || undefined,
        agentId: agent || undefined,
        priority,
        deadline: deadline ? new Date(`${deadline}T18:00:00+05:00`).toISOString() : undefined,
        requiresApproval: approval || undefined,
        limits: limits(),
      });
      setMsg({ ok: true, text: r.task.kind === "orchestrate" ? "Qabul qilindi: Director bo'limlarga taqsimlaydi." : "Qabul qilindi." });
      setTitle("");
      setDescription("");
      setAgent("");
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="new-task" onSubmit={submit}>
      <textarea
        placeholder="Topshiriqni yozing… masalan: Keyingi oy uchun marketing strategiyasi, raqobatchilar tahlili, kontent rejasi va budjet."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={() => setOpen(true)}
        rows={open ? 3 : 2}
        maxLength={200}
        required
      />
      {open && (
        <>
          <textarea placeholder="Qo'shimcha tafsilotlar (ixtiyoriy)" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={20000} />
          <div className="nt-row">
            <select value={dep} onChange={(e) => (setDep(e.target.value), setAgent(""))} aria-label="Bo'lim">
              <option value="">Avto — Director taqsimlaydi</option>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={!dep} aria-label="Agent">
              <option value="">{dep ? "Avto (eng bo'sh agent)" : "—"}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
            </select>
          </div>
          <div className="nt-row">
            <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} aria-label="Muhimlik">
              {PRIORITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} aria-label="Muddat" />
          </div>
          <label className="toggle">
            <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Natija mening tasdig'imdan keyin "bajarildi" bo'lsin
          </label>
          <details className="limits">
            <summary>Limitlar (ixtiyoriy)</summary>
            <div className="nt-row">
              <input type="number" min={1000} step={1000} placeholder="Maks. token (masalan 30000)" value={lim.tokens} onChange={(e) => setLim({ ...lim, tokens: e.target.value })} />
              <input type="number" min={0} step={0.01} placeholder="Maks. xarajat, $" value={lim.cost} onChange={(e) => setLim({ ...lim, cost: e.target.value })} />
            </div>
            <div className="nt-row">
              <input type="number" min={1} placeholder="Maks. vaqt, daqiqa" value={lim.minutes} onChange={(e) => setLim({ ...lim, minutes: e.target.value })} />
              <input type="number" min={1} max={6} placeholder="Maks. bo'limlar (avto)" value={lim.agents} onChange={(e) => setLim({ ...lim, agents: e.target.value })} disabled={!!dep} />
            </div>
          </details>
        </>
      )}
      <div className="nt-actions">
        {msg && <span className={msg.ok ? "ok" : "err"}>{msg.text}</span>}
        <button type="submit" className="primary small" disabled={busy || !title.trim()}>{busy ? "…" : "Qo'shish"}</button>
      </div>
    </form>
  );
}
