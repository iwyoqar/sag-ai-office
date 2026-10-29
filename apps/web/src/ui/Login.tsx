import { useState, type FormEvent } from "react";
import { useOffice } from "../api/office";

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
      </form>
    </div>
  );
}
