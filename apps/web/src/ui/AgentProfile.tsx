import { useEffect, useRef, useState, type FormEvent } from "react";
import { Markdown } from "./Markdown";
import type { AgentProfileDto } from "@sag/shared";
import { api } from "../api/client";
import { useOffice } from "../api/office";
import { StatusPill, TaskStatusPill, fmtTokens, fmtUsd } from "./shared";
import { confirmDialog } from "./dialog";

export function AgentProfile({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { office, can, tick } = useOffice();
  const [p, setP] = useState<AgentProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);

  useEffect(() => {
    let alive = true;
    api
      .get<AgentProfileDto>(`/api/agents/${encodeURIComponent(agentId)}`)
      .then((r) => alive && (setP(r), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [agentId, tick, n]);

  const act = async (action: "pause" | "resume" | "stop") => {
    if (action === "stop" && !(await confirmDialog("Agentning joriy ishini to'xtatasizmi? Faqat shu agentning vazifalari BLOCKED holatiga o'tadi.", { confirmLabel: "To'xtatish", danger: true }))) return;
    setBusy(true);
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/${action}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dep = p ? office?.departments[p.agent.departmentId] : undefined;
  const a = p?.agent;
  const control = can("agents:control");

  return (
    <div className="profile" role="dialog" aria-label="Agent profili">
      <div className="profile-head" style={{ ["--dep" as string]: dep?.color ?? "#64748b" }}>
        <span className="av lg">{a?.name[0] ?? "…"}</span>
        <div>
          <h2>{a?.name ?? "Yuklanmoqda…"}</h2>
          {a && <div className="muted">{a.role} · {dep?.name}</div>}
        </div>
        <button className="close" onClick={onClose} aria-label="Yopish">×</button>
      </div>
      <div className="profile-body">
        {error && <div className="login-error" role="alert">{error}</div>}
        {p && a && (
          <>
            <div className="row">
              <StatusPill status={a.status} />
              <span className="muted">{a.lifecycle === "PAUSED" ? "To'xtatilgan (paused)" : a.lifecycle === "ARCHIVED" ? "Arxivlangan" : "Faol"}</span>
            </div>
            <dl>
              <dt>Joriy vazifa</dt>
              <dd>
                {a.currentTask ? (
                  <>
                    {a.currentTask.title} <small className="muted">· {a.currentTask.stage ?? a.currentTask.status}{a.currentTask.progress !== null ? ` · ${a.currentTask.progress}%` : ""}</small>
                  </>
                ) : "—"}
              </dd>
              <dt>Oxirgi vazifalar</dt>
              <dd>
                {p.recentTasks.length ? (
                  <ul className="task-mini">
                    {p.recentTasks.map((t) => <li key={t.id}><span>{t.title}</span><TaskStatusPill status={t.status} /></li>)}
                  </ul>
                ) : "Hali vazifa bajarilmagan"}
              </dd>
              <dt>Connectorlar</dt>
              <dd className="conn-list">
                {can("agents:manage") ? <ConnectorGrants agentId={a.id} departmentId={a.departmentId} connectors={p.connectors} onSaved={reload} /> : p.connectors.filter((c) => c.granted).map((c) => (
                  <span key={c.id} className={`connector-tag ${c.status === "connected" ? "on" : "off"}`}>
                    {c.name} · {c.allowedActions.includes("write") ? "o'qish + yozish" : "o'qish"} · {c.status === "connected" ? "ulangan" : "ulanmagan"}
                  </span>
                ))}
              </dd>
              <dt>Sarflangan tokenlar</dt>
              <dd>
                {p.usage.hidden ? "–" : <>{fmtTokens(p.usage.inputTokens + p.usage.outputTokens)} · {fmtUsd(p.usage.costUsd)}</>}
                <small className="muted"> ({p.usage.runs} ta chaqiruv)</small>
              </dd>
              <dt>Oxirgi xatolar</dt>
              <dd>
                {p.errors.length ? (
                  <ul>{p.errors.map((e) => <li key={e.taskId} className="err">{e.title}: {e.error}</li>)}</ul>
                ) : "—"}
              </dd>
            </dl>
            <div className="actions">
              {a.lifecycle === "PAUSED" ? (
                <button disabled={!control || busy} onClick={() => act("resume")}>Resume</button>
              ) : (
                <button disabled={!control || busy || a.lifecycle !== "ACTIVE"} onClick={() => act("pause")}>Pause</button>
              )}
              <button disabled={!control || busy} onClick={() => act("stop")} className="danger">Stop</button>
            </div>
            {!control && <p className="hint">Boshqarish uchun "agents:control" ruxsati kerak.</p>}
            <AgentChat agentId={a.id} name={a.name} canSend={can("ai_tasks:create")} />
          </>
        )}
      </div>
    </div>
  );
}

interface ChatMsg {
  id: string;
  role: "user" | "agent";
  content: string;
  createdAt: string;
}

/** Direct chat with one agent (answers in its role, grounded in its instructions). */
function AgentChat({ agentId, name, canSend }: { agentId: string; name: string; canSend: boolean }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<{ messages: ChatMsg[] }>(`/api/agents/${encodeURIComponent(agentId)}/chat`).then((r) => setMsgs(r.messages)).catch(() => {});
  }, [agentId]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [msgs, busy]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const m = text.trim();
    if (!m) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ messages: ChatMsg[] }>(`/api/agents/${encodeURIComponent(agentId)}/chat`, { message: m });
      setMsgs((x) => [...x, ...r.messages]);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <div className="chat-log">
        {!msgs.length && <div className="chat-empty">{name} bilan suhbatni boshlang.</div>}
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.role === "agent" ? <Markdown text={m.content} /> : m.content}
          </div>
        ))}
        {busy && <div className="bubble agent typing">…</div>}
        <div ref={end} />
      </div>
      {error && <div className="login-error">{error}</div>}
      <form className="chat-input" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`${name}ga xabar…`} disabled={!canSend || busy} maxLength={4000} />
        <button disabled={!canSend || busy || !text.trim()}>Yuborish</button>
      </form>
    </div>
  );
}

