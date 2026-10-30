// Outdoor environment: ground, roads, walks, markings, parking + vehicles, lamps, trees, surrounding context.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAMPUS_BOUNDS, PARKING, ROADS, STORE_DISTRICT, WALKS, type Rect } from "./layout";
import { groundPlaneM, type CampusMaterials } from "./materials";
import { Instancer, UNIT } from "./instancer";

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ---------- vehicles ----------
interface CarModel { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; tyres: THREE.BufferGeometry; len: number }

function carModel(profile: [number, number][], greenhouse: [number, number][], width: number, wheelR: number): CarModel {
  const len = Math.max(...profile.map((p) => p[0]));
  const extrude = (pts: [number, number][], depth: number, bevel: number) => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 });
    g.translate(-len / 2, 0, -depth / 2);
    return g;
  };
  const body = extrude(profile, width - 0.16, 0.08);
  const glass = extrude(greenhouse, width - 0.1, 0);
  const wheels: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const w = new THREE.CylinderGeometry(wheelR, wheelR, 0.24, 14);
      w.rotateX(Math.PI / 2);
      w.translate(sx * (len / 2 - 0.85), wheelR, sz * (width / 2 - 0.12));
      wheels.push(w);
    }
  return { body, glass, tyres: mergeGeometries(wheels), len };
}

/** Three silhouettes matching the photos: sedan (Lacetti/Cobalt), compact SUV, small hatch (Matiz). */
export function carModels(): CarModel[] {
  return [
    carModel(
      [[0, 0.35], [0, 0.72], [0.2, 0.88], [1.15, 0.98], [1.75, 1.4], [3.05, 1.43], [3.8, 1.02], [4.45, 0.95], [4.55, 0.7], [4.55, 0.35]],
      [[1.2, 0.99], [1.76, 1.38], [3.04, 1.4], [3.76, 1.02]], 1.78, 0.32,
    ),
    carModel(
      [[0, 0.42], [0, 0.88], [0.25, 1.05], [1.05, 1.12], [1.6, 1.62], [3.75, 1.66], [4.25, 1.2], [4.45, 1.1], [4.45, 0.42]],
      [[1.1, 1.14], [1.62, 1.58], [3.72, 1.6], [4.18, 1.18]], 1.85, 0.36,
    ),
    carModel(
      [[0, 0.33], [0, 0.75], [0.25, 0.92], [0.85, 1.0], [1.35, 1.48], [3.25, 1.5], [3.45, 0.95], [3.5, 0.33]],
      [[0.9, 1.01], [1.37, 1.44], [3.2, 1.45], [3.38, 1.0]], 1.55, 0.29,
    ),
  ];
}

const CAR_COLORS = [
  { c: 0xf4f4f2, p: 0.56 }, { c: 0xb9bdc2, p: 0.14 }, { c: 0x16181c, p: 0.14 },
  { c: 0x5b6068, p: 0.1 }, { c: 0x1f3352, p: 0.06 },
];
export function carColor(r: number) {
  let acc = 0;
  for (const k of CAR_COLORS) {
    acc += k.p;
    if (r < acc) return new THREE.Color(k.c);
  }
  return new THREE.Color(CAR_COLORS[0].c);
}

/** Box truck (Isuzu-style delivery truck), length along +x with the cab at +x; rear doors at x = 0. */
export function truckModel() {
  const box = new THREE.BoxGeometry(5.6, 2.7, 2.4);
  box.translate(2.8, 0.75 + 1.35, 0);
  const chassis = new THREE.BoxGeometry(7.6, 0.3, 2.0);
  chassis.translate(3.8, 0.6, 0);
  const cab = new THREE.BoxGeometry(1.9, 2.1, 2.3);
  cab.translate(6.65, 0.75 + 1.05, 0);
  const glass = new THREE.BoxGeometry(0.06, 0.85, 2.0);
  glass.translate(7.62, 2.25, 0);
  const wheels: THREE.BufferGeometry[] = [];
  for (const x of [1.4, 2.6, 6.6])
    for (const z of [-1, 1]) {
      const w = new THREE.CylinderGeometry(0.48, 0.48, 0.32, 14);
      w.rotateX(Math.PI / 2);
      w.translate(x, 0.48, z * 1.0);
      wheels.push(w);
    }
  return { box: mergeGeometries([box, chassis]), cab, glass, tyres: mergeGeometries(wheels) };
}

