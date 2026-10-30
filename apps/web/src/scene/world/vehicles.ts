// SAG fleet: four reusable vehicle models built once from extruded side profiles (bevelled cabs, sloped windscreens),
// branded cargo bodies (SAG logo and blue band on canvas textures), wheels with hubs, head and tail lights, bumpers,
// mirrors, and a soft contact shadow. Every model is a list of parts in vehicle space (+x forward, ground at y = 0);
// the traffic system draws each part as one InstancedMesh, so the whole fleet costs a fixed number of draw calls.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { withLogo } from "../network/storeLooks";
import type { VehicleKind } from "./roads";

export interface VehiclePart {
  geo: THREE.BufferGeometry;
  mat: THREE.Material | THREE.Material[];
  /** takes the vehicle's livery colour (instance colour) */
  tint?: boolean;
  /** belongs to the semi-trailer, which has its own matrix */
  trailer?: boolean;
}

export interface VehicleModel {
  kind: VehicleKind;
  parts: VehiclePart[];
  /** body length (tractor only for the semi) and width */
  length: number;
  width: number;
  /** semi: kingpin distance behind the tractor centre, trailer length behind the kingpin */
  kingpin?: number;
  trailerLength?: number;
  /** cruising speed m/s, acceleration and braking m/s² */
  vmax: number;
  accel: number;
  decel: number;
  /** livery colours the instances pick from */
  liveries: number[];
}

const BLUE = 0x1b4e9b;

// ---- shared materials ---------------------------------------------------------------------------------------------
let M: ReturnType<typeof mats> | null = null;
function mats() {
  const shadowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    r.addColorStop(0, "rgba(0,0,0,0.55)");
    r.addColorStop(0.6, "rgba(0,0,0,0.3)");
    r.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  return {
    paint: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.45 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf4f5f6, roughness: 0.45, metalness: 0.15 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.06, metalness: 0.8 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.85 }),
    hub: new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.3, metalness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.3 }),
    head: new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 1.6, roughness: 0.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0xb3121b, emissive: 0xd0141f, emissiveIntensity: 1.2, roughness: 0.3 }),
    amber: new THREE.MeshStandardMaterial({ color: 0xf0a020, emissive: 0xf09010, emissiveIntensity: 0.8, roughness: 0.3 }),
    band: new THREE.MeshStandardMaterial({ color: BLUE, roughness: 0.4, metalness: 0.2 }),
    shadow: new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
  };
}

