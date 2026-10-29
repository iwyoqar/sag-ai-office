import { useOffice } from "../api/office";
import { floorLabel } from "./shared";

export function FloorRail({ current, hovered, onSelect }: { current: string | null; hovered: string | null; onSelect: (id: string) => void }) {
  const { office } = useOffice();
  if (!office) return null;
  return (
    <nav className="floor-rail" aria-label="Qavatlar">
      {office.floors.map((f) => (
        <button
          key={f.id}
          className={`rail-item${current === f.id ? " active" : ""}${hovered === f.id ? " hovered" : ""}`}
          onClick={() => onSelect(f.id)}
          aria-current={current === f.id ? "true" : undefined}
          data-floor={f.id}
        >
          <span className="rail-level">{floorLabel(f.level)}</span>
          <span className="rail-text">
            <span className="rail-title">{f.title}</span>
            <span className="rail-dots">
              {f.departments.map((d) => (
                <i key={d} style={{ background: office.departments[d]?.color }} />
              ))}
            </span>
          </span>
        </button>
      ))}
    </nav>
  );
}
