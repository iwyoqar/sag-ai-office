// CorporateTower: each company's headquarters, one architectural form per archetype (layout.ts), with its rooftop
// logo. Built into the shared Batch (merged per material) and Instancer (rooftop units, terrace trees, solar).
import * as THREE from "three";
import type { Batch } from "../campus/batch";
import type { Instancer } from "../campus/instancer";
import { UNIT } from "../campus/instancer";
import type { LogoMaterial } from "./brands";
import { wallBox, wallCylinder, type CompanyMaterials, type PerimeterMaterials } from "./facade";
import { GROUND_H, heightOf, type Archetype, type PlotSpec, type SideId } from "./layout";
import { rooftopLogo } from "./rooftopLogo";

export interface BuildCtx {
  b: Batch;
  inst: Instancer;
  m: PerimeterMaterials;
  c: CompanyMaterials;
  logo: LogoMaterial;
  trees: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; trunkMat: THREE.Material; leafMat: THREE.Material };
}

const hash = (n: number) => {
  const x = Math.sin(n * 63.7 + 9.1) * 43758.5453;
  return x - Math.floor(x);
};

/** Wall volume from y0 to y1, centred on (x, z). */
export function vol(ctx: BuildCtx, mat: THREE.Material, x: number, z: number, w: number, d: number, y0: number, y1: number) {
  ctx.b.add(wallBox(w, y1 - y0, d, y0), mat, { x, y: y0, z });
}

/** Parapet coping and roof membrane on top of a w × d volume; returns the roof surface height. */
export function roof(ctx: BuildCtx, x: number, z: number, w: number, d: number, y: number, top: THREE.Material = ctx.m.roof) {
  const { b, m } = ctx;
  const t = 0.45, ph = 1.0;
  b.box(w + 0.3, ph, t, m.coping, x, y, z + d / 2 - t / 2 + 0.15);
  b.box(w + 0.3, ph, t, m.coping, x, y, z - d / 2 + t / 2 - 0.15);
  b.box(t, ph, d - 2 * t + 0.3, m.coping, x + w / 2 - t / 2 + 0.15, y, z);
  b.box(t, ph, d - 2 * t + 0.3, m.coping, x - w / 2 + t / 2 - 0.15, y, z);
  b.box(w - 0.2, 0.12, d - 0.2, top, x, y, z, 0, false);
  return y + 0.12;
}

/** Plant on a roof: a penthouse and rooftop units, kept to the back (−z) half so the front stays clear for signs. */
export function plant(ctx: BuildCtx, x: number, z: number, w: number, d: number, y: number, seed: number, units = 4) {
  const { b, m, inst } = ctx;
  const pw = Math.min(10, w * 0.35), pd = Math.min(7, d * 0.3);
  const px = x + (hash(seed) - 0.5) * (w - pw) * 0.6, pz = z - d / 2 + pd / 2 + 1.2;
  b.box(pw, 3.2, pd, m.plant, px, y, pz);
  b.box(pw + 0.3, 0.25, pd + 0.3, m.coping, px, y + 3.2, pz);
  for (let i = 0; i < units; i++) {
    const ux = x - w / 2 + 2 + hash(seed + i * 1.7) * (w - 4), uz = z - d / 2 + pd + 2.5 + hash(seed + i * 2.3) * Math.max(1, d * 0.25);
    inst.add("perim-ac", UNIT.box, m.plant, { x: ux, y: y + 0.6, z: uz }, { x: 2.2, y: 1.2, z: 1.4 });
  }
}

/** Entrance canopy on the side facing the ring road (toward the campus). */
function canopy(ctx: BuildCtx, x0: number, x1: number, z0: number, z1: number, side: SideId) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, y = GROUND_H - 0.7;
  if (side === "n") ctx.b.box(12, 0.45, 4, ctx.c.accent, cx, y, z1 + 2);
  else if (side === "s") ctx.b.box(12, 0.45, 4, ctx.c.accent, cx, y, z0 - 2);
  else if (side === "e") ctx.b.box(4, 0.45, 12, ctx.c.accent, x0 - 2, y, cz);
  else ctx.b.box(4, 0.45, 12, ctx.c.accent, x1 + 2, y, cz);
}

