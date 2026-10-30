import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { NetworkDto, UnitCardDto, UnitOverviewDto, UnitPersonDto, UnitTaskDto } from "@sag/shared";
import { api } from "../api/client";
import { useOffice } from "../api/office";
import { NetworkScene, type StoreOccupant } from "../scene/network/NetworkScene";
import { webglAvailable } from "../scene/SceneController";

const OWNERSHIP: Record<string, string> = { SAG_OWNED: "SAG do'koni (HD)", FRANCHISE: "Franshiza (F)", INDEPENDENT: "Mustaqil diler", GROUP_OWNED: "Guruh korxonasi" };
const ROLE: Record<string, string> = { unit_director: "Direktor", unit_manager: "Menejer", unit_staff: "Xodim" };
const STATUS: Record<string, string> = {
  ASSIGNED: "Berilgan", ACCEPTED: "Qabul qilingan", IN_PROGRESS: "Jarayonda", IN_REVIEW: "Tekshiruvda", DONE: "Bajarildi",
  CHANGES_REQUESTED: "Qayta ishlash", CANCELLED: "Bekor", QUEUED: "Navbatda", BACKLOG: "Kutmoqda", FAILED: "Xato", WAITING_APPROVAL: "Tasdiq kutmoqda",
};
/** Human task steps in a store, as the server allows them (domain/units.ts HUMAN_FLOW): label, and lead-only or not. */
const FLOW: Record<string, { to: string; label: string; lead?: boolean }[]> = {
  ASSIGNED: [{ to: "ACCEPTED", label: "Qabul qilish" }, { to: "CANCELLED", label: "Bekor qilish", lead: true }],
  ACCEPTED: [{ to: "IN_PROGRESS", label: "Boshlash" }, { to: "CANCELLED", label: "Bekor qilish", lead: true }],
  IN_PROGRESS: [{ to: "IN_REVIEW", label: "Tekshiruvga topshirish" }, { to: "CANCELLED", label: "Bekor qilish", lead: true }],
  IN_REVIEW: [{ to: "DONE", label: "Tasdiqlash", lead: true }, { to: "CHANGES_REQUESTED", label: "Qayta ishlashga", lead: true }],
  CHANGES_REQUESTED: [{ to: "IN_PROGRESS", label: "Qayta boshlash" }],
};

/**
 * Who stands in the opened store: people this viewer may see (active ones solid, positions waiting for a real person or
 * for activation translucent) and the store's AI Director. Nobody is invented: a vacant position has no name.
 */
export function occupantsOf(o: UnitOverviewDto): StoreOccupant[] {
  const people: StoreOccupant[] = [];
  if (o.employees) {
    for (const p of o.employees) {
      const role = p.role ? ROLE[p.role] : "Xodim";
      if (p.activation === "ACTIVE" && p.status === "active") people.push({ id: p.id, name: p.displayName, role, kind: "human" });
      else if (p.activation === "PENDING_ACTIVATION")
        people.push({
          id: p.id, role, kind: "vacant",
          name: p.displayName.includes("(tayinlanmagan)") ? `${role} — tayinlanmagan` : `${p.displayName} — faollashtirilmagan`,
        });
    }
  } else if (o.director.assigned) {
    // people are not visible to this viewer: only the director position, as on the store card
    people.push(o.director.activation === "ACTIVE"
      ? { id: `${o.unit.id}:director`, name: "Direktor", role: "Direktor", kind: "human" }
      : { id: `${o.unit.id}:director`, name: "Direktor — tayinlanmagan", role: "Direktor", kind: "vacant" });
  }
  if (o.aiDirector && o.aiDirector.lifecycle !== "ARCHIVED") people.push({ id: o.aiDirector.id, name: o.aiDirector.name.replace(/ — .*/, ""), role: "AI", kind: "ai" });
  return people;
}

const RESTRICTED: Record<string, string> = {
  employees: "xodimlar", tasks: "vazifalar", kpi: "ko'rsatkichlar", director_identity: "direktor shaxsi",
};

