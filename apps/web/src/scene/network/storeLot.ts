// The site around a store (visual system v2): forecourt with planters, parking with painted bays and cars, a drive
// aisle, landscaped side strips with trees, a fenced loading yard with a delivery truck, lamps and a SAG totem sign.
// Static surfaces are merged per material (Batch); repeated props go through the district's Instancer, so a lot adds
// only a few draw calls however many stores use it. Prop placement is deterministic per store (no randomness on load).
import * as THREE from "three";
import { Batch } from "../campus/batch";
import type { Instancer } from "../campus/instancer";
import { campusMaterials } from "../campus/materials";
import { carColor, carModels, lampGeometry, lampHead, treeGeometries } from "../campus/site";
import { logoTexture, type StoreLook } from "./storeLooks";

const lotMaterials = campusMaterials;

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function canvas(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, repeat = false) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  paint(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

let K: ReturnType<typeof createKit> | null = null;
function createKit() {
  const fenceTex = canvas(64, 64, (g) => {
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = "#c5ccd2";
    g.lineWidth = 3;
    for (let i = -64; i < 128; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke();
      g.beginPath(); g.moveTo(i + 64, 0); g.lineTo(i, 64); g.stroke();
    }
  }, true);
  fenceTex.repeat.set(1 / 0.6, 1 / 0.6);
  const hatch = canvas(64, 64, (g) => {
    g.fillStyle = "#e8c34a";
    for (let i = -64; i < 128; i += 22) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 10, 0); g.lineTo(i + 74, 64); g.lineTo(i + 64, 64); g.fill();
    }
  }, true);
  hatch.repeat.set(1 / 1.6, 1 / 1.6);
  const pSign = canvas(64, 64, (g) => {
    g.fillStyle = "#1e5fb4"; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = "#ffffff"; g.lineWidth = 4; g.strokeRect(4, 4, 56, 56);
    g.fillStyle = "#ffffff"; g.font = "bold 46px Arial, sans-serif"; g.textAlign = "center"; g.fillText("P", 32, 49);
  });
  const wheelchair = canvas(64, 64, (g) => {
    g.fillStyle = "#2f6fc0"; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = "#ffffff"; g.lineWidth = 5;
    g.beginPath(); g.arc(30, 40, 13, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#ffffff"; g.beginPath(); g.arc(30, 14, 5, 0, Math.PI * 2); g.fill();
  });
  return {
    fence: new THREE.MeshStandardMaterial({ map: fenceTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6 }),
    fencePost: new THREE.MeshStandardMaterial({ color: 0x8c949c, roughness: 0.45, metalness: 0.7 }),
    hatch: new THREE.MeshStandardMaterial({ map: hatch, transparent: true, depthWrite: false, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }),
    pSign: new THREE.MeshStandardMaterial({ map: pSign, roughness: 0.5 }),
    access: new THREE.MeshStandardMaterial({ map: wheelchair, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }),
    totem: new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.45, metalness: 0.5 }),
    totemFace: new THREE.MeshStandardMaterial({ color: 0xf7f7f5, roughness: 0.4, emissive: 0xffffff, emissiveIntensity: 0.12 }),
    logo: new THREE.MeshBasicMaterial({ map: logoTexture(), transparent: true, depthWrite: false, toneMapped: false }),
    own: new THREE.MeshStandardMaterial({ color: 0x1b4e9b, roughness: 0.4, metalness: 0.2 }),
    franchise: new THREE.MeshStandardMaterial({ color: 0xd99a2b, roughness: 0.4, metalness: 0.2 }),
    bollard: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.5 }),
    truckBox: new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5, metalness: 0.1 }),
    truckCab: new THREE.MeshStandardMaterial({ color: 0x1b4e9b, roughness: 0.3, metalness: 0.5 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.85 }),
  };
}
export const lotKit = () => (K ??= createKit());