/** Cargo-box side: white panels, SAG blue band, the logo and "HOME DESIGN"; redrawn when the logo has loaded. */
function cargoSide(lenM: number, hM: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = Math.round(lenM * 64);
  c.height = Math.round(hM * 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const draw = (logo?: HTMLCanvasElement) => {
    const g = c.getContext("2d")!;
    const W = c.width, H = c.height;
    g.fillStyle = "#f6f7f8";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(60,70,80,0.18)";
    for (let x = W / 6; x < W; x += W / 6) g.fillRect(x, 0, 2, H); // panel seams
    g.fillStyle = "#1b4e9b";
    g.fillRect(0, H * 0.8, W, H * 0.12);
    g.fillStyle = "#d99a2b";
    g.fillRect(0, H * 0.92, W, H * 0.03);
    if (logo) {
      const lh = H * 0.42, lw = lh * (logo.width / logo.height);
      g.drawImage(logo, (W - lw) / 2, H * 0.14, lw, lh);
    }
    g.fillStyle = "#1b4e9b";
    g.font = `700 ${Math.round(H * 0.1)}px "Century Gothic", "Montserrat", "Trebuchet MS", sans-serif`;
    g.textAlign = "center";
    g.fillText("HOME DESIGN  ·  GILAMLAR", W / 2, H * 0.71);
    tex.needsUpdate = true;
  };
  draw();
  withLogo(draw);
  return tex;
}

/** Rear doors: two leaves, hinges, handles and a small logo. */
function cargoRear(wM: number, hM: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = Math.round(wM * 64);
  c.height = Math.round(hM * 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (logo?: HTMLCanvasElement) => {
    const g = c.getContext("2d")!;
    const W = c.width, H = c.height;
    g.fillStyle = "#eef0f2";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#9aa1a8";
    g.fillRect(W / 2 - 1, 0, 2, H);
    g.fillRect(W * 0.46, H * 0.45, 3, H * 0.2);
    g.fillRect(W * 0.54 - 3, H * 0.45, 3, H * 0.2);
    g.fillStyle = "#1b4e9b";
    g.fillRect(0, H * 0.86, W, H * 0.08);
    if (logo) {
      const lw = W * 0.34, lh = lw / (logo.width / logo.height);
      g.drawImage(logo, W * 0.08, H * 0.12, lw, lh);
    }
    tex.needsUpdate = true;
  };
  draw();
  withLogo(draw);
  return tex;
}

/** A cargo box with branded sides and rear (BoxGeometry face order: +x, −x, +y, −y, +z, −z). */
function cargoBox(len: number, h: number, w: number, x: number, y: number): VehiclePart {
  const m = (M ??= mats());
  const side = new THREE.MeshStandardMaterial({ map: cargoSide(len, h), roughness: 0.45, metalness: 0.1 });
  const rear = new THREE.MeshStandardMaterial({ map: cargoRear(w, h), roughness: 0.45, metalness: 0.1 });
  const geo = new THREE.BoxGeometry(len, h, w);
  geo.translate(x, y + h / 2, 0);
  return { geo, mat: [m.white, rear, m.white, m.dark, side, side] };
}

// ---- geometry helpers ---------------------------------------------------------------------------------------------
function extrude(profile: [number, number][], width: number, bevel = 0.06): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  return g.toNonIndexed();
}
function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g.toNonIndexed();
}
function merge(geos: THREE.BufferGeometry[]) {
  return mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)));
}
function wheels(xs: number[], r: number, halfTrack: number, dual = false) {
  const tyres: THREE.BufferGeometry[] = [], hubs: THREE.BufferGeometry[] = [];
  for (const x of xs)
    for (const s of [-1, 1]) {
      const t = new THREE.CylinderGeometry(r, r, dual ? 0.5 : 0.3, 16).rotateX(Math.PI / 2);
      t.translate(x, r, s * halfTrack);
      tyres.push(t);
      const h = new THREE.CylinderGeometry(r * 0.55, r * 0.55, dual ? 0.52 : 0.32, 12).rotateX(Math.PI / 2);
      h.translate(x, r, s * (halfTrack + 0.01));
      hubs.push(h);
    }
  return { tyres: merge(tyres), hubs: merge(hubs) };
}
function lights(front: number, rear: number, yH: number, yT: number, halfW: number) {
  const head = merge([box(0.06, 0.2, 0.42, front, yH, halfW - 0.32), box(0.06, 0.2, 0.42, front, yH, -(halfW - 0.32))]);
  const tail = merge([box(0.06, 0.38, 0.16, rear, yT, halfW - 0.18), box(0.06, 0.38, 0.16, rear, yT, -(halfW - 0.18))]);
  return { head, tail };
}
function shadow(len: number, w: number, x = 0) {
  const g = new THREE.PlaneGeometry(len * 1.12, w * 1.5).rotateX(-Math.PI / 2);
  g.translate(x, 0.02, 0);
  return g;
}
function logoDecals(x: number, y: number, h: number, halfW: number): THREE.BufferGeometry {
  const w = h * (915 / 298);
  const a = new THREE.PlaneGeometry(w, h);
  a.translate(x, y, halfW + 0.012);
  const b = new THREE.PlaneGeometry(w, h);
  b.rotateY(Math.PI);
  b.translate(x, y, -halfW - 0.012);
  return merge([a, b]);
}
let logoMat: THREE.MeshBasicMaterial | null = null;
function logoMaterial() {
  if (logoMat) return logoMat;
  const c = document.createElement("canvas");
  c.width = 915;
  c.height = 298;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  withLogo((logo) => {
    c.getContext("2d")!.drawImage(logo, 0, 0, c.width, c.height);
    tex.needsUpdate = true;
  });
  return (logoMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
}

// ---- models -------------------------------------------------------------------------------------------------------

/** Small delivery van (panel van, ~5.9 m): one-piece body, sloped screen, logo and band on the flanks. */
function van(): VehicleModel {
  const m = (M ??= mats());
  const L = 5.9, W = 2.0, half = L / 2;
  const body = extrude([[-half, 0.42], [-half, 2.5], [-half + 0.15, 2.62], [1.0, 2.62], [2.05, 1.6], [2.8, 1.25], [half, 1.05], [half, 0.42]], W);
  const glass = extrude([[0.55, 1.62], [2.07, 1.62], [1.1, 2.52], [0.55, 2.52]], W + 0.03, 0);
  const band = merge([box(L - 0.6, 0.22, W + 0.03, -0.25, 1.0, 0)]);
  const w = wheels([1.95, -1.95], 0.36, W / 2 - 0.14);
  const l = lights(half + 0.01, -half - 0.01, 1.05, 1.15, W / 2);
  const dark = merge([box(0.2, 0.3, W + 0.04, half - 0.02, 0.55, 0), box(0.2, 0.3, W + 0.04, -half + 0.02, 0.55, 0),
    box(0.18, 0.22, 0.08, 1.95, 1.95, W / 2 + 0.06), box(0.18, 0.22, 0.08, 1.95, 1.95, -W / 2 - 0.06)]);
  return {
    kind: "van", length: L, width: W, vmax: 12.5, accel: 2.4, decel: 4.5, liveries: [0xf6f7f8, 0xf6f7f8, 0xf6f7f8, BLUE],
    parts: [
      { geo: body, mat: m.paint, tint: true }, { geo: glass, mat: m.glass }, { geo: band, mat: m.band },
      { geo: logoDecals(-0.6, 1.75, 0.62, W / 2), mat: logoMaterial() },
      { geo: w.tyres, mat: m.tyre }, { geo: w.hubs, mat: m.hub }, { geo: dark, mat: m.dark },
      { geo: l.head, mat: m.head }, { geo: l.tail, mat: m.tail }, { geo: shadow(L, W), mat: m.shadow },
    ],
  };
}

/** Cab-over rigid truck: a tall cab with a near-vertical screen, chassis, and a branded box body. */
function rigid(kind: "medium" | "large", L: number, W: number, cabL: number, boxH: number, r: number, axles: number[], vmax: number): VehicleModel {
  const m = (M ??= mats());
  const half = L / 2, cabBack = half - cabL;
  const cabH = boxH * 0.78 + 0.9;
  const cab = extrude([[cabBack, 0.7], [cabBack, cabH], [half - 0.3, cabH], [half - 0.05, cabH - 0.75], [half, 0.7]], W - 0.05);
  const glass = extrude([[cabBack + 0.55, cabH - 0.95], [half - 0.02, cabH - 0.95], [half - 0.24, cabH - 0.12], [cabBack + 0.55, cabH - 0.12]], W - 0.02, 0);
  const boxLen = L - cabL - 0.15;
  const cargo = cargoBox(boxLen, boxH, W + 0.05, -half + boxLen / 2, r * 2 - 0.05);
  const w = wheels(axles, r, W / 2 - 0.25, true);
  const l = lights(half + 0.01, -half - 0.01, 1.0, 1.0, W / 2);
  const dark = merge([
    box(L - 0.3, 0.32, W * 0.6, -0.1, r * 1.5, 0), // chassis rails
    box(0.25, 0.35, W, half - 0.05, 0.6, 0), // front bumper
    box(0.15, 0.3, W, -half + 0.1, 0.65, 0), // rear under-run bar
    box(0.12, 0.42, 0.1, half - 0.15, cabH - 0.9, W / 2 + 0.12), box(0.12, 0.42, 0.1, half - 0.15, cabH - 0.9, -W / 2 - 0.12), // mirrors
    box(1.4, 0.55, 0.32, cabBack - 0.9, r + 0.35, W / 2 - 0.2), // fuel tank
  ]);
  return {
    kind, length: L, width: W, vmax, accel: kind === "medium" ? 1.8 : 1.4, decel: 3.8, liveries: [BLUE, BLUE, 0xf6f7f8, 0x3a3f46],
    parts: [
      { geo: cab, mat: m.paint, tint: true }, { geo: glass, mat: m.glass }, cargo,
      { geo: w.tyres, mat: m.tyre }, { geo: w.hubs, mat: m.hub }, { geo: dark, mat: m.dark },
      { geo: l.head, mat: m.head }, { geo: l.tail, mat: m.tail },
      { geo: merge([box(0.3, 0.08, 0.16, half - 0.4, cabH + 0.04, 0.5), box(0.3, 0.08, 0.16, half - 0.4, cabH + 0.04, -0.5)]), mat: m.amber },
      { geo: shadow(L, W), mat: m.shadow },
    ],
  };
}

/** Tractor unit with roof fairing and a 13.6 m branded box trailer on its own matrix (articulated). */
function semi(): VehicleModel {
  const m = (M ??= mats());
  const L = 6.2, W = 2.5, half = L / 2, cabBack = half - 2.3, cabH = 3.2, r = 0.52;
  const cab = extrude([[cabBack, 0.75], [cabBack, cabH], [half - 0.35, cabH], [half - 0.05, cabH - 0.85], [half, 0.75]], W - 0.05);
  const fairing = extrude([[cabBack, cabH - 0.05], [cabBack, cabH + 0.75], [cabBack + 0.6, cabH + 0.75], [half - 0.5, cabH - 0.05]], W - 0.2, 0.04);
  const glass = extrude([[cabBack + 0.6, cabH - 1.05], [half - 0.02, cabH - 1.05], [half - 0.28, cabH - 0.15], [cabBack + 0.6, cabH - 0.15]], W - 0.02, 0);
  const w = wheels([half - 0.85, -1.2, -2.5], r, W / 2 - 0.3, true);
  const kingpin = 1.85; // behind the tractor centre
  const tL = 13.6, tH = 2.75, tBase = 1.3, front = 1.25; // trailer: box from kingpin+front back to kingpin+front−tL
  const tw = wheels([front - tL + 1.4, front - tL + 2.7, front - tL + 4.0], r, W / 2 - 0.3, true);
  const trailerBox = cargoBox(tL, tH, W + 0.05, front - tL / 2, tBase);
  const l = lights(half + 0.01, -half - 0.01, 1.05, 1.0, W / 2);
  const tl = lights(front + 0.01, front - tL - 0.01, 0, 1.0, W / 2);
  const dark = merge([
    box(L - 0.4, 0.35, W * 0.6, -0.2, 0.85, 0), box(0.3, 0.4, W, half - 0.05, 0.65, 0),
    box(0.12, 0.45, 0.1, half - 0.15, cabH - 1.0, W / 2 + 0.14), box(0.12, 0.45, 0.1, half - 0.15, cabH - 1.0, -W / 2 - 0.14),
    box(1.5, 0.6, 0.35, cabBack - 0.85, 0.95, W / 2 - 0.2), box(1.5, 0.6, 0.35, cabBack - 0.85, 0.95, -W / 2 + 0.2),
  ]);
  const tDark = merge([
    box(tL - 3, 0.25, W * 0.5, front - tL / 2 - 1, tBase - 0.15, 0), // trailer chassis
    box(0.18, tBase - 0.2, 0.18, front - 2.6, (tBase - 0.2) / 2, W / 2 - 0.4), box(0.18, tBase - 0.2, 0.18, front - 2.6, (tBase - 0.2) / 2, -W / 2 + 0.4), // landing legs
    box(0.15, 0.3, W, front - tL + 0.1, 0.65, 0),
  ]);
  return {
    kind: "semi", length: L, width: W, kingpin, trailerLength: tL - front, vmax: 10, accel: 1.0, decel: 3.2, liveries: [BLUE, BLUE, 0x3a3f46, 0xf6f7f8],
    parts: [
      { geo: merge([cab, fairing]), mat: m.paint, tint: true }, { geo: glass, mat: m.glass },
      { geo: w.tyres, mat: m.tyre }, { geo: w.hubs, mat: m.hub }, { geo: dark, mat: m.dark },
      { geo: l.head, mat: m.head }, { geo: shadow(L, W), mat: m.shadow },
      { ...trailerBox, trailer: true }, { geo: tw.tyres, mat: m.tyre, trailer: true }, { geo: tw.hubs, mat: m.hub, trailer: true },
      { geo: tDark, mat: m.dark, trailer: true }, { geo: tl.tail, mat: m.tail, trailer: true },
      { geo: shadow(tL, W, front - tL / 2), mat: m.shadow, trailer: true },
    ],
  };
}

let MODELS: Record<VehicleKind, VehicleModel> | null = null;
export function vehicleModels(): Record<VehicleKind, VehicleModel> {
  return (MODELS ??= {
    van: van(),
    medium: rigid("medium", 7.4, 2.3, 2.0, 2.45, 0.46, [2.4, -1.9], 11),
    large: rigid("large", 10.2, 2.5, 2.3, 2.8, 0.52, [3.6, -2.4, -3.7], 10),
    semi: semi(),
  });
}