/**
 * Which connectors this agent may use: only ones its department is allowed; "yozish" lets it propose write actions,
 * each of which still needs a person's approval. Internal knowledge/people tools are always available.
 */
function ConnectorGrants({ agentId, departmentId, connectors, onSaved }: {
  agentId: string; departmentId: string; onSaved: () => void;
  connectors: { id: string; name: string; status: string; granted: boolean; allowedActions: string[] }[];
}) {
  const { office } = useOffice();
  const allowed = new Set(office?.departments[departmentId]?.connectors ?? []);
  const mine = connectors.filter((c) => allowed.has(c.id));
  const [read, setRead] = useState(() => new Set(mine.filter((c) => c.granted).map((c) => c.id)));
  const [write, setWrite] = useState(() => new Set(mine.filter((c) => c.allowedActions.includes("write")).map((c) => c.id)));
  const [msg, setMsg] = useState<string | null>(null);
  const flip = (set: Set<string>, id: string, on: boolean) => { const n = new Set(set); if (on) n.add(id); else n.delete(id); return n; };
  if (!mine.length) return <span className="muted">Bo'limga connector ruxsat etilmagan (The Brain → Connectorlar).</span>;
  const save = async () => {
    try {
      await api.put(`/api/agents/${agentId}/connectors`, { connectorIds: [...read], writeIds: [...write].filter((w) => read.has(w)) });
      setMsg("Saqlandi.");
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="grants">
      {mine.map((c) => (
        <div key={c.id} className="grant-row">
          <span className={`status-dot ${c.status}`} /><b>{c.name}</b>
          <label className="check"><input type="checkbox" checked={read.has(c.id)} onChange={(e) => { setRead(flip(read, c.id, e.target.checked)); if (!e.target.checked) setWrite(flip(write, c.id, false)); }} />o'qish</label>
          <label className="check"><input type="checkbox" checked={write.has(c.id)} disabled={!read.has(c.id)} onChange={(e) => setWrite(flip(write, c.id, e.target.checked))} />yozish (tasdiq bilan)</label>
        </div>
      ))}
      <div className="row-end">{msg && <span className="muted">{msg}</span>}<button className="link" onClick={() => void save()}>Ruxsatlarni saqlash</button></div>
    </div>
  );
}
