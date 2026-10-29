import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { AgentDto, ConnectorDto } from "@sag/shared";
import { api, ApiError } from "../api/client";
import { useOffice } from "../api/office";

type Tab = "company" | "instructions" | "knowledge" | "memory" | "approvals" | "agents" | "connectors";
const TABS: [Tab, string][] = [
  ["company", "Kompaniya"], ["instructions", "Ko'rsatmalar"], ["knowledge", "Bilimlar"], ["memory", "Xotira"],
  ["approvals", "Tasdiqlar"], ["agents", "Agentlar"], ["connectors", "Connectorlar"],
];

interface Instruction { id: string; scope: string; scopeId: string | null; title: string; content: string; version: number; isActive: boolean; createdAt: string }

/** Reload helper: refetch when the office ticks (realtime) or after an action. */
function useLoad<T>(url: string | null, deps: unknown[] = []) {
  const { tick } = useOffice();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    api.get<T>(url).then((r) => alive && (setData(r), setError(null))).catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, n, tick, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  return m ? <div className={m.ok ? "notice ok" : "notice warn"}>{m.text}</div> : null;
}

async function run(fn: () => Promise<unknown>, set: (m: { ok: boolean; text: string } | null) => void, okText: string) {
  try {
    await fn();
    set({ ok: true, text: okText });
    return true;
  } catch (e) {
    set({ ok: false, text: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export function BrainPanel({ onClose, initialTab = "company" }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal brain" role="dialog" aria-label="The Brain" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">Bilimlar, ko'rsatmalar, agentlar va connectorlar markazi</div>
            <h2>The Brain</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <div className="brain-tabs" role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="modal-body">
          {tab === "company" && <CompanyTab />}
          {tab === "instructions" && <InstructionsTab />}
          {tab === "knowledge" && <KnowledgeTab />}
          {tab === "memory" && <MemoryTab />}
          {tab === "approvals" && <ApprovalsTab />}
          {tab === "agents" && <AgentsTab />}
          {tab === "connectors" && <ConnectorsTab />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- company profile + global rules
function CompanyTab() {
  const { data, reload } = useLoad<{ instructions: Instruction[] }>("/api/instructions?scope=GLOBAL");
  const list = data?.instructions ?? [];
  const about = list.find((i) => i.title === "Kompaniya haqida");
  return (
    <>
      <p className="hint">
        Bu yerdagi matnlar <b>barcha agentlarga</b> beriladi. "Kompaniya haqida" — SAG nima qiladi, mahsulotlar, mijozlar, bozorlar,
        narx siyosati, muloqot uslubi. Qanchalik aniq yozilsa, agentlar natijasi shunchalik aniq bo'ladi.
      </p>
      <InstructionEditor scope="GLOBAL" scopeId={null} title="Kompaniya haqida" current={about} onSaved={reload} rows={12}
        placeholder={"Masalan:\nSAG — O'zbekistondagi gilam ishlab chiqaruvchi kompaniya (Samarqand). Mahsulotlar: …\nAsosiy mijozlar: …\nBozorlar: O'zbekiston, eksport: …\nMuloqot uslubi: hurmatli, aniq, o'zbek tilida.\nMan etilgan: narxlarni tasdiqsiz e'lon qilish, …"} />
      <h3>Boshqa umumiy qoidalar</h3>
      {list.filter((i) => i.title !== "Kompaniya haqida").map((i) => (
        <InstructionEditor key={i.id} scope="GLOBAL" scopeId={null} title={i.title} current={i} onSaved={reload} rows={6} />
      ))}
      <NewInstruction scope="GLOBAL" scopeId={null} onSaved={reload} />
    </>
  );
}

function InstructionEditor({ scope, scopeId, title, current, onSaved, rows = 6, placeholder }: {
  scope: string; scopeId: string | null; title: string; current?: Instruction; onSaved: () => void; rows?: number; placeholder?: string;
}) {
  const { can } = useOffice();
  const [text, setText] = useState(current?.content ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<Instruction[] | null>(null);
  useEffect(() => setText(current?.content ?? ""), [current?.id, current?.content]);
  const dirty = text.trim() !== (current?.content ?? "").trim();
  const save = () =>
    run(() => api.post("/api/instructions", { scope, scopeId, title, content: text.trim() }), setMsg, "Saqlandi (yangi versiya).").then((ok) => ok && onSaved());
  const loadHistory = async () => {
    const r = await api.get<{ instructions: Instruction[] }>(`/api/instructions?scope=${scope}${scopeId ? `&scopeId=${scopeId}` : ""}&history=true`);
    setHistory(r.instructions.filter((i) => i.title === title));
  };
  return (
    <div className="ins-card">
      <div className="ins-head">
        <b>{title}</b>
        {current && <span className="muted">v{current.version} · {new Date(current.createdAt).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })}</span>}
        {current && <button className="link" onClick={() => (history ? setHistory(null) : void loadHistory())}>{history ? "Yopish" : "Tarix"}</button>}
      </div>
      <textarea rows={rows} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} disabled={!can("brain:manage") && scope !== "AGENT"} />
      <div className="row-end">
        <Msg m={msg} />
        <button className="primary small" disabled={!dirty || !text.trim()} onClick={() => void save()}>Saqlash</button>
      </div>
      {history && (
        <ul className="timeline">
          {history.map((h) => (
            <li key={h.id}><span className="muted">v{h.version} · {h.createdAt.slice(0, 16).replace("T", " ")}{h.isActive ? " · faol" : ""}</span> {h.content.slice(0, 160)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewInstruction({ scope, scopeId, onSaved }: { scope: string; scopeId: string | null; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.post("/api/instructions", { scope, scopeId, title: title.trim(), content: content.trim() }), setMsg, "Qo'shildi.").then((ok) => {
      if (ok) {
        setTitle("");
        setContent("");
        onSaved();
      }
    });
  };
  return (
    <form className="ins-card new" onSubmit={submit}>
      <input placeholder="Yangi qoida nomi (masalan: Hisobot formati)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      <textarea rows={3} placeholder="Qoida matni" value={content} onChange={(e) => setContent(e.target.value)} />
      <div className="row-end">
        <Msg m={msg} />
        <button className="primary small" disabled={!title.trim() || !content.trim()}>Qo'shish</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- department / agent instructions
function InstructionsTab() {
  const { office } = useOffice();
  const [kind, setKind] = useState<"DEPARTMENT" | "AGENT">("DEPARTMENT");
  const deps = Object.values(office?.departments ?? {});
  const [scopeId, setScopeId] = useState("");
  const id = scopeId || (kind === "DEPARTMENT" ? deps[0]?.id : office?.agents[0]?.id) || "";
  const { data, reload } = useLoad<{ instructions: Instruction[] }>(id ? `/api/instructions?scope=${kind}&scopeId=${id}` : null);
  return (
    <>
      <p className="hint">Ustuvorlik: kompaniya qoidalari → bo'lim → agent. Pastki darajadagi ko'rsatma faqat aniqlashtiradi, xavfsizlik qoidalarini bekor qila olmaydi.</p>
      <div className="nt-row">
        <select value={kind} onChange={(e) => (setKind(e.target.value as "DEPARTMENT" | "AGENT"), setScopeId(""))}>
          <option value="DEPARTMENT">Bo'lim ko'rsatmalari</option>
          <option value="AGENT">Agent ko'rsatmalari</option>
        </select>
        <select value={id} onChange={(e) => setScopeId(e.target.value)}>
          {kind === "DEPARTMENT"
            ? deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)
            : office?.agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role} ({office.departments[a.departmentId]?.short})</option>)}
        </select>
      </div>
      {(data?.instructions ?? []).map((i) => (
        <InstructionEditor key={i.id} scope={kind} scopeId={id} title={i.title} current={i} onSaved={reload} />
      ))}
      {data && !data.instructions.length && <p className="hint">Hali ko'rsatma yo'q.</p>}
      {id && <NewInstruction scope={kind} scopeId={id} onSaved={reload} />}
    </>
  );
}

// ---------------------------------------------------------------- knowledge base
interface Doc { id: string; title: string; filename: string | null; sizeBytes: number | null; departmentId: string | null; status: string; error: string | null; version: number; chunks: number; textChars: number; updatedAt: string }
interface KStatus { documents: number; chunks: number; semantic: { available: boolean; reason: string } }

function KnowledgeTab() {
  const { office, can } = useOffice();
  const { data, reload } = useLoad<{ status: KStatus; documents: Doc[] }>("/api/knowledge");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [dep, setDep] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [qDep, setQDep] = useState("");
  const [hits, setHits] = useState<{ chunkId: string; title: string; content: string }[] | null>(null);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    if (title.trim()) fd.set("title", title.trim());
    if (dep) fd.set("departmentId", dep);
    fd.set("file", file);
    try {
      const res = await fetch("/api/knowledge", { method: "POST", body: fd, credentials: "same-origin" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setMsg({ ok: true, text: body.document.duplicate ? "Bu fayl allaqachon bor (o'zgarmagan)." : `Indekslandi: ${body.document.chunks} bo'lak, v${body.document.version}.` });
      setFile(null);
      setTitle("");
      reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const search = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api.get<{ hits: { chunkId: string; title: string; content: string }[] }>(
      `/api/knowledge/search?q=${encodeURIComponent(q)}${qDep ? `&departmentId=${qDep}` : ""}`,
    );
    setHits(r.hits);
  };
  const deps = Object.values(office?.departments ?? {});
  return (
    <>
      {data && (
        <div className="notice">
          {data.status.documents} hujjat · {data.status.chunks} bo'lak indekslangan · qidiruv: matnli (BM25).
          {" "}Semantik qidiruv: <b>mavjud emas</b> — {data.status.semantic.reason}.
        </div>
      )}
      {can("brain:manage") && (
        <form className="ins-card new" onSubmit={upload}>
          <b>Hujjat yuklash</b>
          <input type="file" accept=".pdf,.docx,.xlsx,.csv,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="nt-row">
            <input placeholder="Nomi (ixtiyoriy; bir xil nom → yangi versiya)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            <select value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">Butun kompaniya uchun</option>
              {deps.map((d) => <option key={d.id} value={d.id}>Faqat: {d.name}</option>)}
            </select>
          </div>
          <div className="row-end">
            <Msg m={msg} />
            <button className="primary small" disabled={!file || busy}>{busy ? "Yuklanmoqda…" : "Yuklash"}</button>
          </div>
          <p className="hint">PDF, DOCX, XLSX, CSV, TXT, Markdown · 15 MB gacha. Hujjat matni agentlar uchun <b>ma'lumot</b>; undagi buyruqlar bajarilmaydi.</p>
        </form>
      )}
      <table className="runs">
        <thead><tr><th>Hujjat</th><th>Kim uchun</th><th>Versiya</th><th>Bo'lak</th><th /></tr></thead>
        <tbody>
          {(data?.documents ?? []).map((d) => (
            <tr key={d.id}>
              <td><b>{d.title}</b><div className="muted">{d.filename} · {Math.round((d.sizeBytes ?? 0) / 1024)} KB</div></td>
              <td>{d.departmentId ? office?.departments[d.departmentId]?.name : "Butun kompaniya"}</td>
              <td>v{d.version}</td>
              <td>{d.chunks}</td>
              <td>{can("brain:manage") && <button className="link danger" onClick={() => window.confirm(`"${d.title}" qidiruvdan olib tashlansinmi? (tarix saqlanadi)`) && void api.del(`/api/knowledge/${d.id}`).then(reload)}>O'chirish</button>}</td>
            </tr>
          ))}
          {data && !data.documents.length && <tr><td colSpan={5} className="muted">Hali hujjat yo'q.</td></tr>}
        </tbody>
      </table>
      <form className="ins-card new" onSubmit={search}>
        <b>Qidiruvni sinash</b>
        <div className="nt-row">
          <input placeholder="Masalan: qaytarish siyosati" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={qDep} onChange={(e) => setQDep(e.target.value)}>
            <option value="">Hamma hujjatlar (admin)</option>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.name} agenti ko'radigan</option>)}
          </select>
        </div>
        <div className="row-end"><button className="primary small" disabled={q.trim().length < 2}>Qidirish</button></div>
        {hits && (hits.length ? hits.map((h) => (
          <div key={h.chunkId} className="deliverable"><div className="muted">{h.title}</div>{h.content.slice(0, 500)}</div>
        )) : <p className="hint">Hech narsa topilmadi.</p>)}
      </form>
    </>
  );
}

// ---------------------------------------------------------------- company memory
interface Mem { id: string; kind: string; content: string; status: string; departmentId: string | null; createdAt: string; taskId: string | null }

function MemoryTab() {
  const { office, can } = useOffice();
  const pending = useLoad<{ memory: Mem[] }>("/api/memory?status=PENDING");
  const approved = useLoad<{ memory: Mem[] }>("/api/memory?status=APPROVED");
  const [kind, setKind] = useState("rule");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const decide = (id: string, decision: string) =>
    void run(() => api.post(`/api/memory/${id}/decide`, { decision }), setMsg, decision === "APPROVED" ? "Xotiraga qo'shildi." : "Rad etildi.").then(() => {
      pending.reload();
      approved.reload();
    });
  const K: Record<string, string> = { decision: "Qaror", correction: "Tuzatish", lesson: "Saboq", rule: "Qoida", result: "Natija" };
  return (
    <>
      <p className="hint">Agentlar taklif qilgan narsa avtomatik "haqiqat" bo'lmaydi: faqat tasdiqlangan yozuvlar agentlarga kontekst sifatida beriladi.</p>
      <Msg m={msg} />
      <h3>Ko'rib chiqish kutmoqda ({pending.data?.memory.length ?? 0})</h3>
      <ul className="mem-list">
        {(pending.data?.memory ?? []).map((m) => (
          <li key={m.id}>
            <span className="badge">{K[m.kind] ?? m.kind}</span>
            <span className="mem-text">{m.content}</span>
            {can("brain:manage") && (
              <span className="mem-actions">
                <button onClick={() => decide(m.id, "APPROVED")}>Tasdiqlash</button>
                <button onClick={() => decide(m.id, "REJECTED")}>Rad etish</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <h3>Tasdiqlangan xotira</h3>
      <ul className="mem-list">
        {(approved.data?.memory ?? []).map((m) => (
          <li key={m.id}><span className="badge">{K[m.kind] ?? m.kind}</span><span className="mem-text">{m.content}</span><span className="muted">{m.departmentId ? office?.departments[m.departmentId]?.short : "Kompaniya"}</span></li>
        ))}
      </ul>
      {can("brain:manage") && (
        <form className="ins-card new" onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.post("/api/memory", { kind, content: content.trim() }), setMsg, "Qo'shildi.").then((ok) => ok && (setContent(""), approved.reload()));
        }}>
          <b>Qo'lda qo'shish</b>
          <div className="nt-row">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(K).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span />
          </div>
          <textarea rows={2} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Masalan: Hisobotlarda summalar so'mda, ming ajratgich bilan." />
          <div className="row-end"><button className="primary small" disabled={content.trim().length < 3}>Qo'shish</button></div>
        </form>
      )}
    </>
  );
}

// ---------------------------------------------------------------- approvals
interface Approval { id: string; taskId: string | null; agentId: string | null; action: string; requestedAt: string; taskTitle: string | null }

export function ApprovalsTab({ taskId, compact }: { taskId?: string; compact?: boolean }) {
  const { office, can } = useOffice();
  const { data, reload } = useLoad<{ approvals: Approval[] }>("/api/approvals?status=PENDING");
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const list = (data?.approvals ?? []).filter((a) => !taskId || a.taskId === taskId);
  const decide = (id: string, decision: "approve" | "reject") =>
    void run(() => api.post(`/api/approvals/${id}/decide`, { decision, reason: reason[id] }), setMsg, decision === "approve" ? "Tasdiqlandi." : "Qayta ishlashga qaytarildi.").then(reload);
  if (compact && !list.length) return null;
  return (
    <div className={compact ? "approval-box" : ""}>
      <Msg m={msg} />
      {!compact && !list.length && <p className="hint">Tasdiq kutayotgan narsa yo'q.</p>}
      {list.map((a) => (
        <div key={a.id} className="ins-card">
          <div className="ins-head">
            <b>{compact ? "Natija tasdiqlashni kutmoqda" : a.taskTitle}</b>
            <span className="muted">{office?.agents.find((x) => x.id === a.agentId)?.name} · {new Date(a.requestedAt).toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })}</span>
          </div>
          {can("tasks:manage") ? (
            <>
              <input placeholder="Rad etish sababi / tuzatish (rad etishda majburiy)" value={reason[a.id] ?? ""} onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} />
              <div className="row-end">
                <button className="link danger" disabled={!reason[a.id]?.trim()} onClick={() => decide(a.id, "reject")}>Qayta ishlashga qaytarish</button>
                <button className="primary small" onClick={() => decide(a.id, "approve")}>Tasdiqlash</button>
              </div>
            </>
          ) : <p className="hint">Tasdiqlash uchun "tasks:manage" ruxsati kerak.</p>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- agents (HR)
function AgentsTab() {
  const { office, can, refresh } = useOffice();
  const [dep, setDep] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ name: "", role: "", departmentId: "", instructions: "", model: "" });
  const deps = Object.values(office?.departments ?? {});
  const agents = useMemo(() => (office?.agents ?? []).filter((a) => !dep || a.departmentId === dep), [office, dep]);
  const manage = can("agents:manage");
  const control = can("agents:control");

  const act = async (a: AgentDto, action: string, body?: unknown) => {
    try {
      await api.post(`/api/agents/${a.id}/${action}`, body ?? {});
      setMsg({ ok: true, text: `${a.name}: bajarildi.` });
      void refresh();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "agent_has_open_tasks") {
        const tasks = (err.details as { tasks: { title: string }[] }).tasks;
        const target = window.prompt(
          `${a.name}da ${tasks.length} ta ochiq vazifa bor:\n${tasks.map((t) => `• ${t.title}`).join("\n")}\n\nKimga topshirilsin? Agent ID sini yozing (bo'sh qoldirsangiz — bekor qilinadi):`,
        );
        if (target === null) return;
        await act(a, action, { ...(body as object), ...(target.trim() ? { strategy: "reassign", toAgentId: target.trim() } : { strategy: "cancel" }) });
        return;
      }
      setMsg({ ok: false, text: err.message });
    }
  };

  return (
    <>
      <Msg m={msg} />
      {manage && (
        <form className="ins-card new" onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.post("/api/agents", { name: form.name.trim(), role: form.role.trim(), departmentId: form.departmentId, instructions: form.instructions.trim() || undefined, model: form.model.trim() || undefined }),
            setMsg, `${form.name} ishga olindi.`).then((ok) => ok && (setForm({ name: "", role: "", departmentId: form.departmentId, instructions: "", model: "" }), void refresh()));
        }}>
          <b>Yangi agentni ishga olish</b>
          <div className="nt-row">
            <input placeholder="Ism" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} />
            <input placeholder="Lavozim (masalan: SMM menejer)" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} maxLength={120} />
          </div>
          <div className="nt-row">
            <select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
              <option value="">Bo'lim…</option>
              {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input placeholder="Model (ixtiyoriy, standart: Gemini)" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </div>
          <textarea rows={2} placeholder="Shaxsiy ko'rsatma (ixtiyoriy)" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
          <div className="row-end"><button className="primary small" disabled={!form.name.trim() || !form.role.trim() || !form.departmentId}>Ishga olish</button></div>
        </form>
      )}
      <div className="nt-row">
        <select value={dep} onChange={(e) => setDep(e.target.value)}>
          <option value="">Barcha bo'limlar</option>
          {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <span className="muted">{agents.length} agent</span>
      </div>
      <table className="runs">
        <thead><tr><th>Agent</th><th>Bo'lim</th><th>Holat</th><th>ID</th><th /></tr></thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td><b>{a.name}</b><div className="muted">{a.role}</div></td>
              <td>{office?.departments[a.departmentId]?.short}</td>
              <td>{a.lifecycle === "PAUSED" ? "Paused" : a.status}{a.openTasks ? ` · ${a.openTasks} vazifa` : ""}</td>
              <td className="muted mono">{a.id}</td>
              <td className="agent-actions">
                {control && (a.lifecycle === "PAUSED"
                  ? <button onClick={() => void act(a, "resume")}>Resume</button>
                  : <button onClick={() => void act(a, "pause")}>Pause</button>)}
                {manage && (
                  <select value="" onChange={(e) => e.target.value && void act(a, "transfer", { departmentId: e.target.value })} aria-label="Ko'chirish">
                    <option value="">Ko'chirish…</option>
                    {deps.filter((d) => d.id !== a.departmentId).map((d) => <option key={d.id} value={d.id}>{d.short}</option>)}
                  </select>
                )}
                {manage && <button className="danger" onClick={() => window.confirm(`${a.name} arxivlansinmi? Tarix saqlanadi.`) && void act(a, "archive")}>Arxiv</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------- connectors + Telegram
interface TgInfo {
  status: { configured: boolean; running?: boolean; reason?: string; bot?: { username: string; name: string } | null; group?: { id: string; title: string | null; memberStatus: string | null; canSend: boolean } | null; lastPollAt?: string | null; lastError?: string | null; tokenMasked?: string };
  settings: { adminUserIds: number[]; allowedUserIds: number[]; notify: "linked" | "all"; verbosity: "minimal" | "normal" } | null;
  recent: { updateId: number; userId: number; username: string | null; command: string | null; outcome: string | null; taskId: string | null; receivedAt: string }[];
}

function ConnectorsTab() {
  const { office, can, refresh } = useOffice();
  const tg = useLoad<TgInfo>("/api/telegram");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const deps = Object.values(office?.departments ?? {});
  const toggle = (c: ConnectorDto, dep: string) => {
    const next = c.departments.includes(dep) ? c.departments.filter((x) => x !== dep) : [...c.departments, dep];
    void run(() => api.put(`/api/connectors/${c.id}/departments`, { departmentIds: next }), setMsg, `${c.name}: ruxsatlar yangilandi.`).then(() => refresh());
  };
  return (
    <>
      <Msg m={msg} />
      <TelegramCard info={tg.data} onChange={tg.reload} />
      <h3>Connectorlar va bo'lim ruxsatlari</h3>
      <p className="hint">Faqat haqiqatan ulangan va tekshirilgan connector "ulangan" deb ko'rsatiladi. Hozircha Telegram amalga oshirilgan; qolganlari keyingi bosqichlarda.</p>
      <div className="md-table">
        <table className="runs conn-matrix">
          <thead><tr><th>Connector</th><th>Holat</th>{deps.map((d) => <th key={d.id} title={d.name}>{d.short.slice(0, 5)}</th>)}</tr></thead>
          <tbody>
            {(office?.connectors ?? []).map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b></td>
                <td><span className={`status-dot ${c.status}`} />{c.status === "connected" ? "ulangan" : c.status === "error" ? "xato" : "ulanmagan"}{c.lastError ? <div className="muted err" title={c.lastError}>{c.lastError.slice(0, 50)}</div> : null}</td>
                {deps.map((d) => (
                  <td key={d.id}>
                    <input type="checkbox" checked={c.departments.includes(d.id)} disabled={!can("brain:manage")} onChange={() => toggle(c, d.id)} aria-label={`${c.name} — ${d.name}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TelegramCard({ info, onChange }: { info: TgInfo | null; onChange: () => void }) {
  const { can } = useOffice();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [admins, setAdmins] = useState("");
  const [allowed, setAllowed] = useState("");
  const [notify, setNotify] = useState<"linked" | "all">("linked");
  const [verbosity, setVerbosity] = useState<"minimal" | "normal">("normal");
  useEffect(() => {
    if (!info?.settings) return;
    setAdmins(info.settings.adminUserIds.join(", "));
    setAllowed(info.settings.allowedUserIds.join(", "));
    setNotify(info.settings.notify);
    setVerbosity(info.settings.verbosity);
  }, [info?.settings]);
  if (!info) return null;
  const s = info.status;
  const ids = (t: string) => t.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const ok = s.configured && !s.lastError;
  let body: ReactNode;
  if (!s.configured) body = <p className="hint">{s.reason}</p>;
  else
    body = (
      <>
        <dl className="kv">
          <dt>Bot</dt><dd>{s.bot ? `@${s.bot.username} (${s.bot.name})` : "—"} <span className="muted mono">token: {s.tokenMasked}</span></dd>
          <dt>Guruh</dt><dd>{s.group?.title ?? s.group?.id ?? "—"} {s.group && <span className="muted">· bot holati: {s.group.memberStatus ?? "?"}{s.group.canSend ? "" : " · yozolmaydi"}</span>}</dd>
          <dt>Oxirgi so'rov</dt><dd>{s.lastPollAt ? new Date(s.lastPollAt).toLocaleTimeString("uz-UZ", { timeZone: "Asia/Tashkent" }) : "—"}</dd>
          {s.lastError && <><dt>Xato</dt><dd className="err">{s.lastError}</dd></>}
        </dl>
        {can("brain:manage") && (
          <form onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.put("/api/telegram/settings", { adminUserIds: ids(admins), allowedUserIds: ids(allowed), notify, verbosity }), setMsg, "Saqlandi.").then(onChange);
          }}>
            <div className="nt-row">
              <label className="field">Adminlar (Telegram user ID)<input value={admins} onChange={(e) => setAdmins(e.target.value)} placeholder="123456789, 987654321" /></label>
              <label className="field">/task bera oladiganlar<input value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="ID lar, vergul bilan" /></label>
            </div>
            <div className="nt-row">
              <label className="field">Xabarlar
                <select value={notify} onChange={(e) => setNotify(e.target.value as "linked" | "all")}>
                  <option value="linked">Faqat Telegramdan berilgan vazifalar</option>
                  <option value="all">Barcha asosiy vazifalar</option>
                </select>
              </label>
              <label className="field">Batafsillik
                <select value={verbosity} onChange={(e) => setVerbosity(e.target.value as "minimal" | "normal")}>
                  <option value="normal">Oddiy (boshlanish, bo'limlar natijasi)</option>
                  <option value="minimal">Minimal (faqat yakun, xato, tasdiq)</option>
                </select>
              </label>
            </div>
            <div className="row-end">
              <Msg m={msg} />
              <button type="button" className="link" onClick={() => void run(() => api.post("/api/telegram/verify"), setMsg, "Tekshirildi.").then(onChange)}>Qayta tekshirish</button>
              <button className="primary small">Saqlash</button>
            </div>
            <p className="hint">Telegram user ID ni bilish uchun guruhda <code>/status x</code> yozing — u quyidagi jurnalda ko'rinadi (yoki @userinfobot dan foydalaning).</p>
          </form>
        )}
        {info.recent.length > 0 && (
          <table className="runs">
            <thead><tr><th>Vaqt</th><th>Foydalanuvchi</th><th>Buyruq</th><th>Natija</th></tr></thead>
            <tbody>
              {info.recent.map((r) => (
                <tr key={r.updateId}><td>{r.receivedAt.slice(11, 19)}</td><td>{r.username ?? "—"} <span className="muted mono">{r.userId}</span></td><td>{r.command ?? "—"}</td><td>{r.outcome}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  return (
    <div className="ins-card">
      <div className="ins-head">
        <b>Telegram guruh</b>
        <span className={`ai-chip ${ok ? "on" : s.configured ? "err" : "off"}`}>{ok ? "ulangan" : s.configured ? "xato" : "sozlanmagan"}</span>
      </div>
      {body}
    </div>
  );
}

