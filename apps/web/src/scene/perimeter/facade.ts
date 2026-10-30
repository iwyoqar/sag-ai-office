// FacadeSystem + WindowSystem for the perimeter towers: procedural canvas textures tiled in world metres (one tile =
// a few bays × two floors, so floor lines meet across stacked volumes) and the PBR materials built from them.
import * as THREE from "three";
import { FLOOR_H, GROUND_H, type Palette } from "./layout";

type Paint = (g: CanvasRenderingContext2D, w: number, h: number) => void;

function canvasTex(w: number, h: number, paint: Paint): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  paint(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const shade = (hex: string, k: number) => {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return `#${c.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l * k, 0, 1)).getHexString()}`;
};

export type WindowStyle = "curtain" | "punched" | "ribbon" | "fins";

/** Tile size in metres: `bays` window bays (bay width `bay`) × 2 floors. */
export interface Tile { w: number; h: number }

/**
 * WindowSystem: one tile of facade. Panes get a sky-to-ground reflection gradient and a few drawn blinds, so a tiled
 * wall does not read as a single flat colour from the aerial camera.
 */
export function windowTexture(style: WindowStyle, p: Palette, seed: number, bays = 4, bay = 1.6): { map: THREE.CanvasTexture; tile: Tile } {
  const tile = { w: bays * bay, h: FLOOR_H * 2 };
  const R = rng(seed * 7919 + 17);
  const PX = 64; // pixels per metre
  const map = canvasTex(Math.round(tile.w * PX), Math.round(tile.h * PX), (g, w, h) => {
    const fh = h / 2, bw = w / bays;
    const pane = (x: number, y: number, pw: number, ph: number) => {
      const grad = g.createLinearGradient(0, y, 0, y + ph);
      const lift = 0.85 + R() * 0.35;
      // sky reflected at the top of each pane, darker interior below
      grad.addColorStop(0, shade(p.glass, 1.5 * lift));
      grad.addColorStop(0.5, shade(p.glass, 1.05 * lift));
      grad.addColorStop(1, shade(p.glass, 0.75 * lift));
      g.fillStyle = grad;
      g.fillRect(x, y, pw, ph);
      if (R() < 0.22) { // blinds half down
        g.fillStyle = "rgba(236,236,230,0.55)";
        g.fillRect(x, y, pw, ph * (0.25 + R() * 0.4));
      }
      g.fillStyle = "rgba(255,255,255,0.10)"; // sky glint
      g.fillRect(x + pw * 0.08, y, pw * 0.12, ph);
    };
    if (style === "punched") {
      g.fillStyle = p.wall;
      g.fillRect(0, 0, w, h);
      for (let f = 0; f < 2; f++)
        for (let b = 0; b < bays; b++) {
          const x = b * bw + bw * 0.18, y = f * fh + fh * 0.2, pw = bw * 0.64, ph = fh * 0.58;
          g.fillStyle = shade(p.wall, 0.78); // reveal shadow
          g.fillRect(x - 3, y - 3, pw + 6, ph + 8);
          pane(x, y, pw, ph);
          g.fillStyle = p.frame;
          g.fillRect(x + pw / 2 - 2, y, 4, ph);
          g.fillStyle = shade(p.wall, 1.08); // sill
          g.fillRect(x - 5, y + ph + 2, pw + 10, 5);
        }
      return;
    }
    if (style === "ribbon") {
      g.fillStyle = p.wall;
      g.fillRect(0, 0, w, h);
      for (let f = 0; f < 2; f++) {
        const y = f * fh + fh * 0.28, ph = fh * 0.5;
        for (let b = 0; b < bays; b++) pane(b * bw, y, bw, ph);
        g.fillStyle = p.frame;
        for (let b = 0; b <= bays; b++) g.fillRect(b * bw - 2, y, 4, ph);
        g.fillRect(0, y - 3, w, 4);
        g.fillRect(0, y + ph - 1, w, 4);
      }
      return;
    }
    // curtain wall / curtain wall with fins: glass edge to edge, spandrel at each slab
    for (let f = 0; f < 2; f++)
      for (let b = 0; b < bays; b++) pane(b * bw, f * fh, bw, fh);
    g.fillStyle = shade(p.frame, 1.0);
    for (let f = 0; f < 2; f++) {
      g.fillRect(0, f * fh, w, fh * 0.13); // spandrel band at the slab
      g.fillStyle = shade(p.frame, 0.85);
      g.fillRect(0, f * fh + fh * 0.13, w, 2);
      g.fillStyle = shade(p.frame, 1.0);
    }
    for (let b = 0; b <= bays; b++) g.fillRect(b * bw - (style === "fins" ? 5 : 2), 0, style === "fins" ? 10 : 4, h);
  });
  map.repeat.set(1 / tile.w, 1 / tile.h);
  return { map, tile };
}

/** Lobby: double-height glass with a dark frame, one tile = 3 m × ground floor. */
function lobbyTexture(p: Palette) {
  const map = canvasTex(192, 288, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, shade(p.glass, 1.2));
    grad.addColorStop(1, shade(p.glass, 0.55));
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,240,210,0.18)"; // warm interior light
    g.fillRect(0, h * 0.35, w, h * 0.65);
    g.fillStyle = p.frame;
    g.fillRect(0, 0, w, 12);
    g.fillRect(0, 0, 6, h);
    g.fillRect(w - 6, 0, 6, h);
    g.fillRect(0, h * 0.72, w, 4);
  });
  map.repeat.set(1 / 3, 1 / GROUND_H);
  return map;
}

