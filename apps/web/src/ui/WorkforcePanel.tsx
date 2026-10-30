// HQ AI workforce: the AI Director, live agent and task counts, token use and estimated spend, provider health,
// and each project (an orchestrated task) with its plan, subtasks, agents, dependencies, evaluations, blockers and
// approvals — all from /api/workforce (real rows, no invented progress). The Human Director submits work here.
import { useState } from "react";
import { api } from "../api/client";
import { useOffice } from "../api/office";
import { Empty, Loading, Msg, run, useLoad, type Note } from "./people/common";

interface Sub { id: string; title: string; status: string; stage: string | null; error: string | null; agent: string | null; dependsOn: string[]; revisionOf: string | null; verdict: string | null; issues: string[] }
interface Project {
  id: string; title: string; status: string; stage: string | null; error: string | null; createdAt: string; costUsd: number; tokens: number;
  plan: { objective?: string; expectedOutcome?: string; requiredSkills?: string[] } | null; subtasks: Sub[]; approvals: number;
  hireRequests: { templateName: string; status: string; departmentId: string }[];
}
interface State {
  director: { agentId: string | null; name: string | null; provider: string | null; model: string | null; limits: { maxSubtasks: number; maxRevisions: number; maxAiHireRequests: number; budgetAlertPct: number } };
  templates: number; agents: { active: number; available: number; busy: number; suspended: number; archived: number }; hireRequestsPending: number;
  tasks: { running: number; waiting: number; completed: number; failed: number; blocked: number };
  usage: { tokensIn: number; tokensOut: number; costUsd: number; byProvider: { provider: string; tokens: number; costUsd: number; runs: number }[]; mock: number };
  projects: Project[];
}
interface Health { provider: string; model: string; status: string; ok: boolean; detail?: string }

const STATUS: Record<string, string> = {
  not_configured: "sozlanmagan", invalid_credentials: "kalit noto'g'ri", rate_limited: "limit tugagan", available: "ishlayapti", unavailable: "vaqtincha ishlamaydi",
};
const TASK: Record<string, string> = {
  BACKLOG: "agent kutmoqda", QUEUED: "navbatda", WAITING_FOR_DEPENDENCY: "bog'liqlikni kutmoqda", IN_PROGRESS: "bajarilmoqda", WAITING_APPROVAL: "tasdiq kutmoqda",
  DONE: "bajarildi", FAILED: "xato", BLOCKED: "to'xtagan", CANCELLED: "bekor",
};
const VERDICT: Record<string, string> = { ACCEPTED: "qabul", NEEDS_REVISION: "qayta ishlashga", REJECTED: "rad etildi", NEEDS_HUMAN_REVIEW: "inson ko'rishi kerak" };