// shared prop geometries
let G: ReturnType<typeof createGeos> | null = null;
function createGeos() {
  const shrub = new THREE.IcosahedronGeometry(0.55, 1);
  shrub.scale(1, 0.75, 1);
  shrub.translate(0, 0.38, 0);
  const bollard = new THREE.CylinderGeometry(0.11, 0.11, 0.9, 10);
  bollard.translate(0, 0.45, 0);
  const post = new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6);
  post.translate(0, 1.1, 0);
  return { shrub, bollard, post, cars: carModels(), lamp: lampGeometry(), lampHead: lampHead(), tree: treeGeometries() };
}
const geos = () => (G ??= createGeos());

export interface LotSpec {
  /** cell centre and size */
  cx: number; cz: number; cellW: number; cellD: number;
  /** building centre z (front faces +z) */
  bz: number;
  look: StoreLook;
  own: boolean;
  seed: number;
}

const TOP = 0.5;

/** Builds the lot surfaces into `batch` (merged later) and the props into `inst`. */
export function buildStoreLot(s: LotSpec, batch: Batch, inst: Instancer) {
  const m = lotMaterials(), k = lotKit(), g = geos();
  const { cx, cz, look } = s;
  const x0 = cx - s.cellW / 2 + 1, x1 = cx + s.cellW / 2 - 1, z0 = cz - s.cellD / 2 + 1, z1 = cz + s.cellD / 2 - 1;
  const bw = look.w, fz = s.bz + look.d / 2, rz = s.bz - look.d / 2;
  const bx0 = cx - bw / 2 - 1.2, bx1 = cx + bw / 2 + 1.2;
  const walkZ = fz + 2.6, bayZ = walkZ + 5, aisleZ = z1 - 1.6;
  const slab = (ax0: number, ax1: number, az0: number, az1: number, mat: THREE.Material, top = TOP) =>
    batch.box(ax1 - ax0, top - 0.38, az1 - az0, mat, (ax0 + ax1) / 2, 0.38, (az0 + az1) / 2, 0, false);
  const line = (x: number, z: number, w: number, d: number, mat: THREE.Material = m.marking) =>
    batch.box(w, 0.02, d, mat, x, TOP, z, 0, false);
  let n = s.seed * 97;
  const r = () => hash(n++);

  // ---- surfaces (non-overlapping rectangles, so nothing z-fights)
  slab(x0, x1, walkZ, aisleZ, m.asphalt); // parking + drive aisle
  // front verge with a driveway cut at the right-hand corner, and its dropped kerb across the block sidewalk
  slab(x0, x1 - 8, aisleZ, z1, m.grass, TOP + 0.04);
  slab(x1 - 2, x1, aisleZ, z1, m.grass, TOP + 0.04);
  slab(x1 - 8, x1 - 2, aisleZ, z1, m.asphalt);
  batch.box(6, 0.1, 4.2, m.asphalt, x1 - 5, 0.42, z1 + 2.1, 0, false);
  batch.add(new THREE.BoxGeometry(6, 0.1, 1.2), m.asphalt, { x: x1 - 5, y: 0.27, z: z1 + 4.7 }, { x: 0.36 }, false);
  slab(x0, x1, z0, rz - 0.01, m.asphalt); // loading yard
  slab(x0, bx0, rz - 0.01, walkZ, m.grass, TOP + 0.04); // side strips
  slab(bx1, x1, rz - 0.01, walkZ, m.grass, TOP + 0.04);
  slab(bx0, bx1, fz, walkZ, m.paving, TOP + 0.14); // forecourt, raised behind a curb
  slab(bx0, bx1, rz - 0.01, fz, m.concrete, TOP + 0.02); // under the building / apron
  batch.box(bx1 - bx0, 0.18, 0.22, m.curb, cx, 0.46, walkZ + 0.11, 0, false);
  for (const sx of [bx0, bx1]) batch.box(0.22, 0.2, walkZ - rz, m.curb, sx, 0.44, (walkZ + rz) / 2, 0, false);
  batch.box(x1 - x0, 0.16, 0.22, m.curb, cx, 0.44, aisleZ, 0, false);

  // ---- parking bays along the forecourt, a zebra crossing to the entrance and one accessible bay
  const cross = [cx - 2.4, cx + 2.4];
  let bay = 0;
  for (let x = x0 + 0.6; x + 2.6 <= x1 - 0.4; x += 2.6) {
    if (x + 2.6 > cross[0] && x < cross[1]) continue;
    line(x, walkZ + 2.5, 0.12, 4.8);
    line(x + 2.6, walkZ + 2.5, 0.12, 4.8);
    const access = bay === 0 && x + 2.6 <= cross[0] && cross[0] - (x + 2.6) < 2.7;
    if (access) batch.add(new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2), k.access, { x: x + 1.3, y: TOP + 0.03, z: walkZ + 2.5 }, {}, false);
    else if (r() < 0.62) {
      const type = r() < 0.45 ? 0 : r() < 0.8 ? 1 : 2;
      const mdl = g.cars[type];
      const pos = { x: x + 1.3 + (r() - 0.5) * 0.2, y: TOP, z: walkZ + 2.4 + (r() - 0.5) * 0.3 };
      const rotY = Math.PI / 2 + (r() - 0.5) * 0.08;
      inst.add(`lot-car-body-${type}`, mdl.body, m.carBody, pos, undefined, { y: rotY }, carColor(r()));
      inst.add(`lot-car-glass-${type}`, mdl.glass, m.carGlass, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
      inst.add(`lot-car-tyre-${type}`, mdl.tyres, m.tyre, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
    }
    bay++;
  }
  for (let x = cross[0] + 0.3; x < cross[1]; x += 0.9) line(x + 0.25, walkZ + 2.5, 0.5, 4.6);
  // drive aisle: centre dashes and a stop line at the exit
  for (let x = x0 + 2; x < x1 - 2; x += 6) line(x + 1.25, (bayZ + aisleZ) / 2, 2.5, 0.12);

  // ---- forecourt: planters either side of the entrance, bollards on the curb
  for (const side of [-1, 1]) {
    const px = cx + side * 6.2;
    batch.box(3.6, 0.5, 1.3, m.concrete, px, TOP + 0.14, fz + 1.1);
    batch.box(3.3, 0.04, 1.0, m.mulch, px, TOP + 0.64, fz + 1.1, 0, false);
    for (let i = -1; i <= 1; i++)
      inst.add("lot-shrub", g.shrub, m.shrub, { x: px + i * 1.05, y: TOP + 0.62, z: fz + 1.1 }, { x: 0.9, y: 0.9 + r() * 0.3, z: 0.9 }, { y: r() * 6 },
        new THREE.Color().setHSL(0.25 + r() * 0.04, 0.45, 0.32 + r() * 0.06));
  }
  for (const bx of [cx - 2.2, cx - 0.75, cx + 0.75, cx + 2.2])
    inst.add("lot-bollard", g.bollard, k.bollard, { x: bx, y: TOP + 0.14, z: walkZ - 0.3 });

  // ---- landscaping: hedges and shrubs along the side walls, trees in the strips and on the verge
  const tree = (x: number, z: number, sc = 1) => {
    const s2 = sc * (0.8 + r() * 0.35);
    inst.add("lot-tree-trunk", g.tree.trunk, m.trunk, { x, y: TOP, z }, { x: s2, y: s2, z: s2 });
    inst.add("lot-tree-crown", g.tree.crown, m.leaves, { x, y: TOP, z }, { x: s2, y: s2, z: s2 }, { y: r() * 6 },
      new THREE.Color().setHSL(0.23 + r() * 0.06, 0.42, 0.3 + r() * 0.08));
  };
  for (const [sx0, sx1] of [[x0, bx0], [bx1, x1]]) {
    const wStrip = sx1 - sx0;
    if (wStrip < 1.5) continue;
    const tx = (sx0 + sx1) / 2;
    for (let z = rz + 1.5; z < walkZ - 1; z += 5.5) tree(tx + (r() - 0.5) * Math.max(0, wStrip - 3), z, 0.85);
    for (let z = rz + 0.8; z < fz; z += 1.3) {
      const hx = sx0 === x0 ? sx1 - 0.6 : sx0 + 0.6; // shrub line hugging the wall
      inst.add("lot-shrub", g.shrub, m.hedge, { x: hx, y: TOP + 0.04, z }, { x: 1, y: 0.8 + r() * 0.3, z: 1.1 }, { y: r() * 6 });
    }
  }
  for (let x = x0 + 2; x < x1 - 1; x += 7.5) {
    if (Math.abs(x - (x1 - 5)) < 4) continue; // keep the driveway corner open
    tree(x + r() * 1.5, (aisleZ + z1) / 2, 0.9);
  }

  // ---- lamps over the parking, a P sign at the entrance, the totem at the corner
  for (const lx of [x0 + 0.6, x1 - 0.6]) {
    const rot = lx < cx ? 0 : Math.PI;
    inst.add("lot-lamp", g.lamp, m.pole, { x: lx, y: TOP, z: (walkZ + aisleZ) / 2 }, { x: 0.8, y: 0.8, z: 0.8 }, { y: rot }, null, { cast: true, receive: false });
    inst.add("lot-lamp-head", g.lampHead, m.lamp, { x: lx, y: TOP, z: (walkZ + aisleZ) / 2 }, { x: 0.8, y: 0.8, z: 0.8 }, { y: rot }, null, { cast: false, receive: false });
  }
  inst.add("lot-post", g.post, k.fencePost, { x: x1 - 1.2, y: TOP + 0.04, z: aisleZ + 0.7 });
  batch.box(0.7, 0.7, 0.04, k.pSign, x1 - 1.2, TOP + 2.2, aisleZ + 0.73, 0, false);

  const tx = x0 + 2.2, tz = z1 - 0.8, th = 6.2;
  batch.box(1.9, th, 0.55, k.totem, tx, TOP + 0.04, tz);
  batch.box(1.6, 1.0, 0.6, s.own ? k.own : k.franchise, tx, TOP + 0.4, tz);
  for (const side of [1, -1]) {
    batch.plane(1.6, 3.7, k.totemFace, tx, TOP + th - 2.25, tz + side * 0.29, side > 0 ? 0 : Math.PI);
    batch.plane(1.5, 1.5 / (915 / 298), k.logo, tx, TOP + th - 1.6, tz + side * 0.3, side > 0 ? 0 : Math.PI);
  }

  // ---- loading yard: hatched bay, dock door with bumpers, a delivery truck, chain-link fence around the back
  const dockX = cx + bw / 4;
  batch.add(new THREE.PlaneGeometry(4.2, Math.max(2, rz - z0 - 0.6)).rotateX(-Math.PI / 2), k.hatch, { x: dockX, y: TOP + 0.02, z: (z0 + rz) / 2 }, {}, false);
  if (rz - z0 > 3.2) {
    // box truck parked along the dock, nose to the -x side
    const ty = TOP + 0.45, tzc = z0 + (rz - z0) / 2;
    const ttx = dockX - 1.5;
    batch.box(5.2, 2.6, 2.3, k.truckBox, ttx + 0.9, ty, tzc);
    batch.box(1.9, 2.0, 2.2, k.truckCab, ttx - 2.7, ty, tzc);
    batch.box(1.4, 0.9, 2.18, m.carGlass, ttx - 2.8, ty + 1.05, tzc, 0, false);
    for (const wx of [ttx - 2.6, ttx + 0.2, ttx + 2.6])
      for (const wz of [-1, 1])
        batch.add(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 14).rotateX(Math.PI / 2), k.rubber, { x: wx, y: TOP + 0.45, z: tzc + wz * 1.05 });
  }
  const fenceH = 2.2;
  const fenceRun = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const rot = Math.atan2(-(bz - az), bx - ax);
    const geo = new THREE.PlaneGeometry(len, fenceH);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * fenceH);
    batch.add(geo, k.fence, { x: (ax + bx) / 2, y: TOP + fenceH / 2, z: (az + bz) / 2 }, { y: rot }, true);
    const posts = Math.max(1, Math.round(len / 2.5));
    for (let i = 0; i <= posts; i++)
      inst.add("lot-post", g.post, k.fencePost, { x: ax + ((bx - ax) * i) / posts, y: TOP, z: az + ((bz - az) * i) / posts });
  };
  // rear edge with a gate opening on the dock side, and both sides of the yard
  fenceRun(x0, z0, dockX - 3, z0);
  fenceRun(dockX + 3, z0, x1, z0);
  fenceRun(x0, z0, x0, rz);
  fenceRun(x1, z0, x1, rz);
}

