import { useOffice } from "../api/office";
import { floorLabel } from "./shared";

/** Shown when WebGL is unavailable: same navigation, drawn as a 2D section of the building. */
export function FallbackBuilding({ onSelect, selected }: { onSelect: (id: string) => void; selected: string | null }) {
  const { office } = useOffice();
  return (
    <div className="fallback">
      <p className="fallback-note">Brauzeringizda WebGL ishlamayapti — 3D o'rniga sxematik ko'rinish.</p>
      <div className="fb-building">
        <div className="fb-roof">SAG</div>
        {office?.floors.map((f) => (
          <button
            key={f.id}
            className={`fb-floor${f.level === -1 ? " basement" : ""}${selected === f.id ? " on" : ""}`}
            onClick={() => onSelect(f.id)}
          >
            <span className="fb-lvl">{floorLabel(f.level)}</span>
            {f.departments.map((d) => (
              <span key={d} className="fb-dep" style={{ ["--dep" as string]: office.departments[d]?.color }}>{office.departments[d]?.short}</span>
            ))}
          </button>
        ))}
      </div>
    </div>
  );
}
