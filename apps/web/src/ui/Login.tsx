import { useState, type FormEvent } from "react";
import { useOffice } from "../api/office";
import { api } from "../api/client";

export function Login() {
  const { login, error: loadError } = useOffice();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit} aria-label="Tizimga kirish">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden><i /><i /><i /></span>
          <span className="brand-name">SAG <b>AI OFFICE</b></span>
        </div>
        <label>
          Login
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label>
          Parol
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {(error || loadError) && <div className="login-error" role="alert">{error ?? loadError}</div>}
        <button type="submit" disabled={busy}>{busy ? "Kirilmoqda…" : "Kirish"}</button>
        <Activate />
      </form>
    </div>
  );
}

/** First sign-in of a provisioned account: one-time code from HQ (directors) or the store director (employees). */
function Activate() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className="link-btn" onClick={() => setOpen(true)}>Taklif kodi bilan faollashtirish</button>;
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ username: string }>("/api/auth/activate", { token: code.trim(), password: pw });
      setMsg({ ok: true, text: `Hisob faollashtirildi. Endi "${r.username}" logini va yangi parol bilan kiring.` });
      setCode("");
      setPw("");
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="activate">
      <label>
        Taklif kodi
        <input id="activate-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
      </label>
      <label>
        Yangi parol (kamida 10 belgi)
        <input id="activate-password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      {msg && <div className={msg.ok ? "login-ok" : "login-error"} role="status">{msg.text}</div>}
      <button type="button" disabled={busy || code.trim().length < 20 || pw.length < 10} onClick={() => void go()}>Faollashtirish</button>
    </div>
  );
}
