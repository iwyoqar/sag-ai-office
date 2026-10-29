import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useOffice } from "../api/office";

/** Own account: who am I, which roles, change password. */
export function AccountDialog({ onClose }: { onClose: () => void }) {
  const { user } = useOffice();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setMsg({ ok: false, text: "Yangi parollar bir xil emas" });
    setBusy(true);
    try {
      await api.post("/api/auth/password", { current, next });
      setMsg({ ok: true, text: "Parol o'zgardi. Boshqa qurilmalardagi sessiyalar tugatildi." });
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal account" role="dialog" aria-label="Hisob" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="muted">{user?.username} · {user?.roles.join(", ")}</div>
            <h2>{user?.displayName}</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Yopish">×</button>
        </div>
        <form className="modal-body" onSubmit={submit}>
          <h3>Parolni o'zgartirish</h3>
          <input type="password" placeholder="Joriy parol" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          <input type="password" placeholder="Yangi parol (kamida 10 belgi)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          <input type="password" placeholder="Yangi parolni takrorlang" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
          {msg && <div className={msg.ok ? "notice ok" : "notice warn"}>{msg.text}</div>}
          <div className="row-end"><button className="primary small" disabled={busy || next.length < 10}>Saqlash</button></div>
        </form>
      </div>
    </div>
  );
}
