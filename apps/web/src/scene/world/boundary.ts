// The visible world: the developed districts (campus, industrial ring, store district) on a grass plate whose edge
// fades through a haze band into the background, so undeveloped land never shows as an endless green grid. The
// rectangle follows the actual layout (district plan), so future districts widen it automatically. Nothing here
// touches business data: it only decides what land is drawn.
import * as THREE from "three";
import { CAMPUS_BOUNDS } from "../campus/layout";
import { EAST_ROAD_X, ROUNDABOUT } from "./network";
import { PERIMETER_OUTER } from "../perimeter/layout";

export interface WorldRect { x0: number; x1: number; z0: number; z1: number }

/** Developed area: campus + east service road + roundabout + district (when known). */
export function worldRect(district: WorldRect | null): WorldRect {
  const r = { x0: CAMPUS_BOUNDS.x0, x1: Math.max(CAMPUS_BOUNDS.x1, EAST_ROAD_X + 8), z0: CAMPUS_BOUNDS.z0, z1: Math.max(CAMPUS_BOUNDS.z1, ROUNDABOUT.z + 12) };
  // the corporate perimeter ring round campus and district is part of the developed world
  r.x0 = Math.min(r.x0, PERIMETER_OUTER.x0);
  r.x1 = Math.max(r.x1, PERIMETER_OUTER.x1);
  r.z0 = Math.min(r.z0, PERIMETER_OUTER.z0);
  r.z1 = Math.max(r.z1, PERIMETER_OUTER.z1);
  if (district) {
    r.x0 = Math.min(r.x0, district.x0);
    r.x1 = Math.max(r.x1, district.x1);
    r.z0 = Math.min(r.z0, district.z0);
    r.z1 = Math.max(r.z1, district.z1);
  }
  return r;
}

/** Haze colour = fog / horizon colour, so the band blends into the background. */
export const HAZE = 0xdbe7f3;
/** clear land kept round the developed area before the haze starts, and the width of the fade */
const CLEAR = 40, FADE = 170, FAR = 5000;

/**
 * A flat ring over the ground: transparent at the world edge, opaque haze FADE metres further out and beyond.
 * It covers ground-level things only (roads leaving the world, the plain), which is all there is out there.
 */
export function hazeRing(r: WorldRect, y = 0.4): THREE.Mesh {
  const rects = [CLEAR, CLEAR + FADE, FAR].map((m) => [r.x0 - m, r.z0 - m, r.x1 + m, r.z1 + m]);
  const alpha = [0, 1, 1];
  const pos: number[] = [], col: number[] = [];
  const c = new THREE.Color(HAZE);
  const corners = (q: number[]) => [[q[0], q[1]], [q[2], q[1]], [q[2], q[3]], [q[0], q[3]]];
  for (let ring = 0; ring < 2; ring++) {
    const inner = corners(rects[ring]), outer = corners(rects[ring + 1]);
    for (let k = 0; k < 4; k++) {
      const i0 = inner[k], i1 = inner[(k + 1) % 4], o0 = outer[k], o1 = outer[(k + 1) % 4];
      // two triangles per side, wound to face up
      for (const [p, a] of [[i0, alpha[ring]], [o1, alpha[ring + 1]], [o0, alpha[ring + 1]], [i0, alpha[ring]], [i1, alpha[ring]], [o1, alpha[ring + 1]]] as [number[], number][]) {
        pos.push(p[0], y, p[1]);
        col.push(c.r, c.g, c.b, a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  mesh.name = "world-haze";
  mesh.renderOrder = -1;
  return mesh;
}