/** Rooftop logo on a roof whose +z edge is at zFront. */
function sign(ctx: BuildCtx, x: number, roofY: number, zFront: number, roomW: number, maxH: number, lift?: number) {
  rooftopLogo(ctx.b, ctx.logo, ctx.m, { x, roofY, zEdge: zFront, maxW: roomW, maxH, lift });
}

type Form = (ctx: BuildCtx, p: PlotSpec, x: number, z: number, W: number, D: number, H: number) => void;

const FORMS: Record<Archetype, Form> = {
  // SAG: podium, a tall glass shaft with blue corner pilasters, an open crown frame and a helipad
  flagship(ctx, p, x, z, W, D, H) {
    const { c, m, b } = ctx;
    const h3 = heightOf(3);
    vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
    vol(ctx, c.annex, x, z, W, D, GROUND_H, h3);
    roof(ctx, x, z, W, D, h3, m.greenRoof);
    const tw = W * 0.68, td = D * 0.62, tz = z - D * 0.12;
    vol(ctx, c.main, x, tz, tw, td, h3, H);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) b.box(1.3, H - h3 + 1, 1.3, c.accent, x + sx * (tw / 2 - 0.3), h3, tz + sz * (td / 2 - 0.3));
    const ry = roof(ctx, x, tz, tw, td, H);
    // crown: four posts and a ring beam, 7 m above the roof
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) b.box(0.7, 7, 0.7, c.accent, x + sx * (tw / 2 - 0.6), ry, tz + sz * (td / 2 - 0.6));
    b.box(tw - 0.6, 0.6, 0.6, c.accent, x, ry + 7, tz + td / 2 - 0.6);
    b.box(tw - 0.6, 0.6, 0.6, c.accent, x, ry + 7, tz - td / 2 + 0.6);
    b.box(0.6, 0.6, td - 0.6, c.accent, x + tw / 2 - 0.6, ry + 7, tz);
    b.box(0.6, 0.6, td - 0.6, c.accent, x - tw / 2 + 0.6, ry + 7, tz);
    // helipad on the back half of the roof
    const hr = Math.min(tw, td) * 0.26, hz = tz - td / 2 + hr + 1.5;
    b.add(new THREE.CylinderGeometry(hr, hr, 0.6, 32), m.helipad, { x, y: ry + 1.5, z: hz });
    b.add(new THREE.CylinderGeometry(hr * 0.86, hr * 0.86, 0.62, 32, 1, true), m.helipadMark, { x, y: ry + 1.5, z: hz }, {}, false);
    for (const sx of [-1, 1]) b.box(0.4, 1.2, 0.4, m.steel, x + sx * hr * 0.7, ry, hz);
    // the sign stands on the crown, above its front beam, so nothing crosses the logo
    sign(ctx, x, ry, tz + td / 2, tw - 2.4, 9.5, 7.7);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // SAG Flooring: three set-back glass volumes with champagne corner fins
  premium(ctx, p, x, z, W, D, H) {
    const { c, b } = ctx;
    const f = p.floors, n1 = Math.round(f * 0.6), n2 = Math.round(f * 0.85);
    const h1 = heightOf(n1), h2 = heightOf(n2);
    vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
    vol(ctx, c.main, x, z, W, D, GROUND_H, h1);
    roof(ctx, x, z, W, D, h1);
    vol(ctx, c.main, x, z - 1, W - 6, D - 6, h1, h2);
    roof(ctx, x, z - 1, W - 6, D - 6, h2);
    vol(ctx, c.main, x, z - 2, W - 12, D - 10, h2, H);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) b.box(0.8, h1 - GROUND_H, 0.8, c.accent, x + sx * (W / 2 + 0.2), GROUND_H, z + sz * (D / 2 + 0.2));
    const ry = roof(ctx, x, z - 2, W - 12, D - 10, H);
    plant(ctx, x, z - 2, W - 12, D - 10, ry, p.seed, 2);
    sign(ctx, x, ry, z - 2 + (D - 10) / 2, W - 13, 8);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // SAG Home Design: a wide stone block with a roof terrace and a glass block rising from one side
  commercial(ctx, p, x, z, W, D, H) {
    const { c, m, b } = ctx;
    const nLow = Math.min(5, p.floors - 3), hLow = heightOf(nLow);
    vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
    vol(ctx, c.annex, x, z, W, D, GROUND_H, hLow);
    const ry0 = roof(ctx, x, z, W, D, hLow);
    const uw = W * 0.52, ud = D * 0.78, ux = x + W * 0.22, uz = z - D * 0.08;
    vol(ctx, c.main, ux, uz, uw, ud, hLow, H);
    // terrace: pergola and planters on the low roof
    const tx = x - W * 0.25;
    for (let i = 0; i < 6; i++) b.box(0.25, 0.3, D * 0.5, m.timber, tx - 7 + i * 2.8, ry0 + 2.8, z);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.3, 2.8, 0.3, m.steel, tx + sx * 7.2, ry0, z + sz * D * 0.24);
    for (let i = 0; i < 4; i++) {
      b.box(2.4, 0.8, 1.2, m.planter, tx - 6 + i * 4, ry0, z + D / 2 - 2.2);
      b.box(2.2, 0.35, 1.0, m.greenRoof, tx - 6 + i * 4, ry0 + 0.8, z + D / 2 - 2.2, 0, false);
    }
    const ry = roof(ctx, ux, uz, uw, ud, H);
    plant(ctx, ux, uz, uw, ud, ry, p.seed, 2);
    sign(ctx, ux, ry, uz + ud / 2, uw - 2, 8);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // SAG Gardens: floors step back toward the rear, every terrace planted with shrubs and small trees
  terraced(ctx, p, x, z, W, D, H) {
    const { c, m, b, inst, trees } = ctx;
    const step = Math.min(2.6, (D - 12) / Math.max(1, p.floors - 2));
    vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
    let front = z + D / 2;
    for (let k = 2; k <= p.floors; k++) {
      const y0 = heightOf(k - 1), y1 = heightOf(k);
      const back = z - D / 2;
      if (k > 2) {
        // terrace edge: planter with green top, a few small trees
        b.box(W - 1, 0.9, 1.1, m.planter, x, y0, front - 0.55);
        b.box(W - 1.2, 0.3, 0.9, m.greenRoof, x, y0 + 0.9, front - 0.55, 0, false);
        if (step > 1.4) b.box(W - 1, 0.12, step - 1.1, m.timber, x, y0, front - 1.1 - (step - 1.1) / 2, 0, false);
        for (let t = 0; t < 4; t++) {
          const tx = x - W / 2 + 4 + (t + hash(p.seed + k + t)) * ((W - 8) / 4);
          inst.add("perim-tree-trunk", trees.trunk, trees.trunkMat, { x: tx, y: y0 + 0.9, z: front - 0.6 }, { x: 0.45, y: 0.45, z: 0.45 });
          inst.add("perim-tree-crown", trees.crown, trees.leafMat, { x: tx, y: y0 + 0.9, z: front - 0.6 }, { x: 0.45, y: 0.45, z: 0.45 }, { y: t },
            new THREE.Color().setHSL(0.25 + hash(k * 3 + t) * 0.06, 0.45, 0.32));
        }
        front -= step;
      }
      vol(ctx, c.main, x, (front + back) / 2, W, front - back, y0, y1);
    }
    const depth = front - (z - D / 2), rz = (front + z - D / 2) / 2;
    const ry = roof(ctx, x, rz, W, depth, H, m.greenRoof);
    sign(ctx, x, ry, front, W - 4, 7);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // Maroqand Klaster: long ribbon-window office, glass atrium entrance, green band, north-light roof
  agri(ctx, p, x, z, W, D, H) {
    const { c, m, b } = ctx;
    vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
    vol(ctx, c.main, x, z, W, D, GROUND_H, H);
    b.box(W + 0.4, 1.0, D + 0.4, c.accent, x, H - 1.6, z);
    vol(ctx, c.lobby, x - W * 0.3, z + D / 2 + 2, 9, 4, 0, H - 2);
    const ry = roof(ctx, x, z, W, D, H);
    // north lights over the rear half
    for (let i = 0; i < 6; i++) {
      const sx = x - W / 2 + 4 + i * ((W - 8) / 5);
      b.add(new THREE.BoxGeometry(5.5, 0.25, 7), m.solar, { x: sx, y: ry + 1.6, z: z - D / 2 + 6 }, { x: 0.45 });
      b.box(5.5, 3.2, 0.3, m.coping, sx, ry, z - D / 2 + 3.1);
    }
    sign(ctx, x + W * 0.08, ry, z + D / 2, W * 0.62, 7);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // Turbo Plast: dark metal office block with red bands, a glass corner and saw-tooth roof lights
  industrial(ctx, p, x, z, W, D, H) {
    const { c, m, b } = ctx;
    vol(ctx, c.solid, x, z, W, D, 0, GROUND_H);
    vol(ctx, c.main, x, z, W, D, GROUND_H, H);
    b.box(W + 0.4, 0.8, D + 0.4, c.accent, x, GROUND_H - 0.4, z);
    b.box(W + 0.4, 0.8, D + 0.4, c.accent, x, H - 1.4, z);
    vol(ctx, c.lobby, x + W / 2 - 5, z + D / 2 - 5, 10.6, 10.6, 0, H + 1.5);
    const ry = roof(ctx, x, z, W, D, H);
    for (let i = 0; i < 5; i++) {
      const sz = z - D / 2 + 4 + i * 3.6;
      b.add(new THREE.BoxGeometry(W * 0.55, 0.25, 3.4), m.solar, { x: x - W * 0.15, y: ry + 1.0, z: sz }, { x: -0.5 });
    }
    sign(ctx, x - W * 0.1, ry, z + D / 2, W * 0.7, 6);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // SET: twin glass towers on a shared podium, joined by a two-storey sky bridge
  twin(ctx, p, x, z, W, D, H) {
    const { c, b } = ctx;
    const h2 = heightOf(2);
    vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
    vol(ctx, c.annex, x, z, W, D, GROUND_H, h2);
    roof(ctx, x, z, W, D, h2);
    const tw = W * 0.38, td = D * 0.82, gap = W - 2 * tw - 4;
    const hs = [H, heightOf(p.floors - 2)];
    let signed = false;
    [-1, 1].forEach((s, i) => {
      const tx = x + s * (tw / 2 + gap / 2);
      vol(ctx, c.main, tx, z, tw, td, h2, hs[i]);
      b.box(tw + 0.6, 1.6, td + 0.6, c.frame, tx, hs[i], z);
      const ry = hs[i] + 1.6;
      if (!signed) {
        sign(ctx, tx, ry, z + td / 2, tw - 1.2, 6, 1.2);
        signed = true;
      } else plant(ctx, tx, z, tw, td, ry, p.seed, 2);
    });
    const nb = Math.round(p.floors * 0.62);
    vol(ctx, c.main, x, z, gap + 1, 8, heightOf(nb - 1), heightOf(nb + 1));
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // Jarkurgan Plastic Recycling: timber louvres, planted end walls, green roof with solar rows
  sustainable(ctx, p, x, z, W, D, H) {
    const { c, m, b, inst } = ctx;
    vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
    vol(ctx, c.main, x, z, W, D, GROUND_H, H);
    for (let lx = x - W / 2 + 0.8; lx < x + W / 2 - 0.5; lx += 1.3) {
      b.box(0.22, H - GROUND_H, 0.7, m.timber, lx, GROUND_H, z + D / 2 + 0.4);
      b.box(0.22, H - GROUND_H, 0.7, m.timber, lx, GROUND_H, z - D / 2 - 0.4);
    }
    for (const sx of [-1, 1]) b.box(0.6, H - GROUND_H - 1, D * 0.7, m.greenRoof, x + sx * (W / 2 + 0.3), GROUND_H, z);
    const ry = roof(ctx, x, z, W, D, H, m.greenRoof);
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < 6; k++)
        inst.add("perim-solar", UNIT.box, m.solar, { x: x - W / 2 + 5 + k * ((W - 10) / 5), y: ry + 0.9, z: z - D / 2 + 3 + r * 3.4 }, { x: 5, y: 0.12, z: 2.2 }, { x: -0.35 });
    sign(ctx, x, ry, z + D / 2, W * 0.66, 6.5);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // SEAL: slender square tower, navy stone frame (corner piers, a band every three floors) round recessed glass
  compact(ctx, p, x, z, W, D, H) {
    const { c, b } = ctx;
    vol(ctx, c.lobby, x, z, W - 2, D - 2, 0, GROUND_H);
    vol(ctx, c.main, x, z, W - 2, D - 2, GROUND_H, H);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(2.2, H + 2.5, 2.2, c.solid, x + sx * (W / 2 - 1.1), 0, z + sz * (D / 2 - 1.1));
    for (let k = 3; k < p.floors; k += 3) b.box(W, 0.9, D, c.solid, x, heightOf(k) - 0.45, z);
    vol(ctx, c.solid, x, z, W, D, H, H + 2.5);
    const ry = roof(ctx, x, z, W - 0.6, D - 0.6, H + 2.5);
    plant(ctx, x, z, W, D, ry, p.seed, 2);
    sign(ctx, x, ry, z + D / 2, W - 4, 9);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // Bionur Med: white slab with rounded ends and a continuous sunshade at every floor
  healthcare(ctx, p, x, z, W, D, H) {
    const { c, b } = ctx;
    const r = D / 2, bw = W - D;
    vol(ctx, c.lobby, x, z, bw, D, 0, GROUND_H);
    vol(ctx, c.main, x, z, bw, D, GROUND_H, H);
    for (const s of [-1, 1]) {
      const start = s > 0 ? 0 : Math.PI;
      b.add(wallCylinder(r, GROUND_H, 0, Math.PI, start), c.lobby, { x: x + s * bw / 2, y: 0, z });
      b.add(wallCylinder(r, H - GROUND_H, GROUND_H, Math.PI, start), c.main, { x: x + s * bw / 2, y: GROUND_H, z });
      for (let k = 1; k < p.floors; k++)
        b.add(new THREE.CylinderGeometry(r + 1.2, r + 1.2, 0.2, 24, 1, false, start, Math.PI), c.frame, { x: x + s * bw / 2, y: heightOf(k), z });
      b.add(new THREE.CylinderGeometry(r + 0.2, r + 0.2, 0.9, 24, 1, false, start, Math.PI), ctx.m.coping, { x: x + s * bw / 2, y: H + 0.45, z });
      b.add(new THREE.CylinderGeometry(r, r, 0.12, 24, 1, false, start, Math.PI), ctx.m.roof, { x: x + s * bw / 2, y: H + 0.06, z }, {}, false);
    }
    for (let k = 1; k < p.floors; k++) b.box(bw, 0.2, D + 2.4, c.frame, x, heightOf(k), z);
    b.box(bw + 0.3, 0.9, 0.45, ctx.m.coping, x, H, z + D / 2);
    b.box(bw + 0.3, 0.9, 0.45, ctx.m.coping, x, H, z - D / 2);
    b.box(bw, 0.12, D - 0.2, ctx.m.roof, x, H, z, 0, false);
    const ry = H + 0.12;
    plant(ctx, x, z, bw, D, ry, p.seed, 3);
    sign(ctx, x, ry, z + D / 2, bw - 1, 7);
    b.box(W * 0.5, 0.2, 1.6, c.accent, x, heightOf(2) + 0.25, z + D / 2 + 0.9);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },

  // Casva: charcoal base, an upper glass block cantilevered to one side, orange fascia and fins
  cantilever(ctx, p, x, z, W, D, H) {
    const { c, b } = ctx;
    const n1 = Math.round(p.floors * 0.58), h1 = heightOf(n1);
    const lw = W * 0.82, lx = x - W * 0.09;
    vol(ctx, c.lobby, lx, z, lw, D, 0, GROUND_H);
    vol(ctx, c.annex, lx, z, lw, D, GROUND_H, h1);
    roof(ctx, lx, z, lw, D, h1);
    const uw = W * 0.72, ux = x + W * 0.14, ud = D * 0.86;
    vol(ctx, c.main, ux, z, uw, ud, h1 + 0.6, H);
    b.box(uw + 0.6, 1.2, ud + 0.6, c.accent, ux, h1, z);
    for (let fx = ux - uw / 2 + 2; fx < ux + uw / 2 - 1; fx += 4.2) b.box(0.35, H - h1 - 0.6, 0.9, c.accent, fx, h1 + 0.6, z + ud / 2 + 0.45);
    const ry = roof(ctx, ux, z, uw, ud, H);
    plant(ctx, ux, z, uw, ud, ry, p.seed, 2);
    sign(ctx, ux, ry, z + ud / 2, uw - 2, 7.5);
    canopy(ctx, p.x0, p.x1, p.z0, p.z1, p.side);
  },
};

export function buildCorporateTower(ctx: BuildCtx, p: PlotSpec, archetype: Archetype) {
  const x = (p.x0 + p.x1) / 2, z = (p.z0 + p.z1) / 2;
  FORMS[archetype](ctx, p, x, z, p.x1 - p.x0, p.z1 - p.z0, heightOf(p.floors));
}

