import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { TaskPriority } from "@sag/shared";
import { api } from "../api/client";
import { useOffice } from "../api/office";

// All calendar math is in Asia/Tashkent (UTC+5, no daylight saving): a "day" is a Tashkent day.
const TZ_MS = 5 * 3600_000;
const DAY = 86_400_000;
const WEEKDAYS = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];
const MONTHS = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];
const RRULE_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** Tashkent midnight (as a UTC instant) of the Tashkent day containing t. */
const dayStart = (t: number) => Math.floor((t + TZ_MS) / DAY) * DAY - TZ_MS;
const local = (t: number) => new Date(t + TZ_MS); // read with getUTC*
const hm = (iso: string) => local(Date.parse(iso)).toISOString().slice(11, 16);
/** Monday-based weekday index 0..6 */
const wd = (t: number) => (local(t).getUTCDay() + 6) % 7;

interface Item {
  kind: "task" | "routine" | "run";
  id: string; title: string; at: string; status: string;
  departmentId: string | null; agentId: string | null; taskId?: string | null; routineId?: string;
}
interface Run { id: string; scheduledFor: string; taskId: string | null; status: string; error: string | null }
interface Routine {
  id: string; name: string; description: string; departmentId: string | null; agentId: string | null; rrule: string; schedule: string;
  nextRunAt: string | null; lastRunAt: string | null; status: "ACTIVE" | "PAUSED"; requiresApproval: boolean; runs: Run[];
}

type View = "month" | "week" | "day";

