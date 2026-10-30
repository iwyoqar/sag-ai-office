// PerimeterDistrict: assembles the corporate ring round the campus: ring road with sidewalks, street trees and lamps,
// crossings with the M37, corner plazas, rear car parks, and every company's tower and office buildings (layout.ts).
// Static parts are merged per material (Batch); repeated props are instanced, one mesh per kind (Instancer).
import * as THREE from "three";
import { Batch } from "../campus/batch";
import { Instancer } from "../campus/instancer";
import { campusMaterials, groundPlaneM } from "../campus/materials";
import { carColor, carModels, lampGeometry, lampHead, treeGeometries } from "../campus/site";
import { logoMaterial } from "./brands";
import { buildCorporateBuilding } from "./corporateBuilding";
import { buildCorporateTower, type BuildCtx } from "./corporateTower";
import { companyMaterials, perimeterMaterials, type WindowStyle } from "./facade";
import {
  COMPANIES, M37_GAP, RING, ROAD_W, SETBACK, WALK_W, perimeterPlan, ringRoads,
  type Archetype, type PlotSpec,
} from "./layout";

const STYLES: Record<Archetype, [WindowStyle, WindowStyle]> = {
  flagship: ["fins", "punched"], premium: ["curtain", "punched"], commercial: ["curtain", "punched"],
  terraced: ["ribbon", "punched"], agri: ["ribbon", "punched"], industrial: ["ribbon", "ribbon"],
  twin: ["curtain", "ribbon"], sustainable: ["punched", "punched"], compact: ["curtain", "punched"],
  healthcare: ["ribbon", "ribbon"], cantilever: ["curtain", "punched"],
};
const GREEN_ROOFS = new Set(["sag-gardens", "jarkurgan-plastic-recycling", "maroqand-klaster"]);

