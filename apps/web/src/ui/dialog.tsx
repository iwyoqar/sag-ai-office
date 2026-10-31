// In-app confirm / prompt. The browser's own window.confirm / window.prompt are not reliable: embedded browsers
// (the desktop app's preview pane, some webviews, iOS standalone mode) suppress them and they return false / null at
// once without showing anything, so a guarded action silently never runs. These open the app's own modal instead
// and resolve a promise; usable from any handler without a provider.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface DialogOptions {
  title?: string;
  /** label of the confirming button (default "Ha" / "OK") */
  confirmLabel?: string;
  danger?: boolean;
}
interface PromptOptions extends DialogOptions {
  placeholder?: string;
  initial?: string;
  /** the confirm button stays disabled until the text has at least this many characters */
  minLength?: number;
  type?: "text" | "password";
  multiline?: boolean;
}

function open<T>(render: (done: (v: T) => void) => JSX.Element): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: T) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(render(done));
  });
}

function Frame({ title, message, onCancel, children }: { title?: string; message: string; onCancel: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCancel]);
  return (
    <div className="modal-backdrop dialog-backdrop" onClick={onCancel}>
      <div className="modal dialog" role="alertdialog" aria-modal="true" aria-label={title ?? "Tasdiqlash"} onClick={(e) => e.stopPropagation()}>
        {title && <div className="modal-head"><h2>{title}</h2></div>}
        <div className="modal-body">
          <p className="dialog-message">{message}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Ask the user to confirm; resolves true only when they press the confirm button. */
export function confirmDialog(message: string, o: DialogOptions = {}): Promise<boolean> {
  return open<boolean>((done) => (
    <Frame title={o.title} message={message} onCancel={() => done(false)}>
      <div className="row-end dialog-actions">
        <button className="link" onClick={() => done(false)}>Bekor qilish</button>
        <button className={o.danger ? "danger" : "primary small"} autoFocus onClick={() => done(true)}>{o.confirmLabel ?? "Ha"}</button>
      </div>
    </Frame>
  ));
}

function PromptBody({ o, done }: { o: PromptOptions; done: (v: string | null) => void }) {
  const [v, setV] = useState(o.initial ?? "");
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const ok = v.trim().length >= (o.minLength ?? 1);
  const submit = () => { if (ok) done(v); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {o.multiline
        ? <textarea ref={ref} rows={4} value={v} placeholder={o.placeholder} onChange={(e) => setV(e.target.value)} />
        : <input ref={ref} type={o.type ?? "text"} value={v} placeholder={o.placeholder} onChange={(e) => setV(e.target.value)} autoComplete={o.type === "password" ? "new-password" : "off"} />}
      <div className="row-end dialog-actions">
        <button type="button" className="link" onClick={() => done(null)}>Bekor qilish</button>
        <button type="submit" className={o.danger ? "danger" : "primary small"} disabled={!ok}>{o.confirmLabel ?? "OK"}</button>
      </div>
    </form>
  );
}

/** Ask the user for text; resolves the text, or null when they cancel. */
export function promptDialog(message: string, o: PromptOptions = {}): Promise<string | null> {
  return open<string | null>((done) => (
    <Frame title={o.title} message={message} onCancel={() => done(null)}>
      <PromptBody o={o} done={done} />
    </Frame>
  ));
}
