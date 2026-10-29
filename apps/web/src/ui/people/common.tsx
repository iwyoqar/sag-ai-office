// Shared bits of the people & work UI. The server decides permissions; these only mirror them.
import { useEffect, useState } from "react";
import type { EmployeeCardDto, WorkloadDto } from "@sag/shared";
import { api, ApiError } from "../../api/client";
import { useOffice } from "../../api/office";
import { WORKLOAD_META } from "../../config/status";

export type Note = { ok: boolean; text: string } | null;

/** GET with refetch on every realtime tick (people events carry no content, so views refetch). */
export function useLoad<T>(url: string | null) {
  const { tick } = useOffice();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setLoading(true);
    api.get<T>(url)
      .then((r) => alive && (setData(r), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [url, n, tick]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

/** Runs an action, turning server errors (incl. field validation) into a readable message. */
export async function run(fn: () => Promise<unknown>, set: (m: Note) => void, okText: string): Promise<boolean> {
  try {
    await fn();
    set({ ok: true, text: okText });
    return true;
  } catch (e) {
    set({ ok: false, text: errorText(e) });
    return false;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "validation" && Array.isArray(e.details)) {
      const issues = (e.details as { path?: (string | number)[]; message: string }[]).map((i) => `${i.path?.join(".") || "maydon"}: ${i.message}`);
      return `Ma'lumot noto'g'ri — ${issues.join("; ")}`;
    }
    if (e.status === 403) return e.message || "Bu amal uchun ruxsat yo'q";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function Msg({ m }: { m: Note }) {
  return m ? <div className={m.ok ? "notice ok" : "notice warn"} role={m.ok ? "status" : "alert"}>{m.text}</div> : null;
}

export function Loading({ what = "Yuklanmoqda" }: { what?: string }) {
  return <div className="muted pad">{what}…</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function Avatar({ p, size = 32 }: { p: Pick<EmployeeCardDto, "id" | "displayName" | "hasAvatar">; size?: number }) {
  const [broken, setBroken] = useState(false);
  const hue = [...p.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return p.hasAvatar && !broken ? (
    <img className="avatar" src={`/api/employees/${p.id}/avatar`} alt="" width={size} height={size} onError={() => setBroken(true)} />
  ) : (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 45% 88%)`, color: `hsl(${hue} 45% 28%)` }} aria-hidden>
      {initials(p.displayName)}
    </span>
  );
}

/** Coloured workload chip; click shows the explanation. Operational indicator, not a judgement of the person. */
export function WorkloadBadge({ w, compact }: { w: WorkloadDto; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const m = WORKLOAD_META[w.level];
  return (
    <span className="wl-wrap">
      <button type="button" className={`wl wl-${w.level}`} style={{ ["--c" as string]: m.color }} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={w.summary} aria-expanded={open}>
        <i />{compact ? (w.level === "RED" ? "OVERLOADED" : `${w.percent}%`) : `${m.label} · ${w.percent}%`}
      </button>
      {open && (
        <span className="wl-pop" role="dialog" onClick={(e) => e.stopPropagation()}>
          <b style={{ color: m.color }}>{w.summary}</b>
          <ul>{w.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <span className="muted">
            {w.activeTasks} faol vazifa · {w.demandHours} / {w.capacityHours} soat{w.confidence === "low" ? " · aniqlik past (baho yo'q)" : ""}
          </span>
        </span>
      )}
    </span>
  );
}

export const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator", director: "Direktor", department_head: "Bo'lim rahbari", employee: "Xodim",
  hr: "HR", member: "A'zo (eski)", viewer: "Kuzatuvchi",
};

export const PERMISSION_LABEL: Record<string, string> = {
  "employees:manage_dept": "Bo'lim xodimlarini boshqarish",
  "tasks:assign_dept": "Bo'limga vazifa berish",
  "tasks:read_team": "Jamoa vazifalarini ko'rish",
  "tasks:read_all": "Barcha vazifalarni ko'rish",
  "tasks:assign_any": "Istalgan xodimga vazifa berish",
  "employees:read_all": "Barcha xodimlarni ko'rish",
  "workload:configure": "Yuklama sozlamalari",
  "permissions:delegate": "Ruxsat berish",
  "employees:manage_all": "Barcha xodimlarni boshqarish",
  "users:manage": "Foydalanuvchilar (admin)",
};

/** DD.MM.YYYY[, HH:MM] in Tashkent time (the uz-UZ locale renders months as "M11" in most browsers). */
export const fmtDate = (s: string | null | undefined, withTime = false) => {
  if (!s) return "—";
  const d = new Date(new Date(s).getTime() + 5 * 3600e3).toISOString();
  const date = `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  return withTime ? `${date}, ${d.slice(11, 16)}` : date;
};

/** datetime-local value (Tashkent wall time) ⇄ ISO. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 5 * 3600e3);
  return d.toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(`${v}:00+05:00`).toISOString() : null);
