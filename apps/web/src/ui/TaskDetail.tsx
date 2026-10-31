import { useEffect, useState } from "react";
import type { OfficeEvent, TaskDto } from "@sag/shared";
import { api } from "../api/client";
import { useOffice } from "../api/office";
import { Markdown } from "./Markdown";
import { ApprovalsTab } from "./BrainPanel";
import { TaskStatusPill, fmtTokens, fmtUsd } from "./shared";
import { TaskEnginePanel } from "./TaskEnginePanel";

interface Detail {
  task: TaskDto;
  subtasks: TaskDto[];
  dependents: string[];
  events: OfficeEvent[];
  messages: { id: string; fromAgentId: string | null; toAgentId: string | null; kind: string; content: string; createdAt: string }[];
  deliverables: { id: string; agentId: string | null; title: string; content: string; createdAt: string }[];
  /** what the server withheld from this viewer (run records need ai_runs:read, tool payloads tool_io:read) */
  restricted?: { runs: boolean; payloads: boolean };
  runs: { id: string; agentId: string; model: string; mode: string; status: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number | null; error: string | null; startedAt: string }[];
}

const EVENT_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  "task.created": () => "Vazifa yaratildi",
  "task.status": (d) => `Holat: ${d.from ?? "?"} → ${d.to}${d.reason ? ` (${d.reason})` : ""}`,
  "task.progress": (d) => `${d.stage ?? ""}${d.progress !== null && d.progress !== undefined ? ` · ${d.progress}%` : ""}`,
  "task.updated": (d) => `Yangilandi${d.change ? `: ${d.change}` : ""}`,
  "agent.message": (d) => `Xabar: ${d.content}`,
};

const time = (iso: string) => new Date(iso).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit" });

