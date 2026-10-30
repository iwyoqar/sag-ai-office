// Agent marketplace (W4, HQ): catalog of approved templates and hiring with the checks shown up front; requests and
// decisions; for the admin also templates (drafts → approve → retire), per-department limits and archiving the
// seeded agents. Server: routes/marketplace.ts.
import { useEffect, useState } from "react";
import type { HireCheck, HireOutcome, HireRequestDto, HiringLimitDto, TemplateDto, TemplateTool } from "@sag/shared";
import { api } from "../../api/client";
import { useOffice } from "../../api/office";
import { Empty, Loading, Msg, run, useLoad, type Note } from "../people/common";
import { formatUzs, outcomeLabel } from "./outcome";

type Tab = "catalog" | "requests" | "templates" | "limits" | "archive";
const STATUS: Record<HireRequestDto["status"], string> = { PENDING: "Kutilmoqda", APPROVED: "Yollandi", REJECTED: "Rad etildi", CANCELLED: "Bekor qilindi" };
const RISK: Record<string, string> = { LOW: "past xavf", MEDIUM: "o'rta xavf", HIGH: "yuqori xavf" };

export function MarketplacePanel({ onClose }: { onClose: () => void }) {
  const { can } = useOffice();
  const admin = can("users:manage");
  const [tab, setTab] = useState<Tab>("catalog");
  const tabs: [Tab, string][] = [
    ["catalog", "Katalog"], ["requests", "So'rovlar"],
    ...(admin ? [["templates", "Andozalar"], ["limits", "Limitlar"], ["archive", "Mavjud agentlar"]] as [Tab, string][] : []),
  ];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal brain marketplace" role="dialog" aria-label="Agent marketplace" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">AI agentlar faqat tasdiqlangan andozalardan yollanadi; har bir yollash tekshiriladi va qayd etiladi</div>
            <h2>Marketplace</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="brain-tabs" role="tablist">
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <div className="modal-body">
          {tab === "catalog" && <Catalog />}
          {tab === "requests" && <Requests />}
          {tab === "templates" && <Templates />}
          {tab === "limits" && <Limits />}
          {tab === "archive" && <ArchiveAll />}
        </div>
      </div>
    </div>
  );
}

/** Departments this viewer may hire into: all active HQ departments for the admin, their own for a head. */
function useHireDepartments() {
  const { office, user, can } = useOffice();
  const all = Object.values(office?.departments ?? {});
  return can("users:manage") ? all : all.filter((d) => user?.managedDepartments?.includes(d.id));
}

// ---------------------------------------------------------------- catalog

