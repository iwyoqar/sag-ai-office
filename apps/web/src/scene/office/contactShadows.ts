// Baked contact shadows ("AO") for an office floor: soft darkening under furniture, desks, chairs and along the
// walls, painted once from the floor plan into a texture laid just above the floor.
// Screen-space AO (GTAO) is not used: the renderer runs with a logarithmic depth buffer for the campus, which
// depth-based post-processing cannot read. Baking from the plan is exact, free at runtime, and works on any GPU.
import { outline } from "../buildingGeometry";
import { podRect, propFootprint, type FloorPlan, type Rect } from "./plan";

export interface ShadowRect extends Rect {
  /** 0..1 darkness at the centre */
  strength: number;
  /** soft edge width, metres */
  soft: number;
  /** round things (pots, stools, chair bases, round tables) cast a round shadow */
  round?: boolean;
}

/** What casts a contact shadow on the floor, and how strongly (pure, unit-tested). */
export function shadowRects(plan: FloorPlan): ShadowRect[] {
  const out: ShadowRect[] = [];
  for (const p of plan.props) {
    if (p.kind === "glassWall") continue; // thin and transparent: no ground shadow
    const tall = ["shelf", "credenza", "coffeePoint", "serverRack", "kanban", "receptionDesk", "displayStand", "brainCore"].includes(p.kind);
    const round = ["plant", "plantTall", "stool", "coffeeTable", "brainCore"].includes(p.kind);
    for (const r of propFootprint(p)) out.push({ ...r, strength: tall ? 0.5 : 0.36, soft: tall ? 0.35 : 0.28, round });
  }
  for (const pod of plan.pods) out.push({ ...podRect(pod), strength: 0.3, soft: 0.3 });
  for (const s of [...plan.workstations, ...plan.meetingSeats])
    out.push({ x0: s.x - 0.26, x1: s.x + 0.26, z0: s.z - 0.26, z1: s.z + 0.26, strength: 0.32, soft: 0.22, round: true });
  return out;
}

/** Paints the shadow texture (alpha = darkness). `pxPerM` controls resolution. */
export function paintContactShadows(plan: FloorPlan, pxPerM = 24): { canvas: HTMLCanvasElement; bounds: Rect } {
  // cover the whole slab (the curved front bulges past the plan bounds)
  const o = outline(0);
  const b = {
    x0: Math.min(...o.map((p) => p[0])), x1: Math.max(...o.map((p) => p[0])),
    z0: Math.min(...o.map((p) => p[1])), z1: Math.max(...o.map((p) => p[1])),
  };
  const w = Math.ceil((b.x1 - b.x0) * pxPerM), h = Math.ceil((b.z1 - b.z0) * pxPerM);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  const X = (x: number) => (x - b.x0) * pxPerM, Z = (z: number) => (z - b.z0) * pxPerM;
  // never darken outside the slab (the diorama surround shows through there)
  g.beginPath();
  outline(-0.08).forEach(([x, z], k) => (k ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
  g.closePath();
  g.clip();
  // soft edges by stacking inflated, faint rectangles (portable: no canvas `filter` needed)
  const STEPS = 6;
  for (const r of shadowRects(plan)) {
    if (r.round) {
      const cx = X((r.x0 + r.x1) / 2), cz = Z((r.z0 + r.z1) / 2);
      const core = (Math.max(r.x1 - r.x0, r.z1 - r.z0) / 2) * pxPerM;
      const rad = core + r.soft * pxPerM;
      const grad = g.createRadialGradient(cx, cz, 0, cx, cz, rad);
      grad.addColorStop(0, `rgba(0,0,0,${r.strength})`);
      grad.addColorStop(core / rad, `rgba(0,0,0,${(r.strength * 0.7).toFixed(3)})`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(cx - rad, cz - rad, rad * 2, rad * 2);
      continue;
    }
    for (let i = STEPS; i >= 1; i--) {
      const grow = (r.soft * i) / STEPS;
      g.fillStyle = `rgba(0,0,0,${(r.strength / STEPS).toFixed(3)})`;
      g.fillRect(X(r.x0 - grow), Z(r.z0 - grow), (r.x1 - r.x0 + 2 * grow) * pxPerM, (r.z1 - r.z0 + 2 * grow) * pxPerM);
    }
  }
  // ambient darkening along the inside of the walls
  const ring = outline(-0.25);
  g.lineJoin = "round";
  for (let i = 1; i <= STEPS; i++) {
    g.strokeStyle = `rgba(0,0,0,${(0.3 / STEPS).toFixed(3)})`;
    g.lineWidth = (0.9 * i * pxPerM) / STEPS;
    g.beginPath();
    ring.forEach(([x, z], k) => (k ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    g.closePath();
    g.stroke();
  }
  return { canvas, bounds: b };
}
