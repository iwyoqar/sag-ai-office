export function Loader({ progress, error, onSkip }: { progress: number; error: string | null; onSkip: () => void }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="loader" aria-live="polite">
      <div className="loader-box">
        <div className="loader-title">SAG AI OFFICE</div>
        {error ? (
          <div className="loader-error">3D model yuklanmadi: {error}. Sahifani yangilang.</div>
        ) : (
          <>
            <div className="loader-bar"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>
            <div className="loader-text">{pct < 100 ? `Bino yuklanmoqda… ${pct}%` : "Binoga yaqinlashmoqda"}</div>
          </>
        )}
      </div>
      {pct >= 100 && (
        <button className="skip" onClick={onSkip}>O'tkazib yuborish →</button>
      )}
    </div>
  );
}
