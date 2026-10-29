import { BUILDINGS, HQ } from "../scene/campus/layout";
import type { CampusBuildingInfo } from "../scene/campus/CampusScene";

const LIST = [HQ, ...BUILDINGS.filter((b) => b.id !== "booth")];

/** Campus mode: list of buildings (same as clicking them in 3D). */
export function CampusBuildings({ onSelect, labels, onToggleLabels }: {
  onSelect: (id: string) => void; labels: boolean; onToggleLabels: () => void;
}) {
  return (
    <section>
      <div className="sec-head">
        <h3>Kampus binolari</h3>
        <label className="toggle">
          <input type="checkbox" checked={labels} onChange={onToggleLabels} /> Yorliqlar
        </label>
      </div>
      <ul className="building-list">
        {LIST.map((b) => (
          <li key={b.id}>
            <button onClick={() => onSelect(b.id)} className={b.id === HQ.id ? "hq" : ""}>
              <b>{b.name}</b>
              <small>{b.category}</small>
              <span className="go">{b.interaction === "office" ? "Ofisga kirish →" : "Ko'rish →"}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">Joylashuv va o'lchamlar sun'iy yo'ldosh va fotosuratlardan taxminiy olingan (docs/CAMPUS_LAYOUT.md).</p>
    </section>
  );
}

/** Building mode: compact information panel. */
export function BuildingPanel({ info, onBack, onEnterOffice }: {
  info: CampusBuildingInfo; onBack: () => void; onEnterOffice: () => void;
}) {
  return (
    <aside className="panel building-panel" aria-label={info.name}>
      <div className="panel-head">
        <button className="back" onClick={onBack}>← Kampus</button>
      </div>
      <h2 className="panel-title">{info.name}</h2>
      <dl className="kv">
        <dt>Turi</dt>
        <dd>{info.category}</dd>
        <dt>Imkoniyat</dt>
        <dd>{info.interaction === "office" ? "Ofis qavatlari va AI agentlar" : "Tashqi ko'rinishni ko'rish"}</dd>
        <dt>Ma'lumot</dt>
        <dd>{info.info ?? "Bu bino uchun operatsion ma'lumot hali sozlanmagan."}</dd>
      </dl>
      {info.interaction === "office" && (
        <button className="primary" onClick={onEnterOffice}>Ofisga kirish</button>
      )}
      <p className="hint">Sichqoncha: aylantirish — chap tugma, surish — o'ng tugma, yaqinlashtirish — g'ildirak.</p>
    </aside>
  );
}

export function BuildingTip({ info, x, y }: { info: CampusBuildingInfo; x: number; y: number }) {
  const left = Math.max(12, Math.min(x + 18, window.innerWidth - 252));
  return (
    <div className="hover-card" style={{ left, top: Math.max(70, y - 20), width: 240 }} role="tooltip">
      <div className="hc-title">{info.name}</div>
      <div className="muted">{info.category}</div>
      <div className="hc-foot">{info.interaction === "office" ? "Bosing — ofisga kirish" : "Bosing — binoni ko'rish"}</div>
    </div>
  );
}
