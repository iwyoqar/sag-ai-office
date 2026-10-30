// Bulk import of HQ employees from Excel: upload → per-row check (nothing written) → import → one-time activation
// codes to hand out (shown once; downloadable as CSV). Server: POST /api/employees/import.
import { useState } from "react";
import { Msg, type Note } from "./common";

interface Row {
  row: number; displayName: string; jobTitle: string; departmentName: string | null; username: string; email: string | null;
  managerUsername: string | null; errors: string[]; warnings: string[];
}
interface Result {
  sheetName: string; rows: Row[]; valid: boolean; applied: boolean;
  created: { row: number; displayName: string; username: string; activationToken: string; expiresAt: string }[];
}

async function upload(file: File, apply: boolean): Promise<Result> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`/api/employees/import${apply ? "?apply=1" : ""}`, { method: "POST", body: fd, credentials: "same-origin" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message ?? `Xato ${r.status}`);
  return body as Result;
}

/** The activation codes as a CSV file the admin saves and hands out (one code per person, valid 7 days). */
function downloadCodes(created: Result["created"]) {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const csv = ["Ism;Login;Faollashtirish kodi;Amal qiladi", ...created.map((c) => [c.displayName, c.username, c.activationToken, c.expiresAt.slice(0, 10)].map(q).join(";"))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "xodimlar-faollashtirish-kodlari.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

export function EmployeeImport() {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Note>(null);
  const go = async (apply: boolean) => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await upload(file, apply);
      setRes(r);
      if (r.applied) setMsg({ ok: true, text: `${r.created.length} xodim qo'shildi. Kodlarni hozir saqlang: ular qayta ko'rsatilmaydi.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const bad = res?.rows.filter((r) => r.errors.length).length ?? 0;
  return (
    <section className="ins-card emp-import">
      <b>Excel'dan xodimlar importi</b>
      <p className="hint">
        Birinchi varaqdagi sarlavha qatori bo'yicha o'qiladi: <code>Ism</code> (yoki F.I.Sh / ФИО) majburiy; <code>Lavozim</code>, <code>Bo'lim</code>,
        {" "}<code>Login</code>, <code>Email</code>, <code>Rahbar</code> (rahbarning logini) ixtiyoriy. Login berilmasa ismdan lotincha yasaladi. Avval tekshiriladi,
        hech narsa yozilmaydi; xato bo'lsa hech kim qo'shilmaydi. Har bir xodim bir martalik faollashtirish kodi oladi (7 kun) va kirish sahifasida
        “Taklif kodi bilan faollashtirish” orqali parolini o'rnatadi; o'shanda bo'limidagi stolini oladi.
      </p>
      <div className="row-end">
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); setMsg(null); }} />
        <button className="small" disabled={!file || busy} onClick={() => void go(false)}>Tekshirish</button>
        <button className="primary small" disabled={!file || busy || !res?.valid || res.applied} onClick={() => void go(true)}>
          {res ? `${res.rows.length} xodimni import qilish` : "Import qilish"}
        </button>
      </div>
      <Msg m={msg} />
      {res && !res.applied && (
        <>
          <p className={bad ? "err" : "hint"}>
            “{res.sheetName}” varag'i: {res.rows.length} qator{bad ? `, ${bad} tasida xato — tuzatib qayta yuklang` : ", hammasi to'g'ri"}.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Qator</th><th>Ism</th><th>Lavozim</th><th>Bo'lim</th><th>Login</th><th>Email</th><th>Rahbar</th><th>Holat</th></tr></thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.row} className={r.errors.length ? "bad" : ""}>
                    <td>{r.row}</td><td>{r.displayName}</td><td>{r.jobTitle}</td><td>{r.departmentName ?? "—"}</td><td><code>{r.username}</code></td>
                    <td>{r.email ?? ""}</td><td>{r.managerUsername ?? ""}</td>
                    <td>{r.errors.length ? <span className="err">{r.errors.join("; ")}</span> : r.warnings.length ? <span className="muted">{r.warnings.join("; ")}</span> : "✓"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {res?.applied && (
        <>
          <div className="row-end"><button className="primary small" onClick={() => downloadCodes(res.created)}>Kodlarni CSV qilib yuklab olish</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Ism</th><th>Login</th><th>Faollashtirish kodi</th><th>Amal qiladi</th></tr></thead>
              <tbody>
                {res.created.map((c) => (
                  <tr key={c.username}><td>{c.displayName}</td><td><code>{c.username}</code></td><td><code className="code">{c.activationToken}</code></td><td>{c.expiresAt.slice(0, 10)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