// ---- district fabric: each region block with sidewalks, street trees and corner lamps (streets: world/roadRender.ts)

interface Span { x0: number; x1: number }

/**
 * A region block: lawn, a 3 m sidewalk round it behind a kerb, street trees along it. `avoid` keeps trees off the
 * driveways on the front sidewalk and off the loading gates on the rear one.
 */
export function buildRegionPlot(x0: number, z0: number, w: number, d: number, batch: Batch, inst: Instancer, seed: number,
  avoid: { front: Span[]; rear: Span[] } = { front: [], rear: [] }) {
  const m = lotMaterials(), g = geos();
  const x1 = x0 + w, z1 = z0 + d, sw = 3;
  batch.box(w, 0.44, d, m.grass, x0 + w / 2, 0, z0 + d / 2, 0, false);
  batch.box(w, 0.06, sw, m.paving, x0 + w / 2, 0.44, z0 + sw / 2, 0, false);
  batch.box(w, 0.06, sw, m.paving, x0 + w / 2, 0.44, z1 - sw / 2, 0, false);
  batch.box(sw, 0.06, d - 2 * sw, m.paving, x0 + sw / 2, 0.44, z0 + d / 2, 0, false);
  batch.box(sw, 0.06, d - 2 * sw, m.paving, x1 - sw / 2, 0.44, z0 + d / 2, 0, false);
  batch.box(w + 0.3, 0.52, 0.3, m.curb, x0 + w / 2, 0, z0 - 0.15, 0, false);
  batch.box(w + 0.3, 0.52, 0.3, m.curb, x0 + w / 2, 0, z1 + 0.15, 0, false);
  batch.box(0.3, 0.52, d, m.curb, x0 - 0.15, 0, z0 + d / 2, 0, false);
  batch.box(0.3, 0.52, d, m.curb, x1 + 0.15, 0, z0 + d / 2, 0, false);
  let n = seed * 131;
  const r = () => hash(n++);
  const tree = (x: number, z: number) => {
    const s2 = 0.75 + r() * 0.3;
    inst.add("lot-tree-trunk", g.tree.trunk, m.trunk, { x, y: 0.5, z }, { x: s2, y: s2, z: s2 });
    inst.add("lot-tree-crown", g.tree.crown, m.leaves, { x, y: 0.5, z }, { x: s2, y: s2, z: s2 }, { y: r() * 6 },
      new THREE.Color().setHSL(0.22 + r() * 0.07, 0.42, 0.3 + r() * 0.08));
  };
  const clear = (x: number, spans: Span[]) => !spans.some((s) => x > s.x0 - 1.5 && x < s.x1 + 1.5);
  for (let x = x0 + 5; x < x1 - 3; x += 11) {
    if (clear(x, avoid.rear)) tree(x, z0 + 0.9);
    if (clear(x + 5.5, avoid.front)) tree(x + 5.5, z1 - 0.9);
  }
  for (let z = z0 + 8; z < z1 - 6; z += 11) {
    tree(x0 + 0.9, z);
    tree(x1 - 0.9, z + 5.5);
  }
}

/** Street lamps on the four corners of a block, arms reaching over the junctions. */
export function buildBlockLamps(x0: number, z0: number, w: number, d: number, inst: Instancer) {
  const m = lotMaterials(), g = geos();
  for (const [x, z, sx, sz] of [[x0 + 1, z0 + 1, -1, -1], [x0 + w - 1, z0 + 1, 1, -1], [x0 + 1, z0 + d - 1, -1, 1], [x0 + w - 1, z0 + d - 1, 1, 1]]) {
    const rot = Math.atan2(-sz, sx);
    inst.add("lot-lamp", g.lamp, m.pole, { x, y: 0.5, z }, undefined, { y: rot }, null, { cast: true, receive: false });
    inst.add("lot-lamp-head", g.lampHead, m.lamp, { x, y: 0.5, z }, undefined, { y: rot }, null, { cast: false, receive: false });
  }
}
