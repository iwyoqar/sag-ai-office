// People's work: views (my / team / department / company / review / overdue / blocked), Kanban + list,
// create / assign / split, and the task detail with every workflow action the server allows.
import { useState, type FormEvent } from "react";
import type { EmployeeCardDto, TaskDto, TaskPriority, TaskStatus } from "@sag/shared";
import { TASK_PRIORITIES } from "@sag/shared";
import { api } from "../../api/client";
import { useOffice } from "../../api/office";
import { TASK_STATUS_META } from "../../config/status";
import { TaskStatusPill } from "../shared";
import { Empty, Loading, Msg, errorText, fmtDate, fromLocalInput, run, useLoad, type Note } from "./common";

export interface WorkItem extends TaskDto {
  assigneeName: string | null;
  subtasks: { total: number; done: number; required: number };
  overdue: boolean;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = { LOW: "Past", MEDIUM: "O'rta", HIGH: "Yuqori", URGENT: "Shoshilinch" };
const BOARD: TaskStatus[] = ["BACKLOG", "ASSIGNED", "ACCEPTED", "IN_PROGRESS", "IN_REVIEW", "CHANGES_REQUESTED", "BLOCKED", "DONE", "CANCELLED"];

export type View = "my" | "team" | "department" | "company" | "review" | "overdue" | "blocked";
const VIEWS: [View, string][] = [
  ["my", "Mening vazifalarim"], ["team", "Jamoa"], ["department", "Bo'lim"], ["company", "Butun kompaniya"],
  ["review", "Ko'rib chiqish"], ["overdue", "Muddati o'tgan"], ["blocked", "Bloklangan"],
];

export function WorkBoard({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { can, user } = useOffice();
  const [view, setView] = useState<View>("my");
  const [mode, setMode] = useState<"board" | "list">("board");
  const [q, setQ] = useState("");
  const [done, setDone] = useState(false);
  const leads = !!user?.managedDepartments?.length;
  const views = VIEWS.filter(([v]) => v !== "company" || can("tasks:read_all") || can("tasks:assign_any"))
    .filter(([v]) => v !== "department" || leads || can("tasks:read_team") || can("tasks:read_all"));
  const params = new URLSearchParams({ view, ...(q.trim() ? { q: q.trim() } : {}), ...(done ? { includeDone: "true" } : {}) });
  const { data, error, loading } = useLoad<{ tasks: WorkItem[] }>(`/api/work?${params}`);
  const items = data?.tasks ?? [];
  return (
    <>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Ko'rinish">
          {views.map(([v, l]) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{l}</button>)}
        </div>
        <input type="search" placeholder="Qidirish…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Vazifa qidirish" />
        <label className="check"><input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />Yakunlanganlar</label>
        <div className="seg">
          <button className={mode === "board" ? "on" : ""} onClick={() => setMode("board")}>Kanban</button>
          <button className={mode === "list" ? "on" : ""} onClick={() => setMode("list")}>Ro'yxat</button>
        </div>
        <button className="primary small" onClick={onNew}>+ Vazifa</button>
      </div>
      {error && <div className="notice warn">{error}</div>}
      {loading && !data ? <Loading /> : mode === "list" ? (
        <WorkList items={items} onOpen={onOpen} empty={view === "my" ? "Sizda ochiq vazifa yo'q." : "Bu ko'rinishda vazifa yo'q."} detailed />
      ) : (
        <div className="kanban">
          {BOARD.filter((s) => done || (s !== "DONE" && s !== "CANCELLED")).map((s) => {
            const col = items.filter((t) => t.status === s);
            return (
              <div key={s} className="kcol">
                <div className="kcol-head" style={{ ["--c" as string]: TASK_STATUS_META[s].color }}><i />{TASK_STATUS_META[s].label}<b>{col.length}</b></div>
                {col.map((t) => <Card key={t.id} t={t} onOpen={onOpen} />)}
                {!col.length && <div className="kempty">—</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function Card({ t, onOpen }: { t: WorkItem; onOpen: (id: string) => void }) {
  return (
    <button className={`kcard${t.overdue ? " overdue" : ""}`} onClick={() => onOpen(t.id)}>
      <b>{t.title}</b>
      <span className="muted">{t.assigneeName ?? "Biriktirilmagan"}{t.isOptional ? " · ixtiyoriy" : ""}</span>
      <span className="kmeta">
        <span className={`prio p-${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
        {t.deadline && <span className={t.overdue ? "err" : "muted"}>{t.overdue ? "⚠ " : ""}{fmtDate(t.deadline)}</span>}
        {t.subtasks.total > 0 && <span className="muted">{t.subtasks.done}/{t.subtasks.total}</span>}
      </span>
      {t.progress != null && t.status !== "DONE" && <span className="kbar"><i style={{ width: `${t.progress}%` }} /></span>}
    </button>
  );
}

export function WorkList({ items, onOpen, empty, detailed }: { items: WorkItem[]; onOpen: (id: string) => void; empty: string; detailed?: boolean }) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="runs work-table">
        <thead><tr><th>Vazifa</th><th>Holat</th>{detailed && <th>Ijrochi</th>}<th>Muhimlik</th><th>Muddat</th><th>Bajarilish</th></tr></thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id} onClick={() => onOpen(t.id)} className="clickable">
              <td><b>{t.title}</b>{t.parentId && <span className="muted"> · kichik vazifa</span>}{t.subtasks.total > 0 && <span className="muted"> · {t.subtasks.done}/{t.subtasks.total} kichik</span>}</td>
              <td><TaskStatusPill status={t.status} /></td>
              {detailed && <td>{t.assigneeName ?? "—"}</td>}
              <td>{PRIORITY_LABEL[t.priority]}</td>
              <td className={t.overdue ? "err" : ""}>{fmtDate(t.deadline)}</td>
              <td>{t.progress != null ? `${t.progress}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- create / assign / split

export function NewWork({ parent, assigneeId, onClose, onCreated }: {
  parent?: { id: string; title: string }; assigneeId?: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const { user } = useOffice();
  const { data } = useLoad<{ employees: EmployeeCardDto[] }>("/api/employees");
  const [f, setF] = useState({
    title: "", description: "", assigneeId: assigneeId ?? user?.id ?? "", priority: "MEDIUM" as TaskPriority, deadline: "",
    estimateHours: "", requiresReview: "auto", reviewerId: "", isOptional: false, weight: "1",
  });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const people = data?.employees ?? [];
  const self = f.assigneeId === user?.id;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Sarlavha kerak");
    const est = f.estimateHours ? Number(f.estimateHours) : null;
    if (est != null && !(est >= 0 && est <= 1000)) return setErr("Baho 0–1000 soat");
    if (f.deadline && fromLocalInput(f.deadline)! < new Date().toISOString() && !window.confirm("Muddat o'tib ketgan. Shunday qoldirilsinmi?")) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ task: TaskDto }>("/api/work", {
        title: f.title.trim(), description: f.description, assigneeId: f.assigneeId || null, parentId: parent?.id ?? null,
        priority: f.priority, deadline: fromLocalInput(f.deadline), estimateHours: est,
        ...(f.requiresReview === "auto" ? {} : { requiresReview: f.requiresReview === "yes" }),
        ...(f.reviewerId ? { reviewerId: f.reviewerId } : {}),
        ...(parent ? { isOptional: f.isOptional, weight: Number(f.weight) || 1 } : {}),
      });
      onCreated(r.task.id);
    } catch (x) {
      setMsg({ ok: false, text: errorText(x) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal account wide" role="dialog" aria-label="Yangi vazifa" onClick={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="modal-head">
          <div>
            <div className="muted">{parent ? `Kichik vazifa: ${parent.title}` : "Xodim vazifasi"}</div>
            <h2>{parent ? "Vazifani bo'lish" : "Yangi vazifa"}</h2>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="modal-body">
          <Msg m={msg} />
          <label className={`field${err ? " invalid" : ""}`}>Sarlavha *<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />{err && <span className="err">{err}</span>}</label>
          <label className="field">Tavsif<textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <div className="form-grid">
            <label className="field">Ijrochi
              <select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
                <option value={user?.id}>Men o'zim (shaxsiy vazifa)</option>
                {people.filter((p) => p.id !== user?.id).map((p) => <option key={p.id} value={p.id}>{p.displayName}{p.jobTitle ? ` — ${p.jobTitle}` : ""}</option>)}
              </select>
            </label>
            <label className="field">Muhimlik
              <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as TaskPriority })}>
                {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </label>
            <label className="field">Muddat<input type="datetime-local" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></label>
            <label className="field">Baho (soat)<input type="number" min={0} max={1000} step={0.5} value={f.estimateHours} onChange={(e) => setF({ ...f, estimateHours: e.target.value })} placeholder="masalan 4" /></label>
            <label className="field">Ko'rib chiqish
              <select value={f.requiresReview} onChange={(e) => setF({ ...f, requiresReview: e.target.value })}>
                <option value="auto">{self ? "Kerak emas (shaxsiy)" : "Kerak — men tasdiqlayman"}</option>
                <option value="yes">Kerak</option>
                <option value="no">Kerak emas — ijrochi o'zi yakunlaydi</option>
              </select>
            </label>
            {f.requiresReview !== "no" && (
              <label className="field">Tekshiruvchi
                <select value={f.reviewerId} onChange={(e) => setF({ ...f, reviewerId: e.target.value })}>
                  <option value="">{self ? "Rahbarim" : "Men"}</option>
                  {people.filter((p) => p.id !== f.assigneeId).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </select>
              </label>
            )}
            {parent && (
              <>
                <label className="check"><input type="checkbox" checked={f.isOptional} onChange={(e) => setF({ ...f, isOptional: e.target.checked })} />Ixtiyoriy (yakunlanishni to'smaydi)</label>
                <label className="field">Og'irlik<input type="number" min={0.1} max={100} step={0.5} value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></label>
              </>
            )}
          </div>
          <div className="row-end">
            <button type="button" className="link" onClick={onClose}>Bekor qilish</button>
            <button className="primary small" disabled={busy}>{busy ? "Yaratilmoqda…" : "Yaratish"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- detail

interface Detail {
  task: WorkItem;
  parent: { id: string; title: string; status: TaskStatus } | null;
  subtasks: WorkItem[];
  comments: { id: string; kind: string; body: string; createdAt: string; userName: string | null }[];
  reviews: { id: string; decision: string; comment: string; createdAt: string; reviewerName: string }[];
  attachments: { id: string; filename: string; sizeBytes: number; createdAt: string; userName: string | null }[];
  history: { id: number; type: string; at: string; actorName: string | null; data: { from?: string; to?: string; reason?: string | null; auto?: boolean } }[];
  can: { manage: boolean; act: boolean; review: boolean; split: boolean };
}

const KIND_LABEL: Record<string, string> = { comment: "Izoh", progress: "Jarayon", result: "Natija", decline: "Rad etish sababi", review: "Ko'rib chiqish", system: "Tizim" };

export function WorkDetail({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { data, error, reload } = useLoad<Detail>(`/api/work/${id}`);
  const { data: dir } = useLoad<{ employees: EmployeeCardDto[] }>("/api/employees");
  const [msg, setMsg] = useState<Note>(null);
  const [text, setText] = useState("");
  const [progress, setProgress] = useState("");
  const [hours, setHours] = useState("");
  const [split, setSplit] = useState(false);
  const [assignee, setAssignee] = useState("");
  const t = data?.task;
  const act = (path: string, body: unknown, ok: string, clear = true) =>
    void run(() => api.post(`/api/work/${id}/${path}`, body), setMsg, ok).then((done) => { if (done) { if (clear) setText(""); reload(); } });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal person" role="dialog" aria-label="Vazifa" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">{data?.parent ? <>Asosiy vazifa: <button className="link" onClick={() => onOpen(data.parent!.id)}>{data.parent.title}</button></> : "Xodim vazifasi"}</div>
            <h2>{t?.title ?? "Vazifa"}</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="notice warn">{error}</div>}
          {!data && !error && <Loading />}
          <Msg m={msg} />
          {t && data && (
            <>
              <section className="kv-grid">
                <div><span>Holat</span><b><TaskStatusPill status={t.status} /></b></div>
                <div><span>Ijrochi</span><b>{t.assigneeName ?? "Biriktirilmagan"}</b></div>
                <div><span>Muhimlik</span><b>{PRIORITY_LABEL[t.priority]}</b></div>
                <div><span>Muddat</span><b className={t.overdue ? "err" : ""}>{fmtDate(t.deadline, true)}</b></div>
                <div><span>Baho / sarflangan</span><b>{t.estimateHours ?? "—"} / {t.actualHours ?? "—"} soat</b></div>
                <div><span>Bajarilish</span><b>{t.progress != null ? `${t.progress}%` : "—"}{t.stage ? ` · ${t.stage}` : ""}</b></div>
                <div><span>Ko'rib chiqish</span><b>{t.requiresApproval ? "kerak" : "kerak emas"}</b></div>
                <div><span>Yaratilgan</span><b>{fmtDate(t.createdAt, true)}</b></div>
              </section>
              {t.description && <p className="desc">{t.description}</p>}
              {t.declineReason && t.status === "BACKLOG" && <div className="notice">Rad etilgan: {t.declineReason}</div>}

              {/* assignee actions */}
              {data.can.act && (
                <div className="wf-actions">
                  {t.status === "ASSIGNED" && <>
                    <button className="primary small" onClick={() => act("accept", {}, "Qabul qilindi.")}>Qabul qilish</button>
                    <button className="link danger" onClick={() => text.trim() ? act("decline", { reason: text }, "Rad etildi.") : setMsg({ ok: false, text: "Rad etish sababini izoh maydoniga yozing." })}>Rad etish</button>
                  </>}
                  {["ACCEPTED", "CHANGES_REQUESTED", "BLOCKED"].includes(t.status) && <button className="primary small" onClick={() => act("start", {}, "Ish boshlandi.")}>Boshlash</button>}
                  {t.status === "IN_PROGRESS" && <>
                    {!t.subtasks.total && <input type="number" min={0} max={100} placeholder="%" value={progress} onChange={(e) => setProgress(e.target.value)} aria-label="Bajarilish foizi" />}
                    <input type="number" min={0} step={0.5} placeholder="soat" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Sarflangan soat" />
                    <button className="link" onClick={() => act("progress", {
                      ...(progress !== "" ? { progress: Number(progress) } : {}), ...(hours !== "" ? { actualHours: Number(hours) } : {}), ...(text.trim() ? { note: text } : {}),
                    }, "Jarayon yangilandi.")}>Jarayonni saqlash</button>
                    <button className="primary small" onClick={() => act("submit", { result: text }, t.requiresApproval ? "Ko'rib chiqishga yuborildi." : "Bajarildi.")}>
                      {t.requiresApproval ? "Ko'rib chiqishga yuborish" : "Yakunlash"}
                    </button>
                  </>}
                  {["ACCEPTED", "IN_PROGRESS", "CHANGES_REQUESTED"].includes(t.status) && (
                    <button className="link" onClick={() => text.trim() ? act("block", { reason: text }, "Bloklandi.") : setMsg({ ok: false, text: "Bloklanish sababini izoh maydoniga yozing." })}>Bloklandi deb belgilash</button>
                  )}
                </div>
              )}
              {data.can.review && (
                <div className="wf-actions review">
                  <b>Ko'rib chiqish</b>
                  <button className="primary small" onClick={() => act("approve", { comment: text }, "Tasdiqlandi.")}>Tasdiqlash</button>
                  <button className="link danger" onClick={() => text.trim() ? act("request-changes", { comment: text }, "O'zgartirish so'raldi.") : setMsg({ ok: false, text: "Nimani o'zgartirish kerakligini izoh maydoniga yozing." })}>O'zgartirish so'rash</button>
                </div>
              )}
              {data.can.manage && t.status !== "DONE" && t.status !== "CANCELLED" && (
                <div className="wf-actions">
                  {t.status === "BLOCKED" && !data.can.act && <button className="link" onClick={() => act("unblock", { reason: text }, "Blok olindi.")}>Blokni olish</button>}
                  {t.status !== "IN_REVIEW" && <>
                    <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Yangi ijrochi">
                      <option value="">{t.assigneeUserId ? "Qayta biriktirish…" : "Biriktirish…"}</option>
                      {(dir?.employees ?? []).filter((p) => p.id !== t.assigneeUserId).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                    </select>
                    <button className="link" disabled={!assignee} onClick={() => { act("assign", { assigneeId: assignee }, "Biriktirildi."); setAssignee(""); }}>Biriktirish</button>
                  </>}
                  <button className="link danger" onClick={() => window.confirm("Vazifa (va ochiq kichik vazifalari) bekor qilinsinmi?") && act("cancel", { reason: text }, "Bekor qilindi.")}>Bekor qilish</button>
                </div>
              )}

              <label className="field">Izoh / natija / sabab
                <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Izoh yozing — rad etish, bloklash, natija va ko'rib chiqish uchun ham ishlatiladi" />
              </label>
              <div className="row-end">
                <Attach id={id} onDone={() => { setMsg({ ok: true, text: "Fayl qo'shildi." }); reload(); }} onError={(e) => setMsg({ ok: false, text: e })} />
                <button className="link" disabled={!text.trim()} onClick={() => void run(() => api.post(`/api/work/${id}/comments`, { body: text }), setMsg, "Izoh qo'shildi.").then((ok) => ok && (setText(""), reload()))}>Izoh qo'shish</button>
              </div>

              <section>
                <div className="sec-head">
                  <h3>Kichik vazifalar {t.subtasks.total ? `(${t.subtasks.done}/${t.subtasks.total})` : ""}</h3>
                  {data.can.split && <button className="link" onClick={() => setSplit(true)}>+ Kichik vazifa</button>}
                </div>
                {data.subtasks.length ? <WorkList items={data.subtasks} onOpen={onOpen} empty="" detailed /> : <p className="muted">Yo'q. Katta vazifani bo'lib, jamoaga taqsimlash mumkin.</p>}
              </section>

              {data.attachments.length > 0 && (
                <section>
                  <h3>Fayllar</h3>
                  <ul className="mem-list">
                    {data.attachments.map((a) => (
                      <li key={a.id}><a className="mem-text" href={`/api/work/${id}/attachments/${a.id}`}>{a.filename}</a><span className="muted">{Math.ceil(a.sizeBytes / 1024)} KB · {a.userName ?? "—"} · {fmtDate(a.createdAt, true)}</span></li>
                    ))}
                  </ul>
                </section>
              )}

              {(data.comments.length > 0 || data.reviews.length > 0) && (
                <section>
                  <h3>Muhokama</h3>
                  <ul className="timeline">
                    {data.comments.map((c) => (
                      <li key={c.id} className={`c-${c.kind}`}><span className="muted">{fmtDate(c.createdAt, true)} · {c.userName ?? "—"} · {KIND_LABEL[c.kind] ?? c.kind}</span><div>{c.body}</div></li>
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h3>Holat tarixi</h3>
                <ul className="timeline">
                  {data.history.map((h) => (
                    <li key={h.id}>
                      <span className="muted">{fmtDate(h.at, true)} · {h.data.auto ? "avtomatik" : h.actorName ?? "tizim"}</span>{" "}
                      {h.type === "task.created" ? "yaratildi" : <>{TASK_STATUS_META[h.data.from as TaskStatus]?.label ?? h.data.from} → <b>{TASK_STATUS_META[h.data.to as TaskStatus]?.label ?? h.data.to}</b></>}
                      {h.data.reason ? <span className="muted"> — {h.data.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
              {split && <NewWork parent={{ id, title: t.title }} onClose={() => setSplit(false)} onCreated={() => { setSplit(false); reload(); }} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Attach({ id, onDone, onError }: { id: string; onDone: () => void; onError: (e: string) => void }) {
  return (
    <label className="link file-link">
      Fayl biriktirish…
      <input type="file" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        if (f.size > 10 * 1024 * 1024) return onError("Fayl 10 MB dan katta");
        const fd = new FormData();
        fd.append("file", f);
        const r = await fetch(`/api/work/${id}/attachments`, { method: "POST", body: fd, credentials: "same-origin" });
        if (r.ok) onDone();
        else onError((await r.json().catch(() => ({})))?.error?.message ?? `Xato ${r.status}`);
      }} />
    </label>
  );
}