// ---------- props ----------
export function lampGeometry() {
  const pole = new THREE.CylinderGeometry(0.08, 0.12, 8, 8);
  pole.translate(0, 4, 0);
  const arm = new THREE.BoxGeometry(1.6, 0.08, 0.08);
  arm.translate(0.75, 7.9, 0);
  return mergeGeometries([pole, arm]);
}
export function lampHead() {
  const head = new THREE.BoxGeometry(0.7, 0.14, 0.32);
  head.translate(1.45, 7.85, 0);
  return head;
}

export function treeGeometries() {
  const trunk = new THREE.CylinderGeometry(0.14, 0.2, 2.6, 7);
  trunk.translate(0, 1.3, 0);
  const a = new THREE.IcosahedronGeometry(1.9, 1);
  a.translate(0, 3.9, 0);
  const b = new THREE.IcosahedronGeometry(1.4, 1);
  b.translate(0.7, 4.9, 0.3);
  return { trunk, crown: mergeGeometries([a, b]) };
}

function inside(x: number, z: number, r: Rect, pad = 0) {
  return x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;
}

export interface Site {
  root: THREE.Group;
  /** ground-level objects to hide when the basement is opened */
  surface: THREE.Group;
}

export function buildSite(m: CampusMaterials, inst: Instancer): Site {
  const root = new THREE.Group();
  root.name = "campus-site";
  const surface = new THREE.Group();
  surface.name = "campus-surface";
  root.add(surface);

  const flat = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    surface.add(mesh);
    return mesh;
  };

  // Base concrete/paving across the campus footprint.
  const b = CAMPUS_BOUNDS;
  flat(groundPlaneM(b.x1 - b.x0, 60 - b.z0), m.paving, (b.x0 + b.x1) / 2, 0.0, (b.z0 + 60) / 2);

  for (const r of ROADS) flat(groundPlaneM(r.x1 - r.x0, r.z1 - r.z0), m.asphalt, (r.x0 + r.x1) / 2, 0.03, (r.z0 + r.z1) / 2);

  for (const w of WALKS) {
    const walk = new THREE.Mesh(new THREE.BoxGeometry(w.x1 - w.x0, 0.15, w.z1 - w.z0), m.paving);
    walk.position.set((w.x0 + w.x1) / 2, 0.075, (w.z0 + w.z1) / 2);
    walk.receiveShadow = true;
    surface.add(walk);
  }

  // ---- markings
  const dash = (x: number, z: number, along: "x" | "z", len: number, mat: THREE.Material, wid = 0.15) =>
    inst.add(mat === m.marking ? "mark" : "mark-y", UNIT.box, mat, { x, y: 0.065, z },
      along === "x" ? { x: len, y: 0.01, z: wid } : { x: wid, y: 0.01, z: len }, {}, null, { cast: false, receive: true });

  for (const r of ROADS) {
    if (!r.centerLine) continue;
    if (r.id === "m37") {
      for (let x = r.x0; x < r.x1; x += 9) {
        dash(x, 70.5, "x", 3, m.marking);
        dash(x, 79.5, "x", 3, m.marking);
      }
      dash((r.x0 + r.x1) / 2, 74.85, "x", r.x1 - r.x0, m.marking, 0.12);
      dash((r.x0 + r.x1) / 2, 75.15, "x", r.x1 - r.x0, m.marking, 0.12);
      continue;
    }
    if (r.centerLine === "x") {
      const zc = (r.z0 + r.z1) / 2;
      for (let x = r.x0 + 2; x < r.x1 - 2; x += 9) dash(x + 1.5, zc, "x", 3, m.marking);
      // yellow edge line along the curb (photos 4–7)
      dash((r.x0 + r.x1) / 2, r.z1 - 0.5, "x", r.x1 - r.x0, m.markingYellow);
    } else {
      const xc = (r.x0 + r.x1) / 2;
      for (let z = r.z0 + 2; z < r.z1 - 2; z += 9) dash(xc, z + 1.5, "z", 3, m.marking);
    }
  }

  // ---- parking bays + vehicles
  const models = carModels();
  let bay = 0;
  for (const row of PARKING) {
    for (let x = row.x0; x <= row.x1 + 1e-6; x += 2.6) dash(x, row.z, "z", 5, m.marking, 0.12);
    for (let x = row.x0 + 1.3; x < row.x1; x += 2.6, bay++) {
      if (hash(bay) > row.fill) continue;
      const type = hash(bay + 0.37) < 0.45 ? 0 : hash(bay + 0.37) < 0.85 ? 1 : 2;
      const mdl = models[type];
      // nose into the bay; slight jitter so the rows do not look stamped
      const rotY = (row.facing === 1 ? -Math.PI / 2 : Math.PI / 2) + (hash(bay + 0.9) - 0.5) * 0.08;
      const pos = { x: x + (hash(bay + 0.5) - 0.5) * 0.25, y: 0.03, z: row.z + (hash(bay + 0.2) - 0.5) * 0.3 };
      inst.add(`car-body-${type}`, mdl.body, m.carBody, pos, undefined, { y: rotY }, carColor(hash(bay + 0.71)));
      inst.add(`car-glass-${type}`, mdl.glass, m.carGlass, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
      inst.add(`car-tyre-${type}`, mdl.tyres, m.tyre, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
    }
  }

  // ---- lamps
  const lamp = lampGeometry(), head = lampHead();
  const addLamp = (x: number, z: number, rotY: number) => {
    inst.add("lamp", lamp, m.pole, { x, y: 0, z }, undefined, { y: rotY }, null, { cast: true, receive: false });
    inst.add("lamp-head", head, m.lamp, { x, y: 0, z }, undefined, { y: rotY }, null, { cast: false, receive: false });
  };
  for (let x = -200; x < 630; x += 32) {
    if (x > 44 && x < 64) continue;
    addLamp(x, 61.2, -Math.PI / 2);
    addLamp(x + 16, 88.8, Math.PI / 2);
  }
  for (let x = 70; x < 440; x += 28) {
    addLamp(x, 5.6, -Math.PI / 2);
    addLamp(x + 14, -77.4, Math.PI / 2);
  }
  for (const [x, z] of [[-36, 31], [-10, 31], [16, 31], [40, 31], [30, -20], [30, -50]]) addLamp(x, z, 0);

  // ---- trees: along M37 (both walks) and a few on the far side of the yard
  const { trunk, crown } = treeGeometries();
  let ti = 0;
  const addTree = (x: number, z: number) => {
    const s = 0.85 + hash(ti++) * 0.4;
    inst.add("tree-trunk", trunk, m.trunk, { x, y: 0.15, z }, { x: s, y: s, z: s });
    inst.add("tree-crown", crown, m.leaves, { x, y: 0.15, z }, { x: s, y: s, z: s }, { y: hash(ti) * 6 },
      new THREE.Color().setHSL(0.24 + hash(ti + 3) * 0.05, 0.35, 0.3 + hash(ti + 5) * 0.08));
  };
  for (let x = -210; x < 630; x += 11) {
    if (!(x > 42 && x < 66)) addTree(x + 5, 63);
    addTree(x, 87);
  }

  // ---- surrounding context: low residential blocks (satellite), muted, outside the campus
  const houseBody = new THREE.BoxGeometry(1, 1, 1);
  houseBody.translate(0, 0.5, 0);
  const houseRoof = new THREE.ConeGeometry(0.72, 0.45, 4);
  houseRoof.rotateY(Math.PI / 4);
  houseRoof.translate(0, 1.22, 0);
  const keepOut: Rect[] = [{ x0: CAMPUS_BOUNDS.x0 - 8, x1: CAMPUS_BOUNDS.x1 + 8, z0: CAMPUS_BOUNDS.z0 - 8, z1: 92 }, STORE_DISTRICT];
  let hi = 0;
  for (let x = -330; x < 760; x += 17) {
    for (let z = -330; z < 260; z += 17) {
      hi++;
      const jx = x + (hash(hi) - 0.5) * 6, jz = z + (hash(hi + 0.3) - 0.5) * 6;
      if (keepOut.some((r) => inside(jx, jz, r))) continue;
      if (hash(hi + 0.6) < 0.38) continue; // gardens / gaps
      const w = 9 + hash(hi + 0.1) * 5, d = 8 + hash(hi + 0.2) * 5, h = 3.4 + hash(hi + 0.4) * 2.4;
      // Context only: low contrast so the SAG campus stays the subject.
      const wall = new THREE.Color().setHSL(0.09, 0.1, 0.7 + hash(hi + 0.8) * 0.08);
      const roofHue = hash(hi + 0.9);
      const roofCol = new THREE.Color(roofHue < 0.4 ? 0x9a7468 : roofHue < 0.8 ? 0x8d9095 : 0x7c8577).multiplyScalar(0.9 + hash(hi + 0.95) * 0.15);
      inst.add("house", houseBody, m.white, { x: jx, y: 0, z: jz }, { x: w, y: h, z: d }, {}, wall, { cast: true, receive: true });
      inst.add("house-roof", houseRoof, m.white, { x: jx, y: 0, z: jz }, { x: w, y: h, z: d }, {}, roofCol, { cast: false, receive: true });
    }
  }

  return { root, surface };
}