export function WorkforcePanel({ onClose, onOpenTask }: { onClose: () => void; onOpenTask?: (id: string) => void }) {
  const { can } = useOffice();
  const { data, error, reload } = useLoad<{ state: State; providers: Health[]; mode: string | null }>("/api/workforce");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [budget, setBudget] = useState("");
  const [msg, setMsg] = useState<Note>(null);
  const s = data?.state;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal brain workforce" role="dialog" aria-label="AI ishchi kuchi" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">AI Direktor topshiriqni rejalaydi, agentlarga bo'ladi, natijalarni baholaydi va birlashtiradi</div>
            <h2>AI ishchi kuchi</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="notice warn">{error}</div>}
          {!s ? !error && <Loading /> : (
            <>
              {data!.mode === "mock" && <div className="notice warn">MOCK rejim: AI javoblari sinov dublyori, haqiqiy AI emas.</div>}
              <section className="wf-providers">
                {data!.providers.map((p) => (
                  <span key={p.provider} className={`tag ${p.ok ? "ok" : "bad"}`} title={p.detail}>{p.provider}{p.model ? ` · ${p.model}` : ""}: {STATUS[p.status] ?? p.status}</span>
                ))}
                <span className="muted">AI Direktor: <b>{s.director.name ?? "yo'q"}</b>{s.director.provider ? ` · ${s.director.provider}` : ""}{s.director.model ? ` · ${s.director.model}` : ""}</span>
              </section>
              <div className="wf-kpis">
                <div><b>{s.templates}</b><small>andoza</small></div>
                <div><b>{s.agents.active}</b><small>faol agent</small></div>
                <div><b>{s.agents.available}</b><small>bo'sh</small></div>
                <div><b>{s.agents.busy}</b><small>band</small></div>
                <div><b>{s.agents.suspended}</b><small>to'xtatilgan</small></div>
                <div><b>{s.hireRequestsPending}</b><small>yollash so'rovi</small></div>
                <div><b>{s.tasks.running}</b><small>bajarilmoqda</small></div>
                <div><b>{s.tasks.completed}</b><small>bajarildi (30 kun)</small></div>
                <div><b>{s.tasks.failed}</b><small>xato (30 kun)</small></div>
                <div><b>{s.tasks.blocked}</b><small>to'xtagan</small></div>
                <div><b>{(s.usage.tokensIn + s.usage.tokensOut).toLocaleString()}</b><small>token (30 kun)</small></div>
                <div><b>${s.usage.costUsd.toFixed(4)}</b><small>taxminiy xarajat</small></div>
              </div>
              {s.usage.mock > 0 && <p className="hint">Shundan {s.usage.mock} ta chaqiruv MOCK (sinov) rejimida bo'lgan.</p>}

              {can("tasks:create") && (
                <form className="ins-card new" onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api.post("/api/tasks", {
                    title: title.trim(), description: details.trim(), ...(budget ? { limits: { maxCostUsd: Number(budget) } } : {}),
                  }), setMsg, "AI Direktorga yuborildi.").then((ok) => { if (ok) { setTitle(""); setDetails(""); reload(); } });
                }}>
                  <b>AI Direktorga topshiriq</b>
                  <input placeholder="Masalan: SAG Home Design uchun choraklik o'sish strategiyasi" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
                  <textarea rows={2} placeholder="Tafsilotlar: maqsad, cheklovlar, kutilgan natija" value={details} onChange={(e) => setDetails(e.target.value)} />
                  <div className="row-end">
                    <label className="field">Byudjet, $ (ixtiyoriy)<input type="number" min={0} step={0.01} value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
                    <button className="primary small" disabled={!title.trim()}>Yuborish</button>
                  </div>
                  <Msg m={msg} />
                </form>
              )}

              <h3>Loyihalar</h3>
              {!s.projects.length ? <Empty>Hali loyiha yo'q.</Empty> : s.projects.map((p) => (
                <section key={p.id} className={`ins-card wf-project s-${p.status}`}>
                  <div className="sec-head">
                    <button className="link" onClick={() => onOpenTask?.(p.id)}><b>{p.title}</b></button>
                    <span className="tag">{TASK[p.status] ?? p.status}</span>
                  </div>
                  {p.plan?.objective && <div className="muted">Maqsad: {p.plan.objective}{p.plan.expectedOutcome ? ` · Natija: ${p.plan.expectedOutcome}` : ""}</div>}
                  <div className="muted">{p.stage ?? ""} · {p.tokens.toLocaleString()} token · ${p.costUsd.toFixed(4)}{p.approvals ? ` · ${p.approvals} ta tasdiq kutmoqda` : ""}</div>
                  {p.error && <div className="notice warn">{p.error}</div>}
                  <table className="runs">
                    <thead><tr><th>Kichik vazifa</th><th>Agent</th><th>Holat</th><th>Baho</th></tr></thead>
                    <tbody>
                      {p.subtasks.map((t) => (
                        <tr key={t.id}>
                          <td>{t.revisionOf ? "↻ " : ""}{t.title}{t.dependsOn.length ? <div className="muted">kutadi: {t.dependsOn.map((d) => p.subtasks.find((x) => x.id === d)?.title ?? d).join(", ")}</div> : null}</td>
                          <td>{t.agent ?? <span className="err">agent yo'q</span>}</td>
                          <td>{TASK[t.status] ?? t.status}{t.error ? <div className="err">{t.error}</div> : t.stage && t.status !== "DONE" ? <div className="muted">{t.stage}</div> : null}</td>
                          <td>{t.verdict ? VERDICT[t.verdict] ?? t.verdict : "—"}{t.issues.length ? <div className="muted">{t.issues.join("; ")}</div> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {p.hireRequests.length > 0 && <div className="muted">Yollash so'rovlari: {p.hireRequests.map((h) => `${h.templateName} (${h.status})`).join(", ")}</div>}
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
