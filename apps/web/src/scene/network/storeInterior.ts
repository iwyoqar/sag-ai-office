// SAG store interior, modelled after the owner's photos of a SAG Home Design store (2026-10-30): mustard-terracotta
// walls, large grey floor tiles, blue reception wall with the white logo and a brown counter with blue underglow,
// carpets hanging in orange wooden frames, roll racks with a blue fascia, low black metal display platforms with
// stacked carpets, a consultation corner (desks, monitors on stands, blue armchairs, glass table), tapestry pictures
// in white ornate frames, square LED light frames and, in larger stores, a green kids corner.
// Shown as a doll-house cut-away: back and side walls full height, front wall low. Same standard in every store,
// scaled to the building footprint.
import * as THREE from "three";
import { logoTexture } from "./storeLooks";

export interface Rect { x0: number; x1: number; z0: number; z1: number }

/** Where a person stands, facing `yaw` (0 = towards the entrance / +z). */
export interface Spot { pos: THREE.Vector3; yaw: number }

export interface BuiltInterior {
  group: THREE.Group;
  /** the AI Director's place: at a consultation desk with a monitor */
  aiSpot: Spot;
  /** people's places in order of preference: consultant desk, reception, aisles */
  spots: Spot[];
}

const C = {
  wall: 0xd08b3c, // mustard-terracotta from the photos
  baseboard: 0x9ca3a6,
  frameWood: 0xb4561d,
  blue: 0x1d4fbf,
  counter: 0x9a4a22,
  metal: 0x1d1f22,
  deskTop: 0xf1f0ec,
  deskBody: 0xb8bcbd,
  chair: 0x1f3c78,
  kidsGreen: 0x8fbf8a,
  hedge: 0x2f6b2a,
  plant: 0x3f7f3a,
  pot: 0xe9ebec,
};
const FLOOR = 0.62; // top of the interior floor (plot surface + slab)

// ---- canvas textures (cached) --------------------------------------------------------------------------------
const cache = new Map<string, THREE.CanvasTexture>();
function canvasTex(key: string, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  let t = cache.get(key);
  if (!t) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    paint(c.getContext("2d")!);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    cache.set(key, t);
  }
  if (!repeat) return t;
  const r = t.clone();
  r.needsUpdate = true;
  r.repeat.set(repeat[0], repeat[1]);
  return r;
}