const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export class PerimeterDistrict {
  readonly root = new THREE.Group();
  readonly plots: PlotSpec[] = perimeterPlan();

  constructor() {
    this.root.name = "perimeter-district";
    const cm = campusMaterials(), pm = perimeterMaterials();
    const b = new Batch();
    // one instanced mesh per prop kind for the whole ring: tiling it (as the store district does) multiplied the
    // draw calls by ~12 here, and the ring is mostly on screen at once anyway
    const inst = new Instancer();
    const tg = treeGeometries();
    const trees = { trunk: tg.trunk, crown: tg.crown, trunkMat: cm.trunk, leafMat: cm.leaves };

    this.streets(b, inst, cm, trees);
    this.park(b, inst, cm, trees);

    COMPANIES.forEach((c, i) => {
      const [main, annex] = STYLES[c.archetype];
      const ctx: BuildCtx = { b, inst, m: pm, c: companyMaterials(c.palette, main, annex, i + 3), logo: logoMaterial(c.logo), trees };
      for (const p of this.plots.filter((q) => q.company === c.id)) {
        if (p.main) {
          buildCorporateTower(ctx, p, c.archetype);
          this.carPark(b, inst, cm, p);
        } else buildCorporateBuilding(ctx, p, GREEN_ROOFS.has(c.id));
      }
    });

    this.root.add(...b.build(), ...inst.build());
  }

  /** Ring road, sidewalks (the outer one runs up to the building line), verge trees, lamps, crossings, corner plazas. */
  private streets(b: Batch, inst: Instancer, cm: ReturnType<typeof campusMaterials>, trees: BuildCtx["trees"]) {
    const flat = (w: number, d: number, mat: THREE.Material, x: number, y: number, z: number) =>
      b.add(groundPlaneM(w, d), mat, { x, y, z }, {}, false);
    const h = ROAD_W / 2;
    for (const r of ringRoads()) flat(r.x1 - r.x0, r.z1 - r.z0, cm.asphalt, (r.x0 + r.x1) / 2, 0.03, (r.z0 + r.z1) / 2);

    // centre dashes and edge lines (none across the M37 junctions)
    const dash = (x: number, z: number, w: number, d: number, mat: THREE.Material = cm.marking) => b.box(w, 0.02, d, mat, x, 0.035, z, 0, false);
    for (const z of [RING.z0, RING.z1])
      for (let x = RING.x0 + h + 4; x < RING.x1 - h - 4; x += 9) dash(x + 1.5, z, 3, 0.15);
    for (const x of [RING.x0, RING.x1])
      for (let z = RING.z0 + h + 4; z < RING.z1 - h - 4; z += 9) {
        if (z + 3 > 62 && z < 88) continue;
        dash(x, z + 1.5, 0.15, 3);
      }
    // zebra crossings on the ring road either side of each M37 junction
    for (const x of [RING.x0, RING.x1])
      for (const zc of [62.5, 87.5])
        for (let k = -h + 1.2; k < h - 0.8; k += 1.1) dash(x + k, zc, 0.55, 2.6);

    // sidewalks: inner WALK_W, outer up to the building line; kept off the M37 corridor on the east and west sides
    const walk = (x0: number, x1: number, z0: number, z1: number) => {
      if (x1 - x0 < 0.5 || z1 - z0 < 0.5) return;
      b.box(x1 - x0, 0.15, z1 - z0, cm.paving, (x0 + x1) / 2, 0, (z0 + z1) / 2, 0, false);
    };
    const outer = SETBACK - h;
    const X0 = RING.x0, X1 = RING.x1, Z0 = RING.z0, Z1 = RING.z1;
    // north / south: full length including the corners
    walk(X0 - h - outer, X1 + h + outer, Z0 - h - outer, Z0 - h);
    walk(X0 + h, X1 - h, Z0 + h, Z0 + h + WALK_W);
    walk(X0 - h - outer, X1 + h + outer, Z1 + h, Z1 + h + outer);
    walk(X0 + h, X1 - h, Z1 - h - WALK_W, Z1 - h);
    for (const [x, sOut] of [[X0, -1], [X1, 1]] as const) {
      for (const [z0, z1] of [[Z0 + h, M37_GAP.z0 + 6], [M37_GAP.z1 - 6, Z1 - h]]) {
        const oz0 = z0 === Z0 + h ? Z0 - h : z0, oz1 = z1 === Z1 - h ? Z1 + h : z1;
        if (sOut < 0) walk(x - h - outer, x - h, oz0, oz1);
        else walk(x + h, x + h + outer, oz0, oz1);
        const iz0 = z0 === Z0 + h ? Z0 + h + WALK_W : z0, iz1 = z1 === Z1 - h ? Z1 - h - WALK_W : z1;
        if (sOut < 0) walk(x + h, x + h + WALK_W, iz0, iz1);
        else walk(x - h - WALK_W, x - h, iz0, iz1);
      }
    }

    // street trees: a row on the inner verge and one along the outer sidewalk; lamps on the inner sidewalk
    let ti = 0;
    const tree = (x: number, z: number, s = 1) => {
      const k = (0.85 + hash(ti++) * 0.35) * s;
      inst.add("perim-tree-trunk", trees.trunk, trees.trunkMat, { x, y: 0.15, z }, { x: k, y: k, z: k });
      inst.add("perim-tree-crown", trees.crown, trees.leafMat, { x, y: 0.15, z }, { x: k, y: k, z: k }, { y: hash(ti) * 6 },
        new THREE.Color().setHSL(0.24 + hash(ti + 3) * 0.05, 0.36, 0.3 + hash(ti + 5) * 0.08));
    };
    const lamp = lampGeometry(), head = lampHead();
    const addLamp = (x: number, z: number, rotY: number) => {
      inst.add("perim-lamp", lamp, cm.pole, { x, y: 0.15, z }, undefined, { y: rotY }, null, { cast: true, receive: false });
      inst.add("perim-lamp-head", head, cm.lamp, { x, y: 0.15, z }, undefined, { y: rotY }, null, { cast: false, receive: false });
    };
    const inM37 = (z: number) => z > M37_GAP.z0 - 2 && z < M37_GAP.z1 + 2;
    const vIn = h + WALK_W + 3, vOut = h + 2.6;
    for (let x = X0 + 10; x < X1 - 10; x += 13) {
      tree(x, Z0 + vIn); tree(x + 6, Z1 - vIn);
      tree(x + 3, Z0 - vOut); tree(x + 9, Z1 + vOut);
    }
    for (let z = Z0 + 10; z < Z1 - 10; z += 13) {
      if (inM37(z)) continue;
      tree(X0 + vIn, z); tree(X1 - vIn, z + 6);
      tree(X0 - vOut, z + 3); tree(X1 + vOut, z + 9);
    }
    for (let x = X0 + 20; x < X1 - 10; x += 36) {
      addLamp(x, Z0 + h + 1, -Math.PI / 2);
      addLamp(x + 18, Z1 - h - 1, Math.PI / 2);
    }
    for (let z = Z0 + 20; z < Z1 - 10; z += 36) {
      if (inM37(z)) continue;
      addLamp(X0 + h + 1, z, Math.PI);
      addLamp(X1 - h - 1, z + 18, 0);
    }

    // corner plazas outside the ring corners: paving, a planted roundel and a tree grid
    for (const [cx, cz] of [[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]]) {
      const sx = cx === X0 ? -1 : 1, sz = cz === Z0 ? -1 : 1;
      const px = cx + sx * (h + outer + 22), pz = cz + sz * (h + outer + 22);
      b.box(40, 0.12, 40, cm.paving, px, 0, pz, 0, false);
      b.add(new THREE.CylinderGeometry(7, 7, 0.7, 32), cm.curb, { x: px, y: 0.35, z: pz });
      b.add(new THREE.CylinderGeometry(6.4, 6.4, 0.2, 32), cm.grass, { x: px, y: 0.75, z: pz }, {}, false);
      tree(px, pz, 1.3);
      for (const [dx, dz] of [[-14, -14], [14, -14], [14, 14], [-14, 14], [0, -15], [15, 0], [0, 15], [-15, 0]]) tree(px + dx, pz + dz, 0.9);
    }
  }

  /**
   * Business park on the free land inside the ring, east of the store district (which grows southwards, never past
   * x ≈ 300) and south of the M37: a footpath loop with diagonals, a pond with a paved edge, and tree groves.
   */
  private park(b: Batch, inst: Instancer, cm: ReturnType<typeof campusMaterials>, trees: BuildCtx["trees"]) {
    const P = { x0: 316, x1: RING.x1 - ROAD_W / 2 - WALK_W - 10, z0: 104, z1: RING.z1 - ROAD_W / 2 - WALK_W - 10 };
    const cx = (P.x0 + P.x1) / 2, cz = (P.z0 + P.z1) / 2, W = P.x1 - P.x0, D = P.z1 - P.z0;
    const path = (len: number, x: number, z: number, rotY: number) => b.add(new THREE.BoxGeometry(len, 0.12, 3.2), cm.paving, { x, y: 0.06, z }, { y: rotY }, false);
    const ins = 10;
    path(W - 2 * ins, cx, P.z0 + ins, 0);
    path(W - 2 * ins, cx, P.z1 - ins, 0);
    path(D - 2 * ins, P.x0 + ins, cz, Math.PI / 2);
    path(D - 2 * ins, P.x1 - ins, cz, Math.PI / 2);
    const diag = Math.hypot(W - 2 * ins, D - 2 * ins), ang = Math.atan2(D - 2 * ins, W - 2 * ins);
    path(diag, cx, cz, ang);
    path(diag, cx, cz, -ang);
    // links from the loop to the ring sidewalk and the M37 sidewalk
    path(ins + 6, P.x1 - ins / 2 + 3, cz, 0);
    path(P.z0 + ins - 90, cx, (90 + P.z0 + ins) / 2, Math.PI / 2);
    // pond at the centre, with a paved rim
    const water = (this.waterMat ??= new THREE.MeshStandardMaterial({ color: 0x6aa6c8, roughness: 0.08, metalness: 0.25 }));
    b.add(new THREE.CylinderGeometry(24, 24, 0.3, 48), cm.paving, { x: cx, y: 0.15, z: cz });
    b.add(new THREE.CylinderGeometry(21.5, 21.5, 0.32, 48), water, { x: cx, y: 0.17, z: cz }, {}, false);
    // tree groves in the four fields between the paths
    let ti = 900;
    for (const [fx, fz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const gx = cx + fx * W * 0.27, gz = cz + fz * D * 0.24;
      for (let k = 0; k < 16; k++) {
        const a = hash(ti) * Math.PI * 2, r = 4 + hash(ti + 0.5) * Math.min(W, D) * 0.14;
        const x = gx + Math.cos(a) * r, z = gz + Math.sin(a) * r, s = 0.9 + hash(ti + 0.7) * 0.5;
        inst.add("perim-tree-trunk", trees.trunk, trees.trunkMat, { x, y: 0, z }, { x: s, y: s, z: s });
        inst.add("perim-tree-crown", trees.crown, trees.leafMat, { x, y: 0, z }, { x: s, y: s, z: s }, { y: hash(ti) * 6 },
          new THREE.Color().setHSL(0.22 + hash(ti + 3) * 0.07, 0.4, 0.28 + hash(ti + 5) * 0.1));
        ti++;
      }
    }
    // a tree line along the loop
    for (let x = P.x0 + ins + 6; x < P.x1 - ins; x += 12)
      for (const z of [P.z0 + ins + 4, P.z1 - ins - 4]) {
        inst.add("perim-tree-trunk", trees.trunk, trees.trunkMat, { x, y: 0, z }, { x: 0.9, y: 0.9, z: 0.9 });
        inst.add("perim-tree-crown", trees.crown, trees.leafMat, { x, y: 0, z }, { x: 0.9, y: 0.9, z: 0.9 }, { y: x }, new THREE.Color().setHSL(0.25, 0.38, 0.32));
      }
  }
  private waterMat: THREE.MeshStandardMaterial | null = null;

  /** Surface car park behind a headquarters tower (away from the ring), two rows of bays, partly occupied. */
  private carPark(b: Batch, inst: Instancer, cm: ReturnType<typeof campusMaterials>, p: PlotSpec) {
    const gap = 8, depth = 26;
    const alongX = p.side === "n" || p.side === "s";
    const len = alongX ? p.x1 - p.x0 : p.z1 - p.z0;
    let cx: number, cz: number;
    if (p.side === "n") { cx = (p.x0 + p.x1) / 2; cz = p.z0 - gap - depth / 2; }
    else if (p.side === "s") { cx = (p.x0 + p.x1) / 2; cz = p.z1 + gap + depth / 2; }
    else if (p.side === "e") { cx = p.x1 + gap + depth / 2; cz = (p.z0 + p.z1) / 2; }
    else { cx = p.x0 - gap - depth / 2; cz = (p.z0 + p.z1) / 2; }
    const w = alongX ? len : depth, d = alongX ? depth : len;
    b.add(groundPlaneM(w, d), cm.asphalt, { x: cx, y: 0.03, z: cz }, {}, false);
    // access drive from the building to the lot
    if (alongX) b.add(groundPlaneM(7, gap + 1), cm.asphalt, { x: cx + len / 2 - 6, y: 0.031, z: p.side === "n" ? p.z0 - gap / 2 : p.z1 + gap / 2 }, {}, false);
    else b.add(groundPlaneM(gap + 1, 7), cm.asphalt, { x: p.side === "e" ? p.x1 + gap / 2 : p.x0 - gap / 2, y: 0.031, z: cz + len / 2 - 6 }, {}, false);
    const models = carModels();
    let bay = p.seed * 100;
    for (const row of [-1, 1]) {
      for (let t = -len / 2 + 2; t < len / 2 - 2; t += 2.6, bay++) {
        const off = row * (depth / 2 - 2.7);
        const mx = alongX ? cx + t : cx + off, mz = alongX ? cz + off : cz + t;
        // bay lines
        if (alongX) b.box(0.12, 0.01, 5, cm.marking, mx - 1.3, 0.035, mz, 0, false);
        else b.box(5, 0.01, 0.12, cm.marking, mx, 0.035, mz - 1.3, 0, false);
        if (hash(bay) > 0.62) continue;
        const type = hash(bay + 0.37) < 0.45 ? 0 : hash(bay + 0.37) < 0.85 ? 1 : 2;
        const mdl = models[type];
        const rotY = (alongX ? (row > 0 ? -Math.PI / 2 : Math.PI / 2) : row > 0 ? Math.PI : 0) + (hash(bay + 0.9) - 0.5) * 0.08;
        const pos = { x: mx, y: 0.03, z: mz };
        inst.add(`perim-car-body-${type}`, mdl.body, cm.carBody, pos, undefined, { y: rotY }, carColor(hash(bay + 0.71)));
        inst.add(`perim-car-glass-${type}`, mdl.glass, cm.carGlass, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
        inst.add(`perim-car-tyre-${type}`, mdl.tyres, cm.tyre, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
      }
    }
  }
}
