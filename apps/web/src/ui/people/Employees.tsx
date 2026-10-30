// Employee directory, profile and add/edit form.
import { useMemo, useState, type FormEvent } from "react";
import type { EmployeeCardDto, EmployeeDto, EmployeeStatus, WorkloadDto } from "@sag/shared";
import { api } from "../../api/client";
import { useOffice } from "../../api/office";
import { DeptChip } from "../shared";
import { Avatar, Empty, Loading, Msg, PERMISSION_LABEL, ROLE_LABEL, WorkloadBadge, errorText, fmtDate, run, useLoad, type Note } from "./common";
import { WorkList, type WorkItem } from "./Work";

type DirItem = EmployeeCardDto & { workload?: WorkloadDto; canView: boolean };

export function Directory({ onOpen, onCreate }: { onOpen: (id: string) => void; onCreate?: () => void }) {
  const { office } = useOffice();
  const [q, setQ] = useState("");
  const [dep, setDep] = useState("");
  const [status, setStatus] = useState<EmployeeStatus | "all">("active");
  const [sort, setSort] = useState<"name" | "department" | "workload" | "recent">("name");
  const url = `/api/employees?${new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(dep ? { departmentId: dep } : {}), status, sort })}`;
  const { data, error, loading } = useLoad<{ employees: DirItem[] }>(url);
  const deps = Object.values(office?.departments ?? {});
  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Ism, lavozim yoki login…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Qidirish" />
        <select value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Bo'lim">
          <option value="">Barcha bo'limlar</option>
          {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as EmployeeStatus | "all")} aria-label="Holat">
          <option value="active">Faol</option>
          <option value="inactive">Faolsiz</option>
          <option value="archived">Arxiv</option>
          <option value="all">Hammasi</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Saralash">
          <option value="name">Ism bo'yicha</option>
          <option value="department">Bo'lim bo'yicha</option>
          <option value="workload">Yuklama bo'yicha</option>
          <option value="recent">Oxirgi faollik</option>
        </select>
        {onCreate && <button className="primary small" onClick={onCreate}>+ Xodim qo'shish</button>}
      </div>
      {error && <div className="notice warn">{error}</div>}
      {loading && !data ? <Loading /> : !data?.employees.length ? (
        <Empty>Hech kim topilmadi{q ? ` — “${q}”` : ""}.</Empty>
      ) : (
        <div className="people-grid">
          {data.employees.map((e) => (
            <button key={e.id} className={`person-card${e.status !== "active" ? " off" : ""}`} onClick={() => onOpen(e.id)}>
              <Avatar p={e} size={40} />
              <span className="pc-main">
                <b>{e.displayName}</b>
                <span className="muted">{e.jobTitle || ROLE_LABEL[e.roles[0] ?? ""] || "—"}</span>
                <span className="pc-meta">
                  {e.departmentId && office?.departments[e.departmentId] && <DeptChip dep={office.departments[e.departmentId]} />}
                  {e.roles.includes("department_head") && <span className="tag">rahbar</span>}
                  {e.pendingActivation ? <span className="tag">taklif kutilmoqda</span> : e.status !== "active" && <span className="tag">{e.status === "archived" ? "arxiv" : "faolsiz"}</span>}
                </span>
              </span>
              {e.workload && <WorkloadBadge w={e.workload} compact />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- profile

interface ProfileResp {
  employee: EmployeeDto | EmployeeCardDto;
  full: boolean;
  activity?: { id: number; action: string; targetType: string | null; targetId: string | null; actorId: string | null; createdAt: string }[];
}

const ACTION_LABEL: Record<string, string> = {
  "employee.create": "Xodim qo'shildi", "employee.update": "Profil yangilandi", "employee.update_org": "Lavozim/bo'lim o'zgardi",
  "employee.status": "Holat o'zgardi", "employee.roles": "Rollar o'zgardi", "employee.avatar": "Rasm yangilandi",
  "permission.grant": "Ruxsat berildi", "permission.revoke": "Ruxsat olindi", "auth.login": "Tizimga kirdi", "auth.logout": "Tizimdan chiqdi",
  "task.create": "Vazifa yaratdi", "task.transition": "Vazifa holatini o'zgartirdi", "task.assign": "Vazifa biriktirdi", "task.update": "Vazifani tahrirladi",
  "user.password_change": "Parolini o'zgartirdi", "user.password_reset": "Paroli tiklandi",
};

export function EmployeeProfile({ id, onClose, onOpenTask, onAssign }: {
  id: string; onClose: () => void; onOpenTask: (id: string) => void; onAssign: (assigneeId: string) => void;
}) {
  const { office } = useOffice();
  const { data, error, reload } = useLoad<ProfileResp>(`/api/employees/${id}`);
  const tasks = useLoad<{ tasks: WorkItem[] }>(data?.full ? `/api/work?view=person&assigneeId=${id}` : null);
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState<Note>(null);
  const e = data?.employee;
  const full = data?.full ? (e as EmployeeDto) : null;
  const dep = e?.departmentId ? office?.departments[e.departmentId] : undefined;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal person" role="dialog" aria-label="Xodim profili" onClick={(x) => x.stopPropagation()}>
        <div className="modal-head">
          {e ? (
            <div className="ph">
              <Avatar p={e} size={52} />
              <div>
                <h2>{e.displayName} <span className="person-kind" title="Inson xodim (AI agent emas)">xodim</span></h2>
                <div className="muted">{e.jobTitle || "—"}{e.roles.length ? ` · ${e.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")}` : ""}</div>
                <div className="pc-meta">{dep && <DeptChip dep={dep} />}{e.status !== "active" && <span className="tag">{e.status === "archived" ? "arxiv" : "faolsiz"}</span>}</div>
              </div>
            </div>
          ) : <h2>Xodim</h2>}
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="notice warn">{error}</div>}
          {!data && !error && <Loading />}
          <Msg m={msg} />
          {data && !full && <p className="hint">Bu xodimning batafsil profili va vazifalari sizga ochiq emas.</p>}
          {full && !edit && (
            <>
              <section className="kv-grid">
                <div><span>Login</span><b className="mono">{full.username}</b></div>
                <div><span>Email</span><b>{full.email ?? "—"}</b></div>
                <div><span>Rahbar</span><b><PersonName id={full.managerId} /></b></div>
                <div><span>Ish boshlagan</span><b>{fmtDate(full.startDate)}</b></div>
                <div><span>Ish vaqti</span><b>{full.workStart}–{full.workEnd} · {full.timezone}</b></div>
                <div><span>Sig'im</span><b>{full.capacityHoursWeek} soat / hafta</b></div>
                <div><span>Oxirgi faollik</span><b>{fmtDate(full.lastActivityAt, true)}</b></div>
                <div><span>Oxirgi kirish</span><b>{fmtDate(full.lastLoginAt, true)}</b></div>
              </section>
              <section>
                <h3>Yuklama</h3>
                <WorkloadPanel w={full.workload} />
              </section>
              <div className="row-end">
                {full.can.assignTasks && full.status === "active" && <button className="link" onClick={() => onAssign(full.id)}>+ Vazifa berish</button>}
                {full.can.edit && <button className="link" onClick={() => setEdit(true)}>Tahrirlash</button>}
                {full.can.changeStatus && !full.pendingActivation && <StatusMenu e={full} onDone={(t) => { setMsg({ ok: true, text: t }); reload(); }} onError={(t) => setMsg({ ok: false, text: t })} />}
                {full.pendingActivation && full.can.changeStatus && (
                  <button className="link" onClick={() => void api.post<{ activationToken: string; expiresAt: string }>(`/api/employees/${full.id}/invitation`)
                    .then((r) => setMsg({ ok: true, text: `Yangi bir martalik kod (${r.expiresAt.slice(0, 10)} gacha, eskisi bekor): ${r.activationToken}` }))
                    .catch((x) => setMsg({ ok: false, text: errorText(x) }))}>Yangi taklif kodi</button>
                )}
                {full.can.edit && <AvatarUpload id={full.id} onDone={() => { setMsg({ ok: true, text: "Rasm yangilandi." }); reload(); }} onError={(t) => setMsg({ ok: false, text: t })} />}
              </div>
              <section>
                <h3>Vazifalar</h3>
                {tasks.error ? <div className="notice warn">{tasks.error}</div> : tasks.data ? <WorkList items={tasks.data.tasks} onOpen={onOpenTask} empty="Ochiq vazifa yo'q." /> : <Loading />}
              </section>
              {(full.can.changeRoles || full.can.grant || full.grants.length > 0) && (
                <section>
                  <h3>Rollar va ruxsatlar</h3>
                  <Access e={full} onChange={(t) => { setMsg(t); reload(); }} />
                </section>
              )}
              {data?.activity && data.activity.length > 0 && (
                <section>
                  <h3>Faollik tarixi</h3>
                  <ul className="timeline">
                    {data.activity.map((a) => (
                      <li key={a.id}><span className="muted">{fmtDate(a.createdAt, true)}</span> {ACTION_LABEL[a.action] ?? a.action}{a.actorId && a.actorId !== id ? <> — <PersonName id={a.actorId} /></> : null}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
          {full && edit && <EmployeeForm existing={full} onCancel={() => setEdit(false)} onSaved={() => { setEdit(false); setMsg({ ok: true, text: "Saqlandi." }); reload(); }} />}
        </div>
      </div>
    </div>
  );
}

export function WorkloadPanel({ w }: { w: WorkloadDto }) {
  return (
    <div className={`wl-panel wl-${w.level}`}>
      <WorkloadBadge w={w} />
      <b>{w.summary}</b>
      <div className="wl-bar" aria-label={`${w.percent}%`}><i style={{ width: `${Math.min(100, w.percent)}%` }} /></div>
      <ul>{w.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <span className="muted">Bu ish yuklamasi bo'yicha operatsion ko'rsatkich — tibbiy baho emas va hech qanday cheklov qo'ymaydi.</span>
    </div>
  );
}

/** Resolves a person id to a name using the (always visible) directory card. */
export function PersonName({ id }: { id: string | null | undefined }) {
  const { data } = useLoad<{ employees: EmployeeCardDto[] }>(id ? "/api/employees?status=all" : null);
  if (!id) return <>—</>;
  return <>{data?.employees.find((e) => e.id === id)?.displayName ?? "…"}</>;
}

function StatusMenu({ e, onDone, onError }: { e: EmployeeDto; onDone: (t: string) => void; onError: (t: string) => void }) {
  const set = async (status: EmployeeStatus) => {
    if (status !== "active" && !window.confirm(`${e.displayName}: ${status === "archived" ? "arxivlansinmi" : "faolsizlantirilsinmi"}? Tizimga kira olmaydi, vazifalar tarixi saqlanadi.`)) return;
    try {
      await api.post(`/api/employees/${e.id}/status`, { status });
      onDone(status === "active" ? "Faollashtirildi." : "Holat o'zgardi, sessiyalari tugatildi.");
    } catch (x) {
      onError(errorText(x));
    }
  };
  return e.status === "active" ? (
    <>
      <button className="link danger" onClick={() => void set("inactive")}>Faolsizlantirish</button>
      <button className="link danger" onClick={() => void set("archived")}>Arxivlash</button>
    </>
  ) : <button className="link" onClick={() => void set("active")}>Faollashtirish</button>;
}

function AvatarUpload({ id, onDone, onError }: { id: string; onDone: () => void; onError: (t: string) => void }) {
  return (
    <label className="link file-link">
      Rasm…
      <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (ev) => {
        const f = ev.target.files?.[0];
        if (!f) return;
        if (f.size > 1024 * 1024) return onError("Rasm 1 MB dan katta");
        const fd = new FormData();
        fd.append("file", f);
        const r = await fetch(`/api/employees/${id}/avatar`, { method: "PUT", body: fd, credentials: "same-origin" });
        if (r.ok) onDone();
        else onError((await r.json().catch(() => ({})))?.error?.message ?? `Xato ${r.status}`);
      }} />
    </label>
  );
}

function Access({ e, onChange }: { e: EmployeeDto; onChange: (m: Note) => void }) {
  const { office, user } = useOffice();
  const [roles, setRoles] = useState<string[]>(e.roles);
  const [g, setG] = useState({ permission: "tasks:read_team", departmentId: "", canDelegate: false });
  const deps = Object.values(office?.departments ?? {});
  const scopable = ["employees:manage_dept", "tasks:assign_dept", "tasks:read_team"];
  return (
    <div className="access">
      {e.can.changeRoles ? (
        <div className="role-row">
          {Object.keys(ROLE_LABEL).filter((r) => !["member", "hr", "viewer"].includes(r) || roles.includes(r)).map((r) => (
            <label key={r} className="check">
              <input type="checkbox" checked={roles.includes(r)} onChange={(x) => setRoles(x.target.checked ? [...roles, r] : roles.filter((y) => y !== r))} />
              {ROLE_LABEL[r]}
            </label>
          ))}
          <button className="link" disabled={!roles.length || roles.join() === e.roles.join()}
            onClick={() => void run(() => api.put(`/api/employees/${e.id}/roles`, { roles }), onChange, "Rollar saqlandi.")}>Rollarni saqlash</button>
        </div>
      ) : <p className="muted">Rollar: {e.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")} {user?.id === e.id ? "(o'z rolingizni o'zgartira olmaysiz)" : ""}</p>}
      {e.grants.length > 0 && (
        <ul className="mem-list">
          {e.grants.map((x) => (
            <li key={x.id}>
              <span className="mem-text">{PERMISSION_LABEL[x.permission] ?? x.permission}{x.departmentId ? ` — ${office?.departments[x.departmentId]?.name ?? x.departmentId}` : ""}{x.canDelegate ? " · boshqalarga bera oladi" : ""}</span>
              {e.can.grant && <span className="mem-actions"><button onClick={() => void run(() => api.del(`/api/employees/${e.id}/grants/${x.id}`), onChange, "Ruxsat olindi.")}>Olib tashlash</button></span>}
            </li>
          ))}
        </ul>
      )}
      {e.can.grant && (
        <form className="nt-row" onSubmit={(x) => {
          x.preventDefault();
          void run(() => api.post(`/api/employees/${e.id}/grants`, { permission: g.permission, departmentId: scopable.includes(g.permission) && g.departmentId ? g.departmentId : null, canDelegate: g.canDelegate }), onChange, "Ruxsat berildi.");
        }}>
          <select value={g.permission} onChange={(x) => setG({ ...g, permission: x.target.value })} aria-label="Ruxsat">
            {Object.entries(PERMISSION_LABEL).filter(([k]) => k !== "users:manage").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {scopable.includes(g.permission) && (
            <select value={g.departmentId} onChange={(x) => setG({ ...g, departmentId: x.target.value })} aria-label="Bo'lim">
              <option value="">Faqat o'zi rahbar bo'lgan bo'limlar</option>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          <label className="check"><input type="checkbox" checked={g.canDelegate} onChange={(x) => setG({ ...g, canDelegate: x.target.checked })} />Boshqalarga bera oladi</label>
          <button className="primary small">Ruxsat berish</button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- add / edit form

interface FormState {
  username: string; displayName: string; password: string; email: string; jobTitle: string; departmentId: string; managerId: string;
  role: string; startDate: string; capacityHoursWeek: string; workStart: string; workEnd: string; timezone: string;
}

export function EmployeeForm({ existing, onSaved, onCancel }: { existing?: EmployeeDto; onSaved: (id: string) => void; onCancel: () => void }) {
  const { office, user, can } = useOffice();
  const { data: dir } = useLoad<{ employees: EmployeeCardDto[] }>("/api/employees");
  const self = existing?.id === user?.id;
  const orgLocked = !!existing && !existing.can.editOrg;
  const admin = can("users:manage") || can("employees:manage_all");
  const managed = user?.managedDepartments ?? [];
  const deps = Object.values(office?.departments ?? {}).filter((d) => admin || managed.includes(d.id) || d.id === existing?.departmentId);
  const [f, setF] = useState<FormState>({
    username: existing?.username ?? "", displayName: existing?.displayName ?? "", password: "", email: existing?.email ?? "",
    jobTitle: existing?.jobTitle ?? "", departmentId: existing?.departmentId ?? (deps.length === 1 ? deps[0].id : ""),
    managerId: existing?.managerId ?? "", role: "employee", startDate: existing?.startDate?.slice(0, 10) ?? "",
    capacityHoursWeek: String(existing?.capacityHoursWeek ?? 40), workStart: existing?.workStart ?? "09:00", workEnd: existing?.workEnd ?? "18:00",
    timezone: existing?.timezone ?? "Asia/Tashkent",
  });
  const [errs, setErrs] = useState<Partial<Record<keyof FormState, string>>>({});
  const [msg, setMsg] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const validate = () => {
    const e: typeof errs = {};
    if (!existing) {
      if (!/^[a-z0-9._-]{3,32}$/.test(f.username.trim().toLowerCase())) e.username = "3–32 belgi: lotin harflari, raqam, . _ -";
      if (f.password.length < 10) e.password = "Kamida 10 belgi";
      if (!f.departmentId && !admin) e.departmentId = "Bo'limni tanlang";
    }
    if (!f.displayName.trim()) e.displayName = "Ism-familiya kerak";
    if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) e.email = "Email noto'g'ri";
    const cap = Number(f.capacityHoursWeek);
    if (!(cap >= 0 && cap <= 80)) e.capacityHoursWeek = "0–80 soat";
    if (!/^\d\d:\d\d$/.test(f.workStart) || !/^\d\d:\d\d$/.test(f.workEnd)) e.workStart = "HH:MM";
    setErrs(e);
    return !Object.keys(e).length;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      if (existing) {
        const body: Record<string, unknown> = { displayName: f.displayName.trim(), workStart: f.workStart, workEnd: f.workEnd, timezone: f.timezone };
        if (!self && !orgLocked)
          Object.assign(body, {
            email: f.email.trim() || null, jobTitle: f.jobTitle.trim(), departmentId: f.departmentId || null, managerId: f.managerId || null,
            startDate: f.startDate ? new Date(f.startDate).toISOString() : null, capacityHoursWeek: Number(f.capacityHoursWeek),
          });
        await api.patch(`/api/employees/${existing.id}`, body);
        onSaved(existing.id);
      } else {
        const r = await api.post<{ employee: EmployeeDto }>("/api/employees", {
          username: f.username.trim().toLowerCase(), displayName: f.displayName.trim(), password: f.password, email: f.email.trim() || null,
          jobTitle: f.jobTitle.trim(), departmentId: f.departmentId || null, managerId: f.managerId || null, roles: [f.role],
          startDate: f.startDate ? new Date(f.startDate).toISOString() : null, capacityHoursWeek: Number(f.capacityHoursWeek),
          workStart: f.workStart, workEnd: f.workEnd, timezone: f.timezone,
        });
        onSaved(r.employee.id);
      }
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const managers = useMemo(() => (dir?.employees ?? []).filter((p) => p.id !== existing?.id), [dir, existing]);
  const lock = self || orgLocked;
  const field = (k: keyof FormState, label: string, input: React.ReactNode) => (
    <label className={`field${errs[k] ? " invalid" : ""}`}>{label}{input}{errs[k] && <span className="err">{errs[k]}</span>}</label>
  );
  return (
    <form className="emp-form" onSubmit={submit} noValidate>
      <Msg m={msg} />
      <div className="form-grid">
        {!existing && field("username", "Login *", <input value={f.username} onChange={set("username")} autoComplete="off" />)}
        {field("displayName", "Ism-familiya *", <input value={f.displayName} onChange={set("displayName")} />)}
        {!existing && field("password", "Boshlang'ich parol *", <input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" />)}
        {field("email", "Email", <input type="email" value={f.email} onChange={set("email")} disabled={lock} />)}
        {field("jobTitle", "Lavozim", <input value={f.jobTitle} onChange={set("jobTitle")} disabled={lock} />)}
        {field("departmentId", "Bo'lim", (
          <select value={f.departmentId} onChange={set("departmentId")} disabled={lock}>
            <option value="">—</option>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ))}
        {field("managerId", "Rahbar", (
          <select value={f.managerId} onChange={set("managerId")} disabled={lock}>
            <option value="">{existing ? "—" : "Bo'lim rahbari (avtomatik)"}</option>
            {managers.map((m) => <option key={m.id} value={m.id}>{m.displayName}{m.jobTitle ? ` — ${m.jobTitle}` : ""}</option>)}
          </select>
        ))}
        {!existing && field("role", "Rol", (
          <select value={f.role} onChange={set("role")}>
            <option value="employee">Xodim</option>
            {can("users:manage") && <><option value="department_head">Bo'lim rahbari</option><option value="director">Direktor</option><option value="admin">Administrator</option></>}
          </select>
        ))}
        {field("startDate", "Ish boshlagan sana", <input type="date" value={f.startDate} onChange={set("startDate")} disabled={lock} />)}
        {field("capacityHoursWeek", "Sig'im (soat/hafta)", <input type="number" min={0} max={80} value={f.capacityHoursWeek} onChange={set("capacityHoursWeek")} disabled={lock} />)}
        {field("workStart", "Ish vaqti", (
          <span className="pair"><input type="time" value={f.workStart} onChange={set("workStart")} /><input type="time" value={f.workEnd} onChange={set("workEnd")} /></span>
        ))}
        {field("timezone", "Vaqt mintaqasi", <input value={f.timezone} onChange={set("timezone")} />)}
      </div>
      {lock && existing && <p className="hint">{self ? "O'z lavozimingiz, bo'limingiz va rahbaringizni rahbaringiz o'zgartiradi." : "Tashkiliy maydonlarni o'zgartirish huquqingiz yo'q."}</p>}
      <div className="row-end">
        <button type="button" className="link" onClick={onCancel}>Bekor qilish</button>
        <button className="primary small" disabled={busy}>{busy ? "Saqlanmoqda…" : existing ? "Saqlash" : "Qo'shish"}</button>
      </div>
    </form>
  );
}
