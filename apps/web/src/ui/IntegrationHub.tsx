// Integration Hub: connector catalog (what exists in code), connected instances by scope (unit / region / group),
// credential status, health and the connector audit trail. Only actions the server allows this user, and that
// actually work, are shown; secrets are typed once and never displayed again (the server returns a fingerprint).
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";

interface Definition {
  id: string; name: string; provider: string; category: string; version: string; status: "AVAILABLE" | "PLANNED" | "DISCOVERY";
  authMethods: string[]; implementedAuth: string[]; storableAuth: string[]; scopes: string[]; actions: { tool: string; kind: "read" | "write" }[];
  healthCheck: boolean; notes: string | null;
}
interface Credential { id: string; method: string; status: string; fingerprint: string; expiresAt: string | null; lastUsedAt: string | null; createdAt: string }
interface Instance {
  id: string; scopeLevel: "UNIT" | "REGION" | "GROUP"; scopeNodeId: string; scopeName: string; unitId: string | null; connectorId: string; name: string;
  enabled: boolean; status: string; healthStatus: string; consecutiveFailures: number; lastHealthAt: string | null; lastError: string | null;
  lastErrorClass: string | null; credentialScope: string; definitionStatus: string; credentials: Credential[]; assignedUnits: string[];
  can: { manageCredentials: boolean; checkHealth: boolean; assign: boolean };
}
interface AuditItem { id: number; action: string; instanceId: string; at: string; details: Record<string, unknown> }
interface Network { group: { id: string; name: string }; regions: { id: string; name: string; units: { id: string; name: string; businessType: string; isHeadOffice: boolean }[] }[] }

const DEF_STATUS: Record<Definition["status"], [string, string]> = {
  AVAILABLE: ["Ishlaydi", "ok"], PLANNED: ["Rejada", "warn"], DISCOVERY: ["Aniqlanmoqda", "warn"],
};
const HEALTH: Record<string, string> = { HEALTHY: "Sog'lom", DEGRADED: "Muammoli", DOWN: "Ishlamayapti", UNKNOWN: "Tekshirilmagan" };
const CRED_SCOPE: Record<string, string> = { NONE: "kalit kerak emas", SERVER_ENV: "server muhitida", SECRET_STORE: "shifrlangan omborda" };
const SCOPE: Record<Instance["scopeLevel"], string> = { UNIT: "Bo'lim", REGION: "Region", GROUP: "Guruh" };