export function TaskDetail({ taskId, onClose, onOpen }: { taskId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { office, tick, can } = useOffice();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"result" | "activity" | "runs">("result");
  const [reassign, setReassign] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .get<Detail>(`/api/tasks/${taskId}`)
      .then((r) => alive && (setD(r), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [taskId, tick]);

  const name = (id: string | null) => office?.agents.find((a) => a.id === id)?.name ?? (id ? id : "—");
  const act = async (path: string, body?: unknown) => {
    try {
      await api.post(`/api/tasks/${taskId}/${path}`, body ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const t = d?.task;
  const open = t && !["DONE", "CANCELLED"].includes(t.status);
  const final = d?.deliverables.at(-1);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Vazifa" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">{t?.kind === "orchestrate" ? "Bo'limlararo vazifa" : "Vazifa"} · {taskId}</div>
            <h2>{t?.title ?? "Yuklanmoqda…"}</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        {error && <div className="login-error">{error}</div>}
        {t && d && (
          <div className="modal-body">
            <div className="td-summary">
              <TaskStatusPill status={t.status} />
              <span>{t.departmentId ? office?.departments[t.departmentId]?.name : "—"}</span>
              <span>Agent: <b>{name(t.agentId)}</b></span>
              {t.progress !== null && <span>{t.progress}%</span>}
              {t.stage && <span className="muted">{t.stage}</span>}
              <span className="muted">Tokenlar: {fmtTokens(t.tokensIn + t.tokensOut)} · {fmtUsd(t.costUsd)} (taxminiy)</span>
              {Object.keys(t.limits).length > 0 && (
                <span className="muted">Limit: {[
                  t.limits.maxTokens && `${fmtTokens(t.limits.maxTokens)} token`,
                  t.limits.maxCostUsd && `$${t.limits.maxCostUsd}`,
                  t.limits.maxDurationMs && `${Math.round(t.limits.maxDurationMs / 60000)} daq`,
                  t.limits.maxIterations && `${t.limits.maxIterations} chaqiruv`,
                  t.limits.maxAgents && `${t.limits.maxAgents} bo'lim`,
                ].filter(Boolean).join(" · ")}</span>
              )}
            </div>
            {t.progress !== null && t.status !== "DONE" && <div className="bar"><i style={{ width: `${t.progress}%` }} /></div>}
            {t.error && <div className="login-error">Xato: {t.error}</div>}
            {t.status === "WAITING_APPROVAL" && <ApprovalsTab taskId={t.id} compact />}
            {t.description && <p className="td-desc">{t.description}</p>}
            <TaskEnginePanel taskId={t.id} />

            {(can("tasks:manage") || can("tasks:create")) && (
              <div className="td-actions">
                {open && <button onClick={() => act("cancel")}>Bekor qilish</button>}
                {(t.status === "FAILED" || t.status === "BLOCKED") && can("tasks:manage") && <button onClick={() => act("retry")}>Qayta urinish</button>}
                {open && t.kind === "single" && can("tasks:manage") && (
                  <span className="reassign">
                    <select value={reassign} onChange={(e) => setReassign(e.target.value)} aria-label="Agentni almashtirish">
                      <option value="">Agentni almashtirish…</option>
                      {office?.agents.filter((a) => a.lifecycle === "ACTIVE" && a.id !== t.agentId).map((a) => (
                        <option key={a.id} value={a.id}>{a.name} — {office.departments[a.departmentId]?.short}</option>
                      ))}
                    </select>
                    <button disabled={!reassign} onClick={() => act("reassign", { agentId: reassign }).then(() => setReassign(""))}>OK</button>
                  </span>
                )}
              </div>
            )}

            {d.subtasks.length > 0 && (
              <section>
                <h3>Kichik vazifalar</h3>
                <ul className="subtasks">
                  {d.subtasks.map((s) => (
                    <li key={s.id}>
                      <button onClick={() => onOpen(s.id)}>
                        <span>{s.title}</span>
                        <span className="muted">{name(s.agentId)} · {office?.departments[s.departmentId ?? ""]?.short}</span>
                        {s.dependsOn.length > 0 && <span className="muted">kutadi: {s.dependsOn.map((x) => d.subtasks.find((k) => k.id === x)?.title ?? x).join(", ")}</span>}
                        <TaskStatusPill status={s.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {t.parentId && <button className="link" onClick={() => onOpen(t.parentId!)}>← Umumiy vazifaga o'tish</button>}

            <div className="seg" role="tablist">
              <button className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>Natija ({d.deliverables.length})</button>
              <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Faoliyat</button>
              {!d.restricted?.runs && <button className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>AI chaqiruvlari ({d.runs.length})</button>}
            </div>

            {tab === "result" && (
              <section>
                {final ? (
                  d.deliverables.slice().reverse().map((x) => (
                    <article key={x.id} className="deliverable">
                      <div className="muted">{x.title} · {name(x.agentId)} · {time(x.createdAt)}</div>
                      <Markdown text={x.content} />
                    </article>
                  ))
                ) : (
                  <p className="hint">Natija hali yo'q.</p>
                )}
              </section>
            )}
            {tab === "activity" && (
              <section>
                <ul className="timeline">
                  {[
                    ...d.events.map((e) => ({ at: e.at, text: (EVENT_TEXT[e.type] ?? (() => e.type))(e.data) })),
                    ...d.messages.map((m) => ({ at: m.createdAt, text: `${name(m.fromAgentId)} → ${name(m.toAgentId)} (${m.kind}): ${m.content}` })),
                  ]
                    .sort((a, b) => a.at.localeCompare(b.at))
                    .map((x, i) => (
                      <li key={i}><span className="muted">{time(x.at)}</span> {x.text}</li>
                    ))}
                </ul>
              </section>
            )}
            {tab === "runs" && (
              <section>
                <table className="runs">
                  <thead><tr><th>Vaqt</th><th>Agent</th><th>Model</th><th>Holat</th><th>Token</th><th>ms</th></tr></thead>
                  <tbody>
                    {d.runs.map((r) => (
                      <tr key={r.id}>
                        <td>{time(r.startedAt)}</td>
                        <td>{name(r.agentId)}</td>
                        <td>{r.model}{r.mode === "mock" && <span className="badge warn">MOCK</span>}</td>
                        <td title={r.error ?? ""}>{r.status}</td>
                        <td>{r.inputTokens}/{r.outputTokens}</td>
                        <td>{r.latencyMs ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