/** Roof membrane with seams. */
const roofTexture = () => {
  const map = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#b9bbbd";
    g.fillRect(0, 0, w, h);
    const R = rng(5);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${R() < 0.5 ? "255,255,255" : "60,60,60"},0.06)`;
      g.fillRect(R() * w, R() * h, 3, 3);
    }
    g.fillStyle = "rgba(90,90,90,0.25)";
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 2, h);
  });
  map.repeat.set(1 / 8, 1 / 8);
  return map;
};

const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);

/** FacadeSystem: the material set of one company (shared by its tower and its office buildings). */
export function companyMaterials(p: Palette, mainStyle: WindowStyle, annexStyle: WindowStyle, seed: number) {
  const glassy = (s: WindowStyle) => s === "curtain" || s === "fins";
  const main = windowTexture(mainStyle, p, seed, 4, 1.6);
  const annex = windowTexture(annexStyle, p, seed + 101, 3, 2.2);
  return {
    main: std({ map: main.map, roughness: glassy(mainStyle) ? 0.12 : 0.55, metalness: glassy(mainStyle) ? 0.55 : 0.15 }),
    annex: std({ map: annex.map, roughness: glassy(annexStyle) ? 0.14 : 0.6, metalness: glassy(annexStyle) ? 0.5 : 0.12 }),
    lobby: std({ map: lobbyTexture(p), roughness: 0.1, metalness: 0.5 }),
    solid: std({ color: p.wall, roughness: 0.75, metalness: 0.05 }),
    frame: std({ color: p.frame, roughness: 0.45, metalness: 0.5 }),
    accent: std({ color: p.accent, roughness: 0.4, metalness: 0.35 }),
  };
}
export type CompanyMaterials = ReturnType<typeof companyMaterials>;

let shared: ReturnType<typeof createShared> | null = null;
function createShared() {
  return {
    roof: std({ map: roofTexture(), roughness: 0.85 }),
    coping: std({ color: 0xd4d2cc, roughness: 0.6, metalness: 0.2 }),
    plant: std({ color: 0xa9adb1, roughness: 0.5, metalness: 0.6 }),
    steel: std({ color: 0x5d636b, roughness: 0.45, metalness: 0.75 }),
    railGlass: std({ color: 0x9fc2d6, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.45, depthWrite: false }),
    timber: std({ color: 0x9a6b42, roughness: 0.75 }),
    greenRoof: std({ color: 0x6f9a45, roughness: 0.95 }),
    planter: std({ color: 0x8a8274, roughness: 0.85 }),
    helipad: std({ color: 0x3b3f45, roughness: 0.7 }),
    helipadMark: std({ color: 0xf3c234, roughness: 0.5 }),
    signBack: std({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.4 }),
    lightBar: std({ color: 0xfff6dc, emissive: 0xfff1c8, emissiveIntensity: 1.2, roughness: 0.3 }),
    solar: std({ color: 0x1f3550, roughness: 0.2, metalness: 0.7 }),
  };
}
/** Materials every company shares (roofs, plant, sign structure). */
export const perimeterMaterials = () => (shared ??= createShared());
export type PerimeterMaterials = ReturnType<typeof createShared>;

/**
 * Box standing on `y0`, centred on x/z, with metre UVs whose v counts from the top of the ground floor, so the floor
 * lines of a stacked volume continue those of the one below it.
 */
export function wallBox(w: number, h: number, d: number, y0: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++)
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      const side = f !== 2 && f !== 3;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1] + (side ? y0 - GROUND_H : 0));
    }
  uv.needsUpdate = true;
  g.translate(0, h / 2, 0);
  return g;
}

/** Vertical cylinder standing on `y0` with metre UVs (u around the circumference, v as in wallBox). */
export function wallCylinder(r: number, h: number, y0: number, arc = Math.PI * 2, start = 0): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, 24, 1, false, start, arc);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * r * arc, uv.getY(i) * h + y0 - GROUND_H);
  uv.needsUpdate = true;
  g.translate(0, h / 2, 0);
  return g;
}