const err = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function IntegrationHub({ isAdmin }: { isAdmin: boolean }) {
  const [catalog, setCatalog] = useState<Definition[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [net, setNet] = useState<Network | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);

  useEffect(() => {
    api.get<{ connectors: Definition[] }>("/api/integrations/catalog").then((r) => setCatalog(r.connectors)).catch((e) => setMsg({ ok: false, text: err(e) }));
    api.get<{ instances: Instance[] }>("/api/integrations/instances").then((r) => setInstances(r.instances)).catch((e) => setMsg({ ok: false, text: err(e) }));
    api.get<{ items: AuditItem[] }>("/api/integrations/audit").then((r) => setAudit(r.items)).catch(() => setAudit([]));
    if (isAdmin) api.get<{ network: Network }>("/api/units").then((r) => setNet(r.network)).catch(() => setNet(null));
  }, [n, isAdmin]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: err(e) });
    }
    reload();
  };
  const defOf = (id: string) => catalog.find((d) => d.id === id);
  const unitName = (id: string) => net?.regions.flatMap((r) => r.units).find((u) => u.id === id)?.name ?? id;

  return (
    <div className="integration-hub">
      {msg && <div className={msg.ok ? "notice ok" : "notice warn"}>{msg.text}</div>}

      <h3>Ulangan instance'lar</h3>
      <p className="hint">Har bir instance bitta egaga tegishli: bo'lim, region yoki butun guruh. Region/guruh instance'i faqat aniq tayinlangan SAG filiallariga ishlaydi; franshiza connectorlari va kalitlari faqat o'zida. Kalitlar serverda shifrlangan holda saqlanadi va hech qachon ko'rsatilmaydi.</p>
      {!instances.length ? <p className="hint">Ko'rinadigan instance yo'q.</p> : (
        <table className="runs">
          <thead><tr><th>Connector</th><th>Egasi</th><th>Holat</th><th>Kalit</th><th>Tayinlangan</th><th /></tr></thead>
          <tbody>
            {instances.map((i) => (
              <InstanceRow key={i.id} i={i} def={defOf(i.connectorId)} unitName={unitName} net={net} act={act} />
            ))}
          </tbody>
        </table>
      )}

      {isAdmin && net && <SharedInstanceForm catalog={catalog} net={net} act={act} />}

      <h3>Connectorlar katalogi</h3>
      <p className="hint">Katalog — kodda nima borligi. "Ishlaydi" connector ulangan degani emas: ulanish holati yuqoridagi instance'larda.</p>
      <table className="runs">
        <thead><tr><th>Connector</th><th>Toifa</th><th>Kod holati</th><th>Autentifikatsiya</th><th>Amallar</th></tr></thead>
        <tbody>
          {catalog.map((d) => (
            <tr key={d.id}>
              <td><b>{d.name}</b><div className="muted">{d.provider} · v{d.version}</div>{d.notes && <div className="hint">{d.notes}</div>}</td>
              <td>{d.category}</td>
              <td><span className={`badge ${DEF_STATUS[d.status][1] === "warn" ? "warn" : ""}`}>{DEF_STATUS[d.status][0]}</span></td>
              <td>{d.implementedAuth.length ? d.implementedAuth.join(", ") : "—"}{d.authMethods.some((m) => !d.implementedAuth.includes(m)) && <div className="muted">provayderda: {d.authMethods.join(", ")}</div>}</td>
              <td>{d.actions.length ? d.actions.map((a) => `${a.tool}${a.kind === "write" ? " (tasdiq bilan)" : ""}`).join(", ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Audit</h3>
      {!audit.length ? <p className="hint">Hali yozuv yo'q.</p> : (
        <table className="runs">
          <thead><tr><th>Vaqt</th><th>Amal</th><th>Instance</th><th>Tafsilot</th></tr></thead>
          <tbody>
            {audit.slice(0, 40).map((a) => (
              <tr key={a.id}>
                <td>{a.at.slice(0, 16).replace("T", " ")}</td><td>{a.action}</td>
                <td>{instances.find((i) => i.id === a.instanceId)?.name ?? a.instanceId}</td>
                <td className="muted">{Object.entries(a.details).filter(([k]) => k !== "unitId").map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InstanceRow({ i, def, unitName, net, act }: {
  i: Instance; def: Definition | undefined; unitName: (id: string) => string; net: Network | null;
  act: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [open, setOpen] = useState(false);
  const active = i.credentials.find((c) => c.status === "ACTIVE");
  const storable = def?.storableAuth ?? [];
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.put(`/api/integrations/instances/${i.id}/credentials`, { method: storable[0], secret }), `${i.name}: kalit saqlandi (shifrlangan).`)
      .then(() => { setSecret(""); setOpen(false); });
  };
  const candidates = (net?.regions ?? [])
    .filter((r) => i.scopeLevel === "GROUP" || r.id === i.scopeNodeId)
    .flatMap((r) => r.units)
    .filter((u) => (u.businessType === "SAG_BRANCH" || (i.scopeLevel === "GROUP" && u.isHeadOffice)) && !i.assignedUnits.includes(u.id));
  return (
    <tr>
      <td><b>{i.name}</b>{!i.enabled && <span className="badge warn">o'chirilgan</span>}{i.definitionStatus !== "AVAILABLE" && <span className="badge warn">kodda yo'q</span>}</td>
      <td>{SCOPE[i.scopeLevel]}: {i.scopeName}</td>
      <td>
        <span className={`badge ${i.healthStatus === "HEALTHY" ? "" : "warn"}`}>{HEALTH[i.healthStatus] ?? i.healthStatus}</span>
        <div className="muted">{i.status}{i.lastErrorClass ? ` · ${i.lastErrorClass}` : ""}{i.lastHealthAt ? ` · ${i.lastHealthAt.slice(0, 16).replace("T", " ")}` : ""}</div>
        {i.lastError && <div className="hint err">{i.lastError}</div>}
      </td>
      <td>
        {active ? <>{active.method} · <code>{active.fingerprint}…</code>{active.expiresAt && <div className="muted">muddati: {active.expiresAt.slice(0, 10)}</div>}</>
          : <span className="muted">{CRED_SCOPE[i.credentialScope] ?? i.credentialScope}</span>}
        {i.can.manageCredentials && storable.length > 0 && (open ? (
          <form className="inline-form" onSubmit={save}>
            <input type="password" autoComplete="off" placeholder={`${storable[0]} (faqat bir marta kiritiladi)`} value={secret} onChange={(e) => setSecret(e.target.value)} minLength={8} required />
            <button className="primary small" type="submit">Saqlash</button>
            <button className="link" type="button" onClick={() => setOpen(false)}>Bekor</button>
          </form>
        ) : <div><button className="link" onClick={() => setOpen(true)}>{active ? "Kalitni almashtirish" : "Kalit kiritish"}</button>
          {active && <button className="link danger" onClick={() => window.confirm("Kalit bekor qilinsinmi? Agentlar bu connectorni ishlata olmay qoladi.") && void act(() => api.post(`/api/integrations/instances/${i.id}/credentials/${active.id}/revoke`), "Kalit bekor qilindi.")}>Bekor qilish</button>}</div>)}
      </td>
      <td>
        {i.scopeLevel === "UNIT" ? <span className="muted">—</span> : (
          <>
            {i.assignedUnits.map((u) => (
              <div key={u}>{unitName(u)} {i.can.assign && <button className="link danger" onClick={() => void act(() => api.del(`/api/integrations/instances/${i.id}/assignments/${u}`), "Tayinlov olib tashlandi.")}>×</button>}</div>
            ))}
            {i.can.assign && candidates.length > 0 && (
              <select value="" onChange={(e) => e.target.value && void act(() => api.put(`/api/integrations/instances/${i.id}/assignments/${e.target.value}`, {}), "Bo'limga tayinlandi.")}>
                <option value="">+ SAG filialiga tayinlash</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            )}
          </>
        )}
      </td>
      <td>{i.can.checkHealth && def?.healthCheck && def.status === "AVAILABLE" && (
        <button className="link" onClick={() => void act(() => api.post<{ result: { ok: boolean; detail: string } }>(`/api/integrations/instances/${i.id}/health`)
          .then((r) => { if (!r.result.ok) throw new Error(r.result.detail); }), `${i.name}: tekshiruv o'tdi.`)}>Tekshirish</button>
      )}</td>
    </tr>
  );
}

function SharedInstanceForm({ catalog, net, act }: { catalog: Definition[]; net: Network; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const eligible = catalog.filter((d) => d.status === "AVAILABLE" && (d.id === "web-search" || d.storableAuth.length > 0));
  const [scope, setScope] = useState(net.group.id);
  const [connector, setConnector] = useState(eligible[0]?.id ?? "");
  if (!eligible.length) return null;
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(() => api.post("/api/integrations/instances", { scopeNodeId: scope, connectorId: connector }), "Umumiy instance yaratildi."); }}>
      <b>Umumiy instance:</b>
      <select value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value={net.group.id}>Guruh: {net.group.name}</option>
        {net.regions.map((r) => <option key={r.id} value={r.id}>Region: {r.name}</option>)}
      </select>
      <select value={connector} onChange={(e) => setConnector(e.target.value)}>
        {eligible.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <button className="primary small" type="submit">Yaratish</button>
    </form>
  );
}