function Catalog() {
  const { data, error, reload } = useLoad<{ templates: TemplateDto[] }>("/api/marketplace/templates");
  const { office } = useOffice();
  const [q, setQ] = useState("");
  const [dep, setDep] = useState("");
  const [hiring, setHiring] = useState<TemplateDto | null>(null);
  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <Loading />;
  const list = data.templates.filter((t) => t.status === "APPROVED" && t.current)
    .filter((t) => !dep || !t.allowedDepartments.length || t.allowedDepartments.includes(dep))
    .filter((t) => !q.trim() || `${t.name} ${t.current!.role} ${t.current!.responsibilities}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="mk-catalog">
      <div className="nt-row">
        <input placeholder="Qidirish…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Bo'lim bo'yicha">
          <option value="">Barcha bo'limlar</option>
          {Object.values(office?.departments ?? {}).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <span className="muted">{list.length} andoza</span>
      </div>
      {hiring && <HireForm t={hiring} onDone={() => { setHiring(null); reload(); }} onCancel={() => setHiring(null)} />}
      {!list.length ? <Empty>Mos andoza yo'q.</Empty> : (
        <div className="mk-cards">
          {list.map((t) => {
            const v = t.current!;
            return (
              <article key={t.id} className="mk-card">
                <header>
                  <b>{t.name}</b>
                  <span className={`badge risk-${v.riskLevel}`}>{RISK[v.riskLevel]}</span>
                </header>
                <div className="muted">{v.role} · v{v.version}{t.allowedDepartments.length ? ` · ${t.allowedDepartments.map((d) => office?.departments[d]?.short ?? d).join(", ")}` : ""}</div>
                {v.responsibilities && <p>{v.responsibilities.slice(0, 180)}{v.responsibilities.length > 180 ? "…" : ""}</p>}
                <div className="chips">{v.tools.map((x) => <span key={x.connectorId} className="tag">{x.connectorId}{x.actions.includes("write") ? " ✎" : ""}</span>)}</div>
                <footer>
                  <span className="muted">{v.model ?? "standart model"} · {formatUzs(v.estMonthlyMinor)}{v.estMonthlyMinor ? "/oy" : ""} · {t.hiredCount} faol</span>
                  <button className="primary small" onClick={() => setHiring(t)}>Yollash</button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HireForm({ t, onDone, onCancel }: { t: TemplateDto; onDone: () => void; onCancel: () => void }) {
  const { can } = useOffice();
  const admin = can("users:manage");
  const deps = useHireDepartments().filter((d) => !t.allowedDepartments.length || t.allowedDepartments.includes(d.id));
  const [dep, setDep] = useState(deps[0]?.id ?? "");
  const [why, setWhy] = useState("");
  const [override, setOverride] = useState(false);
  const [check, setCheck] = useState<{ checks: HireCheck[]; outcome: HireOutcome } | null>(null);
  const [msg, setMsg] = useState<Note>(null);
  useEffect(() => {
    setCheck(null);
    if (!dep) return;
    let alive = true;
    api.post<{ checks: HireCheck[]; outcome: HireOutcome }>("/api/marketplace/check", { templateId: t.id, departmentId: dep })
      .then((r) => alive && setCheck(r)).catch((e) => alive && setMsg({ ok: false, text: e.message }));
    return () => { alive = false; };
  }, [t.id, dep]);
  const softFails = check?.checks.filter((c) => !c.hard && !c.ok) ?? [];
  const needsOverride = admin && check?.outcome === "hire" && softFails.length > 0;
  const label = check && (needsOverride ? { tone: "warn" as const, text: `limitdan tashqari: ${softFails.map((c) => c.detail).join("; ")}` } : outcomeLabel(check.outcome, check.checks));
  if (!deps.length) return <div className="notice warn">Bu andozani yollash mumkin bo'lgan bo'limingiz yo'q. <button className="link" onClick={onCancel}>Yopish</button></div>;
  return (
    <form className="ins-card new" onSubmit={(e) => {
      e.preventDefault();
      void run(() => api.post<{ request: HireRequestDto }>("/api/marketplace/requests", { templateId: t.id, departmentId: dep, justification: why.trim(), ...(override ? { override: true } : {}) }), setMsg, "Yuborildi.")
        .then((ok) => ok && onDone());
    }}>
      <b>Yollash: {t.name}</b>
      <div className="nt-row">
        <select value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Bo'lim">
          {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <textarea rows={2} placeholder="Nega kerak? (majburiy)" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={1000} />
      {label && <div className={`notice ${label.tone === "ok" ? "ok" : "warn"}`}>{label.text}</div>}
      {check && <ul className="mk-checks">{check.checks.map((c) => <li key={c.id} className={c.ok ? "ok" : c.hard ? "bad" : "warn"}>{c.ok ? "✓" : "✗"} {c.detail}</li>)}</ul>}
      {needsOverride && <label className="check"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Limitdan oshishini tasdiqlayman</label>}
      <Msg m={msg} />
      <div className="row-end">
        <button type="button" className="link" onClick={onCancel}>Bekor</button>
        <button className="primary small" disabled={why.trim().length < 3 || !check || check.outcome === "reject" || (needsOverride && !override)}>Yuborish</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- requests

function Requests() {
  const { can, office, user } = useOffice();
  const admin = can("users:manage");
  const { data, error, reload } = useLoad<{ requests: HireRequestDto[] }>("/api/marketplace/requests");
  const [msg, setMsg] = useState<Note>(null);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <Loading />;
  if (!data.requests.length) return <Empty>So'rovlar yo'q.</Empty>;
  return (
    <div className="mk-requests">
      <Msg m={msg} />
      {data.requests.map((r) => {
        const soft = r.checks.filter((c) => !c.hard && !c.ok);
        return (
          <section key={r.id} className={`ins-card mk-req s-${r.status}`}>
            <div className="sec-head">
              <b>{r.templateName} → {office?.departments[r.departmentId]?.name ?? r.departmentId}</b>
              <span className="tag">{STATUS[r.status]}{r.decidedVia === "policy" && r.status === "APPROVED" ? " (avto)" : ""}{r.override ? " · limitdan tashqari" : ""}</span>
            </div>
            <div className="muted">{r.requestedBy.name} · {new Date(r.createdAt).toLocaleString()} · “{r.justification}”</div>
            {r.decisionReason && <div className="muted">Sabab: {r.decisionReason}</div>}
            <ul className="mk-checks">{r.checks.filter((c) => !c.ok).map((c) => <li key={c.id} className={c.hard ? "bad" : "warn"}>✗ {c.detail}</li>)}</ul>
            {r.status === "PENDING" && (
              <div className="row-end">
                {admin && soft.length > 0 && (
                  <label className="check"><input type="checkbox" checked={!!override[r.id]} onChange={(e) => setOverride({ ...override, [r.id]: e.target.checked })} /> Limitdan oshishini tasdiqlayman</label>
                )}
                {admin && <button className="link danger" onClick={() => {
                  const reason = window.prompt("Rad etish sababi:");
                  if (reason && reason.trim().length >= 3) void run(() => api.post(`/api/marketplace/requests/${r.id}/reject`, { reason: reason.trim() }), setMsg, "Rad etildi.").then(reload);
                }}>Rad etish</button>}
                {admin && <button className="primary small" disabled={soft.length > 0 && !override[r.id]}
                  onClick={() => void run(() => api.post(`/api/marketplace/requests/${r.id}/approve`, { override: !!override[r.id] }), setMsg, "Tasdiqlandi.").then(reload)}>Tasdiqlash</button>}
                {r.requestedBy.id === user?.id && <button className="link" onClick={() => void run(() => api.post(`/api/marketplace/requests/${r.id}/cancel`), setMsg, "Bekor qilindi.").then(reload)}>Bekor qilish</button>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- templates (admin)

interface VersionForm { role: string; responsibilities: string; skills: string; instructions: string; tools: TemplateTool[]; model: string; maxTokens: string; som: string }
const blank: VersionForm = { role: "", responsibilities: "", skills: "", instructions: "", tools: [], model: "", maxTokens: "", som: "0" };
const toBody = (f: VersionForm) => ({
  role: f.role.trim(), responsibilities: f.responsibilities, skills: f.skills.split(",").map((s) => s.trim()).filter(Boolean), instructions: f.instructions,
  tools: f.tools, model: f.model.trim() || null, maxTokensPerTask: f.maxTokens ? Number(f.maxTokens) : null, estMonthlyMinor: Math.round(Number(f.som || 0) * 100),
});

function VersionEditor({ initial, onSave, onCancel, title }: { initial: VersionForm; onSave: (f: VersionForm) => void; onCancel: () => void; title: string }) {
  const { office } = useOffice();
  const [f, setF] = useState(initial);
  const mode = (c: string) => { const t = f.tools.find((x) => x.connectorId === c); return !t ? "" : t.actions.includes("write") ? "rw" : "r"; };
  const setMode = (c: string, m: string) =>
    setF({ ...f, tools: [...f.tools.filter((x) => x.connectorId !== c), ...(m ? [{ connectorId: c, actions: m === "rw" ? ["read", "write"] as ("read" | "write")[] : ["read"] as ("read" | "write")[] }] : [])] });
  return (
    <form className="ins-card new" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
      <b>{title}</b>
      <div className="nt-row">
        <input placeholder="Rol" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} required maxLength={120} />
        <input placeholder="Model (bo'sh = standart)" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
        <input type="number" min={0} placeholder="Token limiti" value={f.maxTokens} onChange={(e) => setF({ ...f, maxTokens: e.target.value })} />
        <label className="field">Oylik narx, so'm<input type="number" min={0} value={f.som} onChange={(e) => setF({ ...f, som: e.target.value })} /></label>
      </div>
      <textarea rows={2} placeholder="Vazifalari" value={f.responsibilities} onChange={(e) => setF({ ...f, responsibilities: e.target.value })} />
      <input placeholder="Ko'nikmalar (vergul bilan)" value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} />
      <textarea rows={3} placeholder="Ko'rsatmalar" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
      <div className="mk-tools">
        {(office?.connectors ?? []).map((c) => (
          <label key={c.id} className="field">{c.name}
            <select value={mode(c.id)} onChange={(e) => setMode(c.id, e.target.value)}>
              <option value="">—</option><option value="r">o'qish</option><option value="rw">o'qish + yozish</option>
            </select>
          </label>
        ))}
      </div>
      <div className="row-end"><button type="button" className="link" onClick={onCancel}>Bekor</button><button className="primary small">Qoralamani saqlash</button></div>
    </form>
  );
}

function Templates() {
  const { office } = useOffice();
  const { data, error, reload } = useLoad<{ templates: TemplateDto[] }>("/api/marketplace/templates");
  const [msg, setMsg] = useState<Note>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [head, setHead] = useState({ name: "", category: "", dep: "" });
  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <Loading />;
  const formOf = (t: TemplateDto): VersionForm => {
    const v = t.draft ?? t.current;
    return v ? { role: v.role, responsibilities: v.responsibilities, skills: v.skills.join(", "), instructions: v.instructions, tools: v.tools, model: v.model ?? "", maxTokens: v.maxTokensPerTask ? String(v.maxTokensPerTask) : "", som: String(v.estMonthlyMinor / 100) } : blank;
  };
  return (
    <div className="mk-templates">
      <Msg m={msg} />
      {creating ? (
        <>
          <div className="nt-row">
            <input placeholder="Andoza nomi" value={head.name} onChange={(e) => setHead({ ...head, name: e.target.value })} />
            <input placeholder="Toifa" value={head.category} onChange={(e) => setHead({ ...head, category: e.target.value })} />
            <select value={head.dep} onChange={(e) => setHead({ ...head, dep: e.target.value })} aria-label="Bo'lim">
              <option value="">Istalgan bo'lim</option>
              {Object.values(office?.departments ?? {}).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <VersionEditor title="Yangi andoza (qoralama)" initial={blank} onCancel={() => setCreating(false)} onSave={(f) =>
            void run(() => api.post("/api/marketplace/templates", { name: head.name.trim(), category: head.category.trim() || "umumiy", allowedDepartments: head.dep ? [head.dep] : [], version: toBody(f) }), setMsg, "Qoralama yaratildi — tasdiqlang.")
              .then((ok) => { if (ok) { setCreating(false); reload(); } })} />
        </>
      ) : <div className="row-end"><button className="primary small" onClick={() => setCreating(true)}>+ Yangi andoza</button></div>}
      <table className="runs">
        <thead><tr><th>Andoza</th><th>Holat</th><th>Versiya</th><th>Narx</th><th>Faol</th><th /></tr></thead>
        <tbody>
          {data.templates.map((t) => (
            <tr key={t.id}>
              <td><b>{t.name}</b><div className="muted">{t.current?.role ?? t.draft?.role} · {t.allowedDepartments.map((d) => office?.departments[d]?.short ?? d).join(", ") || "istalgan bo'lim"}</div></td>
              <td>{t.status === "APPROVED" ? "tasdiqlangan" : t.status === "DRAFT" ? "qoralama" : "eskirgan"}</td>
              <td>{t.currentVersion ? `v${t.currentVersion}` : "—"}{t.draft ? ` · qoralama v${t.draft.version}` : ""}</td>
              <td>{formatUzs((t.current ?? t.draft)?.estMonthlyMinor ?? 0)}</td>
              <td>{t.hiredCount}</td>
              <td className="agent-actions">
                {t.status !== "RETIRED" && <button onClick={() => setEditing(editing === t.id ? null : t.id)}>Tahrirlash</button>}
                {t.draft && t.status !== "RETIRED" && <button onClick={() => void run(() => api.post(`/api/marketplace/templates/${t.id}/versions/${t.draft!.version}/approve`), setMsg, "Tasdiqlandi.").then(reload)}>Tasdiqlash</button>}
                {t.status !== "RETIRED" && <button className="danger" onClick={() => window.confirm(`${t.name} katalogdan olinsinmi? Yollangan agentlar qoladi.`) && void run(() => api.post(`/api/marketplace/templates/${t.id}/retire`), setMsg, "Eskirgan deb belgilandi.").then(reload)}>Eskirgan</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (() => {
        const t = data.templates.find((x) => x.id === editing)!;
        return <VersionEditor key={t.id} title={`${t.name}: ${t.draft ? `qoralama v${t.draft.version}` : "yangi qoralama"}`} initial={formOf(t)} onCancel={() => setEditing(null)}
          onSave={(f) => void run(() => api.post(`/api/marketplace/templates/${t.id}/versions`, toBody(f)), setMsg, "Qoralama saqlandi — chiqarish uchun tasdiqlang.").then((ok) => { if (ok) { setEditing(null); reload(); } })} />;
      })()}
    </div>
  );
}

// ---------------------------------------------------------------- limits (admin)

function Limits() {
  const { office } = useOffice();
  const { data, error, reload } = useLoad<{ limits: HiringLimitDto[] }>("/api/marketplace/limits");
  const { data: tpl } = useLoad<{ templates: TemplateDto[] }>("/api/marketplace/templates");
  const [msg, setMsg] = useState<Note>(null);
  if (error) return <div className="notice warn">{error}</div>;
  if (!data || !tpl) return <Loading />;
  const approved = tpl.templates.filter((t) => t.status === "APPROVED");
  return (
    <div className="mk-limits">
      <p className="hint">Bo'lim rahbari shu chegaralar ichida va avto-ro'yxatdagi andozalarni o'zi yollaydi; qolgani sizning tasdig'ingizga keladi. Bo'sh = limit yo'q.</p>
      <Msg m={msg} />
      <table className="runs">
        <thead><tr><th>Bo'lim</th><th>Agentlar (hozir / max)</th><th>Oylik byudjet, so'm</th><th>Avto-ro'yxat</th></tr></thead>
        <tbody>
          {data.limits.map((l) => {
            const save = (p: Partial<{ maxAgents: number | null; monthlyBudgetMinor: number | null; autoTemplates: string[] }>) =>
              void run(() => api.put(`/api/marketplace/limits/${l.departmentId}`, p), setMsg, "Saqlandi.").then(reload);
            const fit = approved.filter((t) => !t.allowedDepartments.length || t.allowedDepartments.includes(l.departmentId));
            return (
              <tr key={l.departmentId}>
                <td><b>{office?.departments[l.departmentId]?.name ?? l.departmentId}</b></td>
                <td>{l.activeAgents} / <input className="num" type="number" min={0} defaultValue={l.maxAgents ?? ""} onBlur={(e) => save({ maxAgents: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                <td>
                  <input className="num" type="number" min={0} defaultValue={l.monthlyBudgetMinor == null ? "" : l.monthlyBudgetMinor / 100}
                    onBlur={(e) => save({ monthlyBudgetMinor: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) })} />
                  <div className="muted">band: {formatUzs(l.committedMinor)}</div>
                </td>
                <td>
                  <details>
                    <summary>{l.autoTemplates.length} ta andoza</summary>
                    {fit.map((t) => (
                      <label key={t.id} className="check">
                        <input type="checkbox" checked={l.autoTemplates.includes(t.id)} onChange={(e) =>
                          save({ autoTemplates: e.target.checked ? [...l.autoTemplates, t.id] : l.autoTemplates.filter((x) => x !== t.id) })} /> {t.name}
                      </label>
                    ))}
                    {!fit.length && <span className="muted">Mos andoza yo'q</span>}
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- archive the seeded agents (admin)

function ArchiveAll() {
  const { data, error, reload } = useLoad<{ agents: number; openTasks: number }>("/api/marketplace/archive-preview");
  const [msg, setMsg] = useState<Note>(null);
  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <Loading />;
  return (
    <section className="ins-card">
      <b>Mavjud agentlarni arxivlash</b>
      <p className="hint">
        Hozir {data.agents} ta HQ agenti ishlayapti, ularning {data.openTasks} ta ochiq vazifasi bor. Arxivlash ularni ofisdan olib tashlaydi va stollarini
        bo'shatadi; ochiq vazifalar bekor qilinadi. Vazifalar tarixi, xarajatlar va audit saqlanadi. Ularning sozlamalari katalogda andoza bo'lib qoladi.
      </p>
      <Msg m={msg} />
      <div className="row-end">
        <button className="danger" disabled={!data.agents} onClick={() =>
          window.confirm(`${data.agents} ta agent arxivlansinmi? ${data.openTasks} ta ochiq vazifa bekor qilinadi. Bu amalni qaytarib bo'lmaydi.`)
          && void run(() => api.post<{ archived: number; cancelledTasks: number }>("/api/marketplace/archive-all"), setMsg, "Arxivlandi.").then(reload)}>
          {data.agents ? `${data.agents} ta agentni arxivlash` : "Arxivlanadigan agent yo'q"}
        </button>
      </div>
    </section>
  );
}