export function CalendarPanel({ onClose, onOpenTask }: { onClose: () => void; onOpenTask: (id: string) => void }) {
  const { office, tick, can } = useOffice();
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => dayStart(Date.now()));
  const [dep, setDep] = useState("");
  const [agent, setAgent] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);

  const range = useMemo(() => {
    if (view === "day") return { from: cursor, to: cursor + DAY };
    if (view === "week") {
      const s = cursor - wd(cursor) * DAY;
      return { from: s, to: s + 7 * DAY };
    }
    const d = local(cursor);
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_MS;
    const s = first - wd(first) * DAY;
    return { from: s, to: s + 42 * DAY };
  }, [view, cursor]);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() });
    if (dep) qs.set("departmentId", dep);
    if (agent) qs.set("agentId", agent);
    Promise.all([api.get<{ items: Item[] }>(`/api/calendar?${qs}`), api.get<{ routines: Routine[] }>("/api/routines")])
      .then(([c, r]) => alive && (setItems(c.items), setRoutines(r.routines), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [range, dep, agent, tick, n]);

  const byDay = useMemo(() => {
    const m = new Map<number, Item[]>();
    for (const it of items) {
      const k = dayStart(Date.parse(it.at));
      m.set(k, [...(m.get(k) ?? []), it]);
    }
    return m;
  }, [items]);

  const step = (dir: number) => {
    if (view === "day") setCursor((c) => c + dir * DAY);
    else if (view === "week") setCursor((c) => c + dir * 7 * DAY);
    else {
      const d = local(cursor);
      setCursor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1) - TZ_MS);
    }
  };
  const title = (() => {
    const d = local(cursor);
    if (view === "day") return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (view === "week") {
      const a = local(range.from), b = local(range.to - DAY);
      return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} — ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
    }
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  })();
  const today = dayStart(Date.now());
  const agents = (office?.agents ?? []).filter((a) => !dep || a.departmentId === dep);
  const open = (it: Item) => it.taskId && onOpenTask(it.taskId);

  const chip = (it: Item, withTime = true) => (
    <button key={it.id} className={`cal-item k-${it.kind} s-${it.status}`} onClick={(e) => (e.stopPropagation(), open(it))}
      title={`${it.title} · ${it.kind === "routine" ? "rejalashtirilgan (routine)" : it.status}`}>
      {withTime && <span className="cal-time">{hm(it.at)}</span>}
      {it.kind !== "task" && <span aria-hidden>↻ </span>}
      {it.title}
    </button>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal calendar" role="dialog" aria-label="Kalendar" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">Vazifalar, routine'lar va bajarilganlar tarixi · Asia/Tashkent</div>
            <h2>Kalendar</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="cal-toolbar">
          <div className="seg" role="group" aria-label="Ko'rinish">
            {(["month", "week", "day"] as View[]).map((v) => (
              <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{v === "month" ? "Oy" : v === "week" ? "Hafta" : "Kun"}</button>
            ))}
          </div>
          <button className="back" onClick={() => step(-1)} aria-label="Oldingi">‹</button>
          <button className="back" onClick={() => setCursor(today)}>Bugun</button>
          <button className="back" onClick={() => step(1)} aria-label="Keyingi">›</button>
          <b className="cal-title">{title}</b>
          <select value={dep} onChange={(e) => (setDep(e.target.value), setAgent(""))} aria-label="Bo'lim">
            <option value="">Barcha bo'limlar</option>
            {Object.values(office?.departments ?? {}).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
            <option value="">Barcha agentlar</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {error && <div className="login-error">{error}</div>}
        <div className="cal-body">
          <div className="cal-main">
            {view === "month" && (
              <div className="cal-month">
                {WEEKDAYS.map((w) => <div key={w} className="cal-wd">{w}</div>)}
                {Array.from({ length: 42 }, (_, i) => {
                  const t = range.from + i * DAY;
                  const list = byDay.get(t) ?? [];
                  const inMonth = local(t).getUTCMonth() === local(cursor).getUTCMonth();
                  return (
                    <div key={t} role="button" tabIndex={0}
                      className={`cal-cell${inMonth ? "" : " out"}${t === today ? " today" : ""}${selected === t ? " sel" : ""}`}
                      onClick={() => setSelected(t)} onKeyDown={(e) => e.key === "Enter" && setSelected(t)}>
                      <span className="cal-num">{local(t).getUTCDate()}</span>
                      {list.slice(0, 3).map((it) => chip(it))}
                      {list.length > 3 && <button className="cal-more" onClick={(e) => (e.stopPropagation(), setCursor(t), setView("day"))}>+{list.length - 3}</button>}
                    </div>
                  );
                })}
              </div>
            )}
            {view === "week" && (
              <div className="cal-week">
                {Array.from({ length: 7 }, (_, i) => {
                  const t = range.from + i * DAY;
                  return (
                    <div key={t} className={`cal-col${t === today ? " today" : ""}${selected === t ? " sel" : ""}`} onClick={() => setSelected(t)}>
                      <div className="cal-col-head">{WEEKDAYS[i]} {local(t).getUTCDate()}</div>
                      {(byDay.get(t) ?? []).map((it) => chip(it))}
                    </div>
                  );
                })}
              </div>
            )}
            {view === "day" && (
              <div className="cal-day" onClick={() => setSelected(cursor)}>
                {(byDay.get(cursor) ?? []).length ? (byDay.get(cursor) ?? []).map((it) => (
                  <div key={it.id} className="cal-row">
                    <span className="cal-time">{hm(it.at)}</span>
                    {chip(it, false)}
                    <span className="muted">{office?.departments[it.departmentId ?? ""]?.short ?? ""} {office?.agents.find((a) => a.id === it.agentId)?.name ?? ""}</span>
                  </div>
                )) : <p className="hint">Bu kunda hech narsa yo'q. Rejalashtirish uchun kunni bosing.</p>}
              </div>
            )}
            <div className="cal-legend">
              <span className="cal-item k-task">Vazifa</span><span className="cal-item k-routine">↻ Rejadagi routine</span><span className="cal-item k-run s-succeeded">↻ Bajarilgan routine</span>
            </div>
          </div>
          <aside className="cal-side">
            {selected !== null && can("ai_tasks:create") && (
              <ScheduleForm day={selected} onDone={() => (setSelected(null), reload())} onCancel={() => setSelected(null)} canRepeat={can("tasks:manage")} />
            )}
            <RoutineList routines={routines} onChange={reload} onOpenTask={onOpenTask} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function ScheduleForm({ day, onDone, onCancel, canRepeat }: { day: number; onDone: () => void; onCancel: () => void; canRepeat: boolean }) {
  const { office } = useOffice();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dep, setDep] = useState("");
  const [agent, setAgent] = useState("");
  const [time, setTime] = useState("09:00");
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM");
  const [approval, setApproval] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [freq, setFreq] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [days, setDays] = useState<string[]>(() => [RRULE_DAYS[wd(day)]]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setDays([RRULE_DAYS[wd(day)]]), [day]);

  const [hh, mm] = time.split(":").map(Number);
  const at = day + (hh * 60 + mm) * 60_000; // Tashkent midnight + local time
  const monthDay = local(day).getUTCDate();
  const agents = (office?.agents ?? []).filter((a) => a.departmentId === dep && a.lifecycle === "ACTIVE");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (repeat) {
        const by = freq === "WEEKLY" ? `;BYDAY=${days.join(",")}` : freq === "MONTHLY" ? `;BYMONTHDAY=${monthDay}` : "";
        await api.post("/api/routines", {
          name: title.trim(), description: description.trim() || undefined, departmentId: dep || undefined, agentId: agent || undefined,
          rrule: `FREQ=${freq}${by};BYHOUR=${hh};BYMINUTE=${mm}`, priority, requiresApproval: approval,
          startAt: new Date(Math.max(Date.now(), day)).toISOString(),
        });
      } else {
        if (at < Date.now() - 60_000) throw new Error("Bu vaqt o'tib ketgan — keyingi vaqtni tanlang");
        await api.post("/api/tasks", {
          title: title.trim(), description: description.trim() || undefined, departmentId: dep || undefined, agentId: agent || undefined,
          priority, requiresApproval: approval || undefined, scheduledFor: new Date(at).toISOString(),
        });
      }
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  const d = local(day);
  return (
    <form className="ins-card new" onSubmit={submit}>
      <div className="ins-head"><b>{d.getUTCDate()} {MONTHS[d.getUTCMonth()]} — rejalashtirish</b><button type="button" className="link" onClick={onCancel}>Yopish</button></div>
      <input placeholder="Vazifa (masalan: Haftalik savdo hisoboti)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      <textarea rows={2} placeholder="Tafsilotlar (ixtiyoriy)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="nt-row">
        <select value={dep} onChange={(e) => (setDep(e.target.value), setAgent(""))}>
          <option value="">Avto — Director taqsimlaydi</option>
          {Object.values(office?.departments ?? {}).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={!dep}>
          <option value="">{dep ? "Avto" : "—"}</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div className="nt-row">
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
        <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          <option value="LOW">Past</option><option value="MEDIUM">O'rta</option><option value="HIGH">Yuqori</option><option value="CRITICAL">Kritik</option>
        </select>
      </div>
      <label className="toggle"><input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Natija tasdiqlansin</label>
      {canRepeat && <label className="toggle"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Takrorlansin (routine)</label>}
      {repeat && (
        <div className="repeat-box">
          <div className="seg wide">
            {(["DAILY", "WEEKLY", "MONTHLY"] as const).map((f) => (
              <button type="button" key={f} className={freq === f ? "on" : ""} onClick={() => setFreq(f)}>{f === "DAILY" ? "Har kuni" : f === "WEEKLY" ? "Har hafta" : "Har oy"}</button>
            ))}
          </div>
          {freq === "WEEKLY" && (
            <div className="days">
              {RRULE_DAYS.map((x, i) => (
                <label key={x} className={days.includes(x) ? "on" : ""}>
                  <input type="checkbox" checked={days.includes(x)} onChange={() => setDays((s) => (s.includes(x) ? s.filter((y) => y !== x) : [...s, x]))} />
                  {WEEKDAYS[i]}
                </label>
              ))}
            </div>
          )}
          {freq === "MONTHLY" && <p className="hint">Har oyning {monthDay}-sanasida (qisqa oylarda — oxirgi kuni).</p>}
        </div>
      )}
      {err && <div className="login-error">{err}</div>}
      <div className="row-end">
        <button className="primary small" disabled={busy || !title.trim() || (repeat && freq === "WEEKLY" && !days.length)}>
          {busy ? "…" : repeat ? "Routine yaratish" : "Rejalashtirish"}
        </button>
      </div>
    </form>
  );
}

function RoutineList({ routines, onChange, onOpenTask }: { routines: Routine[]; onChange: () => void; onOpenTask: (id: string) => void }) {
  const { office, can } = useOffice();
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setErr(null);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <div className="routines">
      <h3>Routine'lar ({routines.length})</h3>
      {err && <div className="login-error">{err}</div>}
      {!routines.length && <p className="hint">Hali yo'q. Kunni bosing va "Takrorlansin" ni belgilang.</p>}
      {routines.map((r) => (
        <div key={r.id} className={`routine${r.status === "PAUSED" ? " paused" : ""}`}>
          <div className="ins-head">
            <b>{r.name}</b>
            <span className="muted">{r.status === "PAUSED" ? "to'xtatilgan" : `keyingi: ${fmt(r.nextRunAt)}`}</span>
          </div>
          <div className="muted">
            {r.schedule} · {r.agentId ? office?.agents.find((a) => a.id === r.agentId)?.name : r.departmentId ? office?.departments[r.departmentId]?.name : "Director taqsimlaydi"}
            {r.requiresApproval ? " · tasdiq bilan" : ""}
          </div>
          {can("tasks:manage") && (
            <div className="mem-actions">
              {r.status === "ACTIVE"
                ? <button onClick={() => void act(() => api.post(`/api/routines/${r.id}/pause`))}>Pause</button>
                : <button onClick={() => void act(() => api.post(`/api/routines/${r.id}/resume`))}>Resume</button>}
              <button onClick={() => void act(() => api.post(`/api/routines/${r.id}/run`))}>Hozir ishga tushirish</button>
              <button className="danger" onClick={() => window.confirm(`"${r.name}" o'chirilsinmi? Yaratilgan vazifalar saqlanadi.`) && void act(() => api.del(`/api/routines/${r.id}`))}>O'chirish</button>
              <button className="link" onClick={() => setOpen(open === r.id ? null : r.id)}>Tarix ({r.runs.length})</button>
            </div>
          )}
          {open === r.id && (
            <ul className="timeline">
              {r.runs.map((x) => (
                <li key={x.id}>
                  <span className="muted">{fmt(x.scheduledFor)}</span> {x.status}
                  {x.taskId && <button className="link" onClick={() => onOpenTask(x.taskId!)}> vazifa →</button>}
                  {x.error && <span className="err"> {x.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