const rnd = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** Large grey stone-look floor tiles (one tile = 1.2 m). */
const tileTex = (rx: number, rz: number) =>
  canvasTex("tile", 256, 256, (g) => {
    g.fillStyle = "#c9cdcf";
    g.fillRect(0, 0, 256, 256);
    const r = rnd(7);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? "255,255,255" : "90,95,100"},${0.05 + r() * 0.06})`;
      g.fillRect(r() * 256, r() * 256, 2 + r() * 6, 2 + r() * 6);
    }
    g.strokeStyle = "#a9aeb1";
    g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
  }, [rx, rz]);

/** Persian-style carpet: field, medallion, borders. A few palettes so neighbouring carpets differ. */
const CARPET_PALETTES = [
  ["#e9e4da", "#8a8f99", "#3d4656", "#c7b98f"],
  ["#f1efe9", "#a7a9ad", "#5a6475", "#d9cfb6"],
  ["#2b3442", "#c8ccd2", "#e9e6df", "#8c7b5a"],
  ["#dfe3e6", "#5f7f5a", "#2f4f3a", "#c9c0a5"],
  ["#ece7dc", "#7b8aa3", "#24324a", "#b9a77a"],
  ["#d9d4c8", "#9c6b4e", "#4f3326", "#e8dcc2"],
];
function carpetTex(i: number) {
  const p = CARPET_PALETTES[i % CARPET_PALETTES.length];
  return canvasTex(`carpet${i % CARPET_PALETTES.length}`, 256, 384, (g) => {
    const W = 256, H = 384;
    g.fillStyle = p[0];
    g.fillRect(0, 0, W, H);
    // borders
    for (const [m, col, lw] of [[10, p[2], 8], [24, p[1], 10], [40, p[3], 4]] as const) {
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.strokeRect(m, m, W - 2 * m, H - 2 * m);
    }
    // field ornament dots
    const r = rnd(31 + i);
    g.fillStyle = p[1];
    for (let k = 0; k < 220; k++) g.fillRect(50 + r() * (W - 100), 50 + r() * (H - 100), 3, 3);
    // medallion
    g.save();
    g.translate(W / 2, H / 2);
    g.fillStyle = p[2];
    g.beginPath();
    g.ellipse(0, 0, 58, 90, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = p[3];
    g.beginPath();
    g.ellipse(0, 0, 34, 54, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = p[0];
    g.beginPath();
    g.moveTo(0, -30); g.lineTo(18, 0); g.lineTo(0, 30); g.lineTo(-18, 0);
    g.fill();
    g.restore();
  });
}

const ROLL_COLORS = ["#6b6f75", "#2e4f7a", "#c9ccd0", "#3c4a66", "#55595e", "#e0c22c", "#1e63c9", "#2f7d3a", "#3b8c3f", "#4f7a3a", "#a59a85", "#6d5e4c"];

/** Framed tapestry picture: sky, hills, a house — like the photo-tapestries on the shop walls. */
function pictureTex(i: number) {
  return canvasTex(`pic${i % 6}`, 256, 128, (g) => {
    const r = rnd(97 + i);
    const sky = g.createLinearGradient(0, 0, 0, 80);
    sky.addColorStop(0, ["#6fa8dc", "#f2b36b", "#9fc5e8", "#b4a7d6", "#76a5af", "#f6b26b"][i % 6]);
    sky.addColorStop(1, "#eef3f6");
    g.fillStyle = sky;
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = ["#6aa84f", "#38761d", "#93c47d", "#274e13", "#8fce00", "#6aa84f"][i % 6];
    g.beginPath();
    g.moveTo(0, 90);
    for (let x = 0; x <= 256; x += 32) g.lineTo(x, 70 + r() * 25);
    g.lineTo(256, 128); g.lineTo(0, 128);
    g.fill();
    const hx = 60 + r() * 120;
    g.fillStyle = "#f3e2c7";
    g.fillRect(hx, 62, 36, 26);
    g.fillStyle = "#a61c00";
    g.beginPath();
    g.moveTo(hx - 4, 62); g.lineTo(hx + 18, 46); g.lineTo(hx + 40, 62);
    g.fill();
  });
}

/** Multicoloured carpet tiles of the kids corner. */
const kidsTilesTex = () =>
  canvasTex("kids", 256, 256, (g) => {
    const cols = ["#7d8fa6", "#5e6f86", "#9aa6a0", "#6f8f6a", "#a46a4f", "#4f6fa8", "#b7b9b4", "#3f5f8a"];
    const r = rnd(5);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.fillRect(x * 32, y * 32, 32, 32);
    }
  });

/** Colourful road-map wall print of the kids corner. */
const kidsWallTex = () =>
  canvasTex("kidswall", 256, 128, (g) => {
    g.fillStyle = "#57b6c9";
    g.fillRect(0, 0, 256, 128);
    const r = rnd(11);
    g.strokeStyle = "#3a3a3a";
    g.lineWidth = 6;
    for (let k = 0; k < 6; k++) {
      g.beginPath();
      g.moveTo(0, r() * 128);
      g.bezierCurveTo(80, r() * 128, 170, r() * 128, 256, r() * 128);
      g.stroke();
    }
    for (let k = 0; k < 40; k++) {
      g.fillStyle = ["#e53935", "#fdd835", "#43a047", "#fb8c00"][k % 4];
      g.fillRect(r() * 250, r() * 120, 8, 5);
    }
  });

// ---- geometry helpers ----------------------------------------------------------------------------------------------
const mats = new Map<string, THREE.Material>();
function mat(color: number, rough = 0.8, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  const key = `${color}:${rough}:${JSON.stringify(extra)}`;
  let m = mats.get(key);
  if (!m) mats.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness: rough, ...extra })));
  return m;
}

/** Box with its BOTTOM at y. */
function box(g: THREE.Group, w: number, h: number, d: number, m: THREE.Material | THREE.Material[], x: number, y: number, z: number, shadow = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

function plane(g: THREE.Group, w: number, h: number, m: THREE.Material, x: number, y: number, z: number, rotY = 0, rotX = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rotX, rotY, 0);
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

/** Low black metal display platform with X-braced sides and a stack of carpets on top. */
function platform(g: THREE.Group, x: number, z: number, w: number, d: number, carpet: number) {
  const h = 0.55, t = 0.05, metal = mat(C.metal, 0.5, { metalness: 0.6 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, t, h, t, metal, x + sx * (w / 2 - t), FLOOR, z + sz * (d / 2 - t));
  box(g, w, t, t, metal, x, FLOOR + h - t, z - d / 2 + t);
  box(g, w, t, t, metal, x, FLOOR + h - t, z + d / 2 - t);
  for (const sz of [-1, 1]) {
    const brace = box(g, Math.hypot(w, h) * 0.98, t, t, metal, x, FLOOR + h / 2 - t / 2, z + sz * (d / 2 - t));
    brace.rotation.z = Math.atan2(h, w) * (sz > 0 ? 1 : -1);
  }
  // stacked carpets: coloured edges, the top one shows its pattern
  const stack = 4;
  for (let k = 0; k < stack; k++)
    box(g, w + 0.12, 0.05, d + 0.1, mat(new THREE.Color(CARPET_PALETTES[(carpet + k) % 6][k % 2 ? 1 : 0]).getHex(), 0.95), x, FLOOR + h + k * 0.05, z, false);
  const top = new THREE.MeshStandardMaterial({ map: carpetTex(carpet), roughness: 0.95 });
  plane(g, w + 0.1, d + 0.08, top, x, FLOOR + h + stack * 0.05 + 0.002, z, 0, -Math.PI / 2);
}

function armchair(g: THREE.Group, x: number, z: number, yaw: number) {
  const a = new THREE.Group();
  const fabric = mat(C.chair, 0.9), metal = mat(C.metal, 0.5, { metalness: 0.6 });
  box(a, 0.8, 0.42, 0.75, fabric, 0, 0.08, 0);
  box(a, 0.8, 0.45, 0.16, fabric, 0, 0.5, -0.3);
  for (const s of [-1, 1]) box(a, 0.12, 0.3, 0.75, fabric, s * 0.4, 0.5, 0);
  box(a, 0.86, 0.04, 0.8, metal, 0, 0.04, 0);
  a.position.set(x, FLOOR, z);
  a.rotation.y = yaw;
  g.add(a);
}

function deskWithMonitor(g: THREE.Group, x: number, z: number, yaw: number) {
  const d = new THREE.Group();
  box(d, 1.6, 0.05, 0.8, mat(C.deskTop, 0.4), 0, 0.72, 0);
  box(d, 1.5, 0.45, 0.04, mat(C.deskBody, 0.8), 0, 0.27, -0.36);
  for (const s of [-1, 1]) box(d, 0.05, 0.72, 0.75, mat(C.metal, 0.5), s * 0.76, 0, 0);
  box(d, 0.5, 0.32, 0.03, mat(0xf5f5f5, 0.3), -0.35, 0.8, -0.2); // all-in-one PC
  // big monitor on a mobile stand beside the desk
  box(d, 0.06, 1.3, 0.06, mat(C.metal, 0.5), 1.15, 0, -0.1);
  box(d, 0.6, 0.04, 0.5, mat(C.metal, 0.5), 1.15, 0, -0.1);
  box(d, 1.1, 0.66, 0.05, mat(C.metal, 0.4), 1.15, 1.2, -0.1);
  plane(d, 1.0, 0.58, new THREE.MeshBasicMaterial({ color: 0x9fb8e8 }), 1.15, 1.53, -0.07);
  armchairSmall(d, 0, -0.75);
  d.position.set(x, FLOOR, z);
  d.rotation.y = yaw;
  g.add(d);
}

function armchairSmall(g: THREE.Group, x: number, z: number) {
  box(g, 0.55, 0.45, 0.55, mat(C.chair, 0.9), x, 0, z);
  box(g, 0.55, 0.45, 0.1, mat(C.chair, 0.9), x, 0.45, z - 0.25);
}

function plant(g: THREE.Group, x: number, z: number, big = false) {
  const potH = big ? 0.6 : 0.4;
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, potH, 16), mat(C.pot, 0.4));
  pot.position.set(x, FLOOR + potH / 2, z);
  g.add(pot);
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(big ? 0.5 : 0.32, 0), mat(C.plant, 0.9, { flatShading: true }));
  leaves.position.set(x, FLOOR + potH + (big ? 0.45 : 0.28), z);
  leaves.scale.y = 1.3;
  leaves.castShadow = true;
  g.add(leaves);
}

/** Square LED light frame hanging under the (absent) ceiling. */
function ledFrame(g: THREE.Group, x: number, z: number, s: number, y: number) {
  const m = new THREE.MeshBasicMaterial({ color: 0xfff8e6 });
  for (const [w, d, dx, dz] of [[s, 0.08, 0, -s / 2], [s, 0.08, 0, s / 2], [0.08, s, -s / 2, 0], [0.08, s, s / 2, 0]] as const)
    box(g, w, 0.06, d, m, x + dx, y, z + dz, false);
}

// ---- the interior -------------------------------------------------------------------------------------------
export function buildStoreInterior(s: Rect): BuiltInterior {
  const g = new THREE.Group();
  const w = s.x1 - s.x0, d = s.z1 - s.z0, cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
  const base = 0.5;
  const wallM = mat(C.wall, 0.9);

  // floor: large grey tiles
  box(g, w, 0.12, d, new THREE.MeshStandardMaterial({ map: tileTex(w / 1.2, d / 1.2), roughness: 0.6 }), cx, base, cz, false);

  // walls: back and sides full height, front low with the entrance gap; grey skirting
  const wh = 3.2, t = 0.25, front = 0.7, gap = 3.2;
  box(g, w, wh, t, wallM, cx, base, s.z0 + t / 2);
  box(g, t, wh, d, wallM, s.x0 + t / 2, base, cz);
  box(g, t, wh, d, wallM, s.x1 - t / 2, base, cz);
  const side = (w - gap) / 2;
  box(g, side, front, t, wallM, s.x0 + side / 2, base, s.z1 - t / 2);
  box(g, side, front, t, wallM, s.x1 - side / 2, base, s.z1 - t / 2);
  box(g, w - 2 * t, 0.12, 0.03, mat(C.baseboard), cx, FLOOR, s.z0 + t + 0.015, false);

  // back wall, left part: carpets hanging in orange wooden frames
  const hangW = w * 0.56;
  const nHang = Math.max(2, Math.floor((hangW - 0.6) / 2.5));
  const pitchH = (hangW - 0.6) / nHang;
  for (let i = 0; i < nHang; i++) {
    const x = s.x0 + 0.5 + pitchH * (i + 0.5);
    box(g, pitchH - 0.1, 2.75, 0.1, mat(C.frameWood, 0.6), x, FLOOR + 0.05, s.z0 + t + 0.05);
    plane(g, pitchH - 0.4, 2.45, new THREE.MeshStandardMaterial({ map: carpetTex(i + 1), roughness: 0.95 }), x, FLOOR + 1.3, s.z0 + t + 0.11);
  }

  // back wall, right part: roll rack niche with blue fascia, wooden ladders, rolls lying across
  const rx0 = s.x0 + hangW + 0.4, rx1 = s.x1 - 0.5, rw = rx1 - rx0, rcx = (rx0 + rx1) / 2;
  box(g, rw + 0.4, 0.4, 0.5, mat(C.blue, 0.5), rcx, FLOOR + 2.65, s.z0 + t + 0.25);
  const cols = 2, colW = rw / cols;
  let rc = 0;
  for (let k = 0; k <= cols; k++) box(g, 0.1, 2.6, 0.12, mat(C.frameWood, 0.6), rx0 + colW * k, FLOOR, s.z0 + t + 0.65);
  for (let k = 0; k < cols; k++)
    for (let j = 0; j < 5; j++) {
      const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, colW - 0.25, 18), mat(new THREE.Color(ROLL_COLORS[rc++ % ROLL_COLORS.length]).getHex(), 0.95));
      roll.rotation.z = Math.PI / 2;
      roll.position.set(rx0 + colW * (k + 0.5), FLOOR + 0.3 + j * 0.46, s.z0 + t + 0.6 + (j % 2) * 0.06);
      roll.castShadow = true;
      g.add(roll);
    }

  // left wall: tapestry pictures in white ornate frames (two rows)
  const picZ0 = s.z0 + 2.2, picZ1 = s.z1 - 2.5;
  const nPic = Math.max(2, Math.floor((picZ1 - picZ0) / 1.9));
  for (let row = 0; row < 2; row++)
    for (let i = 0; i < nPic; i++) {
      const z = picZ0 + ((picZ1 - picZ0) / nPic) * (i + 0.5);
      const y = FLOOR + 1.35 + row * 1.05;
      box(g, 0.06, 0.9, 1.6, mat(0xf4f1ea, 0.4), s.x0 + t + 0.03, y - 0.45, z);
      plane(g, 1.4, 0.72, new THREE.MeshStandardMaterial({ map: pictureTex(i * 2 + row), roughness: 0.7 }), s.x0 + t + 0.07, y, z, Math.PI / 2);
    }

  // display platforms with stacked carpets: two rows in the middle-left
  const platW = 2.6, platD = 1.7;
  const rowsZ = [s.z0 + 3.3, s.z0 + 3.3 + platD + 1.3].filter((z) => z + platD / 2 < s.z1 - 4.2);
  const platX0 = s.x0 + 2.3, platX1 = s.x0 + w * 0.62;
  let pc = 0;
  for (const z of rowsZ)
    for (let x = platX0; x + platW / 2 <= platX1; x += platW + 0.9) platform(g, x + platW / 2, z, platW, platD, pc++);

  // reception, front right: blue wall with the white logo, brown counter with blue sides and blue underglow
  const recZ = s.z1 - 4.2, recLen = Math.min(4.6, d * 0.4);
  box(g, 0.2, 2.9, recLen + 1, mat(C.blue, 0.5), s.x1 - t - 0.1, FLOOR, recZ);
  const logo = new THREE.MeshBasicMaterial({ map: logoTexture(true), transparent: true, depthWrite: false });
  plane(g, 1.6, 1.6 / (915 / 298), logo, s.x1 - t - 0.22, FLOOR + 2.2, recZ, -Math.PI / 2);
  const counterX = s.x1 - 2.1;
  box(g, 0.7, 1.05, recLen, mat(C.counter, 0.6), counterX, FLOOR + 0.08, recZ);
  box(g, 0.75, 0.05, recLen + 0.05, mat(C.counter, 0.5), counterX, FLOOR + 1.13, recZ);
  for (const sz of [-1, 1]) box(g, 0.72, 1.1, 0.25, mat(C.blue, 0.5), counterX, FLOOR + 0.08, recZ + sz * (recLen / 2 - 0.12));
  box(g, 0.6, 0.08, recLen, mat(C.blue, 0.4, { emissive: 0x2d6bff, emissiveIntensity: 1.2 }), counterX - 0.05, FLOOR, recZ, false);

  // consultation corner, front left: desks with monitors on stands, blue armchairs around a glass table
  const deskZ = s.z1 - 3.6;
  const desk1X = s.x0 + 2.0, desk2X = s.x0 + 2.0 + Math.min(4.2, w * 0.2);
  deskWithMonitor(g, desk1X, deskZ, 0);
  deskWithMonitor(g, desk2X, deskZ, 0);
  const loungeX = Math.min(desk2X + 3.6, counterX - 3), loungeZ = s.z1 - 2.6;
  box(g, 1.1, 0.42, 0.6, mat(0xcfe8f0, 0.05, { transparent: true, opacity: 0.35, metalness: 0.2 }), loungeX, FLOOR, loungeZ, false);
  armchair(g, loungeX - 1.1, loungeZ, Math.PI / 2);
  armchair(g, loungeX + 1.1, loungeZ, -Math.PI / 2);
  armchair(g, loungeX, loungeZ - 1.0, 0);

  // kids corner: between the roll rack and the reception — green partition with a road-map print, multicoloured
  // carpet tiles, balls, hedge planters around it
  const kx0 = s.x0 + w * 0.66, kx1 = s.x1 - 3.0, kz0 = s.z0 + 2.1, kz1 = Math.min(s.z0 + 5.6, recZ - recLen / 2 - 1.2);
  if (kx1 - kx0 >= 3 && kz1 - kz0 >= 2.2) {
    const kw = kx1 - kx0, kd = kz1 - kz0, kcx = (kx0 + kx1) / 2, kcz = (kz0 + kz1) / 2;
    box(g, kw, 0.02, kd, new THREE.MeshStandardMaterial({ map: kidsTilesTex(), roughness: 0.95 }), kcx, FLOOR, kcz, false);
    box(g, kw, 1.5, 0.12, mat(C.kidsGreen, 0.8), kcx, FLOOR, kz0 + 0.06);
    plane(g, kw - 0.4, 1.1, new THREE.MeshStandardMaterial({ map: kidsWallTex(), roughness: 0.9 }), kcx, FLOOR + 0.8, kz0 + 0.13);
    for (const [hx, hz, hw, hd] of [[kcx, kz1 - 0.15, kw, 0.3], [kx0 + 0.15, kcz + 0.1, 0.3, kd - 0.2], [kx1 - 0.15, kcz + 0.1, 0.3, kd - 0.2]] as const)
      box(g, hw, 0.7, hd, mat(C.hedge, 0.95, { flatShading: true }), hx, FLOOR, hz);
    for (const [bx, bz, col, r] of [[kcx - kw * 0.25, kcz - 0.3, 0xe53935, 0.3], [kcx + kw * 0.2, kcz, 0x1e63c9, 0.28], [kcx, kcz + 0.5, 0xe91e63, 0.18]] as const) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), mat(col, 0.5));
      ball.position.set(bx, FLOOR + r, bz);
      ball.castShadow = true;
      g.add(ball);
    }
    for (const [tx, tz, col] of [[kcx - 0.4, kcz + 0.4, 0xe53935], [kcx + 0.5, kcz - 0.5, 0x43a047], [kcx + 0.1, kcz + 0.1, 0xfdd835]] as const)
      box(g, 0.45, 0.2, 0.22, mat(col, 0.5), tx, FLOOR, tz); // toy blocks
  }

  // plants and LED frames
  plant(g, s.x0 + 0.8, s.z0 + 2.3, true);
  plant(g, rx0 - 0.3, s.z0 + 1.2);
  plant(g, s.x1 - 0.9, s.z1 - 1.0, true);
  plant(g, desk2X + 1.9, deskZ - 0.6);
  for (let x = s.x0 + 3.5; x < s.x1 - 2; x += 6) ledFrame(g, x, s.z0 + 4.5, 2.6, FLOOR + 3.6);

  const P = (x: number, z: number, yaw = 0): Spot => ({ pos: new THREE.Vector3(x, FLOOR, z), yaw });
  return {
    group: g,
    aiSpot: P(desk2X + 0.1, deskZ - 1.0, 0),
    spots: [
      P(desk1X + 0.1, deskZ - 1.0, 0), // consultant at the first desk
      P(s.x1 - 1.05, recZ - 0.5, -Math.PI / 2), // behind the reception counter
      P(s.x1 - 1.05, recZ + 0.9, -Math.PI / 2),
      ...[0.25, 0.42, 0.55].map((k) => P(s.x0 + w * k, s.z0 + 3.3 + platD / 2 + 0.65, 0)), // aisle between the platform rows
      P(loungeX + 2.2, loungeZ - 1.3, -Math.PI / 4),
      P(cx, s.z1 - 1.4, Math.PI),
      ...Array.from({ length: 8 }, (_, i) => P(s.x0 + 2 + (i % 4) * 2.2, s.z1 - 5.6 - Math.floor(i / 4) * 0.9, 0)),
    ],
  };
}