/** Store network: 3D buildings by region + the selected unit's panel. Store accounts see only their own unit. */
export function NetworkView({ onClose, unitAccount }: { onClose?: () => void; unitAccount: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<NetworkScene | null>(null);
  const [net, setNet] = useState<NetworkDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tip, setTip] = useState<{ u: UnitCardDto; x: number; y: number } | null>(null);
  const [has3d] = useState(webglAvailable);

  useEffect(() => {
    api.get<{ network: NetworkDto }>("/api/units").then((r) => {
      setNet(r.network);
      const units = r.network.regions.flatMap((g) => g.units);
      if (unitAccount && units[0]) setSelected(units[0].id);
    }).catch((e) => setError(e.message));
  }, [unitAccount]);

  useEffect(() => {
    if (!has3d || !host.current) return;
    const s = new NetworkScene(host.current, {
      onSelect: setSelected,
      onHover: (u, x, y) => setTip(u ? { u, x, y } : null),
    });
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, [has3d]);

  useEffect(() => {
    if (net) scene.current?.setNetwork(net);
  }, [net]);
  useEffect(() => scene.current?.select(selected), [selected, net]);

  const units = net?.regions.flatMap((r) => r.units) ?? [];
  const counts = { hd: units.filter((u) => u.ownershipModel === "SAG_OWNED" && !u.isHeadOffice).length, f: units.filter((u) => u.ownershipModel === "FRANCHISE").length };

  return (
    <div className="network-view">
      {has3d ? <div ref={host} className="network-stage" /> : null}
      <div className="network-legend">
        <b>{unitAccount ? "Mening do'konim" : "Home Design do'konlar tarmog'i"}</b>
        {!unitAccount && (
          <span>
            <i className="net-dot hd" /> SAG do'konlari (HD): {counts.hd} · <i className="net-dot f" /> Franshiza (F): {counts.f} · Regionlar: {net?.regions.filter((r) => r.units.length).length ?? 0}
          </span>
        )}
        <small>Joylashuv sxematik: regionlar bo'yicha guruhlangan. Haqiqiy manzil va koordinatalar hali kiritilmagan.</small>
        {onClose && <button className="crumb" onClick={onClose}>← Kampusga qaytish</button>}
      </div>
      {error && <div className="center-note">Ma'lumot yuklanmadi: {error}</div>}
      {!has3d && net && (
        <ul className="network-fallback">
          {net.regions.map((r) => (
            <li key={r.id}>
              <b>{r.name}</b>
              {r.units.map((u) => <button key={u.id} onClick={() => setSelected(u.id)}>{u.name} · {u.sourceMarker ?? "HQ"}</button>)}
            </li>
          ))}
        </ul>
      )}
      {tip && !selected && (
        <div className="hover-card" style={{ left: Math.min(tip.x + 16, window.innerWidth - 260), top: Math.max(70, tip.y - 10), width: 240 }} role="tooltip">
          <div className="hc-title">{tip.u.name}</div>
          <div className="muted">{tip.u.regionName} · {tip.u.isHeadOffice ? "Bosh ofis" : OWNERSHIP[tip.u.ownershipModel ?? ""]}</div>
        </div>
      )}
      {selected && (
        <UnitPanel
          unitId={selected}
          onClose={unitAccount ? undefined : () => setSelected(null)}
          onLoaded={(o) => scene.current?.setOccupants(o.unit.id, occupantsOf(o))}
        />
      )}
    </div>
  );
}

export function UnitPanel({ unitId, onClose, onLoaded }: { unitId: string; onClose?: () => void; onLoaded: (o: UnitOverviewDto) => void }) {
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const [o, setO] = useState<UnitOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ who: string; username: string; token: string; expiresAt: string } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const { user } = useOffice();
  const act = (fn: () => Promise<unknown>, ok?: string) => {
    setNote(null);
    fn().then(() => { if (ok) setNote({ ok: true, text: ok }); load(); }).catch((e) => setNote({ ok: false, text: e.message }));
  };
  const load = useCallback(() => {
    setError(null);
    api.get<{ overview: UnitOverviewDto }>(`/api/units/${unitId}`).then((r) => {
      setO(r.overview);
      loaded.current(r.overview);
    }).catch((e) => setError(e.message));
  }, [unitId]);
  useEffect(() => {
    setO(null);
    setSecret(null);
    load();
  }, [load]);

  if (error) return <aside className="panel unit-panel"><div className="login-error">{error}</div></aside>;
  if (!o) return <aside className="panel unit-panel"><p className="muted">Yuklanmoqda…</p></aside>;
  const u = o.unit;
  const peopleById = new Map((o.employees ?? []).map((p) => [p.id, p]));

  return (
    <aside className="panel unit-panel" aria-label={u.name}>
      <div className="panel-head">
        <span className={`net-badge ${u.isHeadOffice ? "hq" : u.ownershipModel === "SAG_OWNED" ? "hd" : "f"}`}>
          {u.isHeadOffice ? "BOSH OFIS" : u.ownershipModel === "SAG_OWNED" ? "HD · SAG" : "F · Franshiza"}
        </span>
        {onClose && <button className="back" onClick={onClose}>Yopish ✕</button>}
      </div>
      <h2 className="panel-title">{u.name}</h2>
      <dl className="kv">
        <dt>Region</dt><dd>{u.regionName}</dd>
        <dt>Egalik</dt><dd>{u.isHeadOffice ? "SAG Holding" : OWNERSHIP[u.ownershipModel ?? ""] ?? u.businessType}</dd>
        <dt>Biznes turi</dt><dd>{u.businessType}{u.sourceBrand ? ` · ${u.sourceBrand}` : ""}</dd>
        <dt>Manzil</dt><dd>{u.address ?? "Kiritilmagan"}{u.geo ? ` (${u.geo.lat}, ${u.geo.lng})` : ""}</dd>
        <dt>Direktor</dt>
        <dd>
          {!o.director.assigned ? "Yo'q" : o.director.displayName ?? "Tayinlangan"}
          {o.director.activation === "PENDING_ACTIVATION" && <span className="badge warn">faollashtirilmagan</span>}
        </dd>
        <dt>AI Direktor</dt><dd>{o.aiDirector ? `${o.aiDirector.name} · ${o.aiDirector.status}` : "Yo'q"}</dd>
      </dl>

      {u.isHeadOffice && <p className="hint">Bosh ofis ma'lumotlari kampusdagi SAG Headquarters binosida.</p>}
      {!u.isHeadOffice && (
        <p className="hint">
          Binoda: {occupantsOf(o).filter((p) => p.kind === "human").length} xodim{o.aiDirector ? " va AI Direktor" : ""}
          {occupantsOf(o).some((p) => p.kind === "vacant") ? "; shaffof figuralar — hali egallanmagan yoki faollashtirilmagan lavozimlar" : ""}.
          {o.employees ? "" : " Xodimlar sizga ko'rinmaydi."}
        </p>
      )}

      {o.kpis && (
        <section>
          <h3>Ko'rsatkichlar (30 kun)</h3>
          <div className="unit-kpis">
            <div><b>{o.kpis.employees}</b><small>xodim</small></div>
            <div><b>{o.kpis.openTasks}</b><small>ochiq vazifa</small></div>
            <div><b>{o.kpis.doneTasks30d}</b><small>bajarildi</small></div>
            {o.kpis.aiCostUsd30d !== undefined && <div><b>${o.kpis.aiCostUsd30d.toFixed(2)}</b><small>AI xarajati</small></div>}
          </div>
        </section>
      )}

      {o.restricted.length > 0 && !u.isHeadOffice && (
        <p className="hint unit-restricted">
          {o.access.memberRole
            ? `Rolingiz uchun yopiq: ${o.restricted.map((r) => RESTRICTED[r] ?? r).join(", ")}.`
            : `${u.ownershipModel === "FRANCHISE" ? "Franshiza mustaqil biznes: " : ""}${o.restricted.map((r) => RESTRICTED[r] ?? r).join(", ")} ma'lumot ulashish kelishuvisiz ko'rinmaydi.`}
        </p>
      )}

      {secret && (
        <section className="unit-secret" role="status">
          <h3>Bir martalik faollashtirish kodi — {secret.who}</h3>
          <p>Login: <code>{secret.username}</code></p>
          <p className="token"><code>{secret.token}</code></p>
          <button className="primary small" onClick={() => void navigator.clipboard?.writeText(secret.token).catch(() => {})}>Nusxa olish</button>
          <p className="hint">Kod faqat hozir ko'rsatiladi va {new Date(secret.expiresAt).toLocaleDateString()} gacha amal qiladi. Uni egasiga shaxsan bering; u kirish oynasidagi "Taklif kodi bilan faollashtirish" orqali parol o'rnatadi.</p>
        </section>
      )}

      {o.access.manageStructure && o.director.activation === "PENDING_ACTIVATION" && (
        <AssignDirector unitId={u.id} onDone={(r) => { setSecret({ who: "direktor", ...r }); load(); }} />
      )}

      {o.employees && (
        <section>
          <h3>Xodimlar ({o.employees.length})</h3>
          <ul className="unit-people">
            {o.employees.map((p) => {
              // the director manages staff and managers, never themself or another director
              const manage = o.access.canManageEmployees && p.role !== "unit_director" && p.id !== user?.id;
              return (
                <li key={p.id}>
                  <span>{p.displayName}{p.jobTitle ? <small> · {p.jobTitle}</small> : null}</span>
                  <small>{p.role ? ROLE[p.role] : ""}{p.activation === "PENDING_ACTIVATION" ? " · faollashtirilmagan" : p.status !== "active" ? " · nofaol" : ""}</small>
                  {manage && (
                    <span className="unit-actions">
                      <select aria-label={`${p.displayName} roli`} value={p.role ?? "unit_staff"}
                        onChange={(e) => act(() => api.patch(`/api/units/${u.id}/employees/${p.id}`, { role: e.target.value }), "Rol o'zgardi.")}>
                        <option value="unit_staff">Xodim</option>
                        <option value="unit_manager">Menejer</option>
                      </select>
                      {p.activation === "PENDING_ACTIVATION" ? (
                        <button className="link" onClick={() => api.post<Invite>(`/api/units/${u.id}/employees/${p.id}/invitation`)
                          .then((r) => setSecret({ who: p.displayName, username: r.username ?? p.username, token: r.activationToken, expiresAt: r.expiresAt }))
                          .catch((e) => setNote({ ok: false, text: e.message }))}>Yangi kod</button>
                      ) : p.status === "active" ? (
                        <button className="link danger" onClick={() => window.confirm(`${p.displayName} faolsizlantirilsinmi? Tizimga kira olmaydi.`)
                          && act(() => api.patch(`/api/units/${u.id}/employees/${p.id}`, { status: "inactive" }), "Faolsizlantirildi.")}>Faolsizlantirish</button>
                      ) : (
                        <button className="link" onClick={() => act(() => api.patch(`/api/units/${u.id}/employees/${p.id}`, { status: "active" }), "Faollashtirildi.")}>Faollashtirish</button>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {o.employees === undefined && o.employeeCount !== undefined && <p className="muted">Xodimlar soni: {o.employeeCount}</p>}
      {o.access.canManageEmployees && <AddEmployee unitId={u.id} onDone={(r) => { setSecret({ who: "xodim", ...r }); load(); }} />}

      {o.tasks && (
        <section>
          <h3>Vazifalar</h3>
          {o.tasks.length === 0 && <p className="muted">Hozircha vazifa yo'q.</p>}
          <ul className="unit-tasks">
            {o.tasks.slice(0, 30).map((t) => (
              <li key={t.id}>
                <span>{t.title}</span>
                <small>
                  {STATUS[t.status] ?? t.status} · {t.agentId ? "AI Direktor" : t.assigneeUserId === user?.id ? "siz" : peopleById.get(t.assigneeUserId ?? "")?.displayName ?? "xodim"}
                </small>
                <TaskSteps t={t} lead={o.access.canAssignTasks} mine={t.assigneeUserId === user?.id}
                  onMove={(to) => act(() => api.post(`/api/units/${u.id}/tasks/${t.id}/transition`, { to }))} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {note && <div className={note.ok ? "notice ok" : "notice warn"} role={note.ok ? "status" : "alert"}>{note.text}</div>}
      {o.access.canAssignTasks && <NewUnitTask unitId={u.id} people={o.employees ?? []} onDone={load} />}
    </aside>
  );
}

/** Next steps of a human task for this viewer: the assignee moves their own work, the lead also reviews and cancels. */
function TaskSteps({ t, lead, mine, onMove }: { t: UnitTaskDto; lead: boolean; mine: boolean; onMove: (to: string) => void }) {
  if (t.kind !== "human" || (!lead && !mine)) return null;
  const steps = (FLOW[t.status] ?? []).filter((s) => (s.lead ? lead : true));
  if (!steps.length) return null;
  return (
    <span className="unit-actions">
      {steps.map((s) => (
        <button key={s.to} className={s.to === "CANCELLED" ? "link danger" : "link"} onClick={() => onMove(s.to)}>{s.label}</button>
      ))}
    </span>
  );
}

function useSubmit<T>(fn: () => Promise<T>, onDone: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

type Invite = { username: string; activationToken: string; expiresAt: string };

function AssignDirector({ unitId, onDone }: { unitId: string; onDone: (r: { username: string; token: string; expiresAt: string }) => void }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const { busy, error, submit } = useSubmit(
    () => api.post<Invite>(`/api/units/${unitId}/director`, { displayName: name.trim(), ...(username.trim() ? { username: username.trim() } : {}) }),
    (r) => onDone({ username: r.username, token: r.activationToken, expiresAt: r.expiresAt }),
  );
  return (
    <section>
      <h3>Haqiqiy direktorni tayinlash</h3>
      <form className="unit-form" onSubmit={submit}>
        <label className="field">F.I.Sh.<input id={`dir-name-${unitId}`} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></label>
        <label className="field">Login (ixtiyoriy)<input id={`dir-user-${unitId}`} value={username} onChange={(e) => setUsername(e.target.value)} pattern="[A-Za-z0-9._-]{3,40}" /></label>
        {error && <div className="login-error">{error}</div>}
        <button className="primary small" disabled={busy}>Tayinlash va kod olish</button>
      </form>
    </section>
  );
}

function AddEmployee({ unitId, onDone }: { unitId: string; onDone: (r: { username: string; token: string; expiresAt: string }) => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<"unit_staff" | "unit_manager">("unit_staff");
  const { busy, error, submit } = useSubmit(
    () => api.post<Invite>(`/api/units/${unitId}/employees`, { displayName: name.trim(), jobTitle: title.trim() || undefined, role }),
    (r) => { setName(""); setTitle(""); onDone({ username: r.username, token: r.activationToken, expiresAt: r.expiresAt }); },
  );
  return (
    <section>
      <h3>Xodim qo'shish</h3>
      <form className="unit-form" onSubmit={submit}>
        <label className="field">F.I.Sh.<input id={`emp-name-${unitId}`} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></label>
        <label className="field">Lavozim<input id={`emp-title-${unitId}`} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Rol
          <select id={`emp-role-${unitId}`} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="unit_staff">Xodim</option>
            <option value="unit_manager">Menejer</option>
          </select>
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="primary small" disabled={busy}>Qo'shish va taklif kodi olish</button>
      </form>
    </section>
  );
}

function NewUnitTask({ unitId, people, onDone }: { unitId: string; people: UnitPersonDto[]; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [to, setTo] = useState("ai");
  const active = people.filter((p) => p.status === "active" && p.role !== "unit_director");
  const { busy, error, submit } = useSubmit(
    () => api.post(`/api/units/${unitId}/tasks`, { title: title.trim(), ...(to === "ai" ? { toAiDirector: true } : { assigneeUserId: to }) }),
    () => { setTitle(""); onDone(); },
  );
  return (
    <section>
      <h3>Yangi vazifa</h3>
      <form className="unit-form" onSubmit={submit}>
        <label className="field">Vazifa<input id={`task-title-${unitId}`} value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <label className="field">Kimga
          <select id={`task-to-${unitId}`} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="ai">AI Direktor</option>
            {active.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="primary small" disabled={busy}>Berish</button>
      </form>
    </section>
  );
}
