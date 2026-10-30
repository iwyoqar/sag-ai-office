// Procedural PBR materials for the campus. Textures are generated once on a canvas (no extra downloads, except the
// SAG logo image) and tiled in world metres via meter-based UVs (see boxGeometryM).
import * as THREE from "three";
import logoUrl from "../../assets/sag-logo.png";

type Paint = (g: CanvasRenderingContext2D, w: number, h: number) => void;

function canvasTex(w: number, h: number, paint: Paint, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  paint(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Deterministic noise so the campus looks the same on every load. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// ---- horizontal metal cladding (photos 1, 4–7): ivory ribs every 0.2 m, panel seams every 6 m
const RIB_TILE = { w: 6, h: 2 };
const ribbedMap = () =>
  canvasTex(768, 256, (g, w, h) => {
    g.fillStyle = "#e7dcbc";
    g.fillRect(0, 0, w, h);
    const ribs = 10;
    for (let i = 0; i < ribs; i++) {
      const y = (i / ribs) * h;
      const grad = g.createLinearGradient(0, y, 0, y + h / ribs);
      grad.addColorStop(0, "rgba(255,252,240,0.55)");
      grad.addColorStop(0.45, "rgba(255,255,255,0)");
      grad.addColorStop(0.85, "rgba(120,100,60,0.18)");
      grad.addColorStop(1, "rgba(90,75,45,0.28)");
      g.fillStyle = grad;
      g.fillRect(0, y, w, h / ribs);
    }
    g.fillStyle = "rgba(110,95,60,0.35)";
    g.fillRect(0, 0, 3, h);
  });

const ribbedNormal = () =>
  canvasTex(
    16,
    256,
    (g, w, h) => {
      const img = g.createImageData(w, h);
      const ribs = 10;
      for (let y = 0; y < h; y++) {
        const ny = Math.sin(((y / h) * ribs) * Math.PI * 2) * 0.55;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          img.data[i] = 128;
          img.data[i + 1] = 128 + ny * 127;
          img.data[i + 2] = 230;
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    },
    false,
  );

// ---- beige stone (office annex, gate wall): 1.2 × 0.6 m blocks, like the office model
const STONE_TILE = { w: 4.8, h: 2.4 };
const stoneMap = () =>
  canvasTex(512, 256, (g, w, h) => {
    const r = rng(7);
    g.fillStyle = "#dfcfae";
    g.fillRect(0, 0, w, h);
    const rows = 4, cols = 4;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols + 1; i++) {
        const off = j % 2 ? w / cols / 2 : 0;
        const x = i * (w / cols) - off, y = j * (h / rows);
        const v = 205 + Math.floor(r() * 22);
        g.fillStyle = `rgb(${v + 18},${v + 4},${v - 30})`;
        g.fillRect(x + 2, y + 2, w / cols - 4, h / rows - 4);
      }
  });

const roofMap = () =>
  canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = "#b9bdc2";
    g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(x, 0, 2, h);
      g.fillStyle = "rgba(60,70,80,0.18)";
      g.fillRect(x + 2, 0, 2, h);
    }
  });

const asphaltMap = () =>
  canvasTex(256, 256, (g, w, h) => {
    const r = rng(3);
    g.fillStyle = "#4a4d52";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const v = 60 + Math.floor(r() * 50);
      g.fillStyle = `rgba(${v},${v},${v + 4},0.5)`;
      g.fillRect(r() * w, r() * h, 1.5, 1.5);
    }
  });

const pavingMap = () =>
  canvasTex(256, 256, (g) => {
    const r = rng(5);
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const v = 196 + Math.floor(r() * 14);
        g.fillStyle = `rgb(${v},${v - 3},${v - 10})`;
        g.fillRect(i * 64, j * 64, 64, 64);
        g.fillStyle = "rgba(120,115,105,0.6)";
        g.fillRect(i * 64, j * 64, 64, 2);
        g.fillRect(i * 64, j * 64, 2, 64);
      }
  });

// ---- lawn: mottled green with darker clumps and blade flecks (stylised, reads well from the aerial camera)
const grassMap = () =>
  canvasTex(256, 256, (g, w, h) => {
    const r = rng(11);
    g.fillStyle = "#6f9a43";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const x = r() * w, y = r() * h, rad = 10 + r() * 26;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      const dark = r() < 0.5;
      grad.addColorStop(0, dark ? "rgba(70,105,40,0.45)" : "rgba(150,180,85,0.35)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    for (let i = 0; i < 5000; i++) {
      const v = r();
      g.fillStyle = v < 0.5 ? `rgba(60,95,35,0.5)` : `rgba(165,195,95,0.45)`;
      g.fillRect(r() * w, r() * h, 1, 2 + r() * 2);
    }
  });

// ---- bark mulch for planting beds
const mulchMap = () =>
  canvasTex(128, 128, (g, w, h) => {
    const r = rng(13);
    g.fillStyle = "#6b4a33";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const v = r();
      g.fillStyle = v < 0.5 ? "rgba(60,38,24,0.7)" : "rgba(140,100,70,0.5)";
      g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 2);
    }
  });

const solarMap = () =>
  canvasTex(512, 64, (g, w, h) => {
    g.fillStyle = "#1c2a44";
    g.fillRect(0, 0, w, h);
    const cells = 5; // 5 panels per 10 m segment
    for (let i = 0; i < cells; i++) {
      const x = (i / cells) * w;
      const grad = g.createLinearGradient(x, 0, x + w / cells, h);
      grad.addColorStop(0, "#2d4d80");
      grad.addColorStop(1, "#162440");
      g.fillStyle = grad;
      g.fillRect(x + 3, 3, w / cells - 6, h - 6);
      g.strokeStyle = "rgba(170,190,220,0.25)";
      for (let k = 1; k < 6; k++) g.strokeRect(x + 3 + (k * (w / cells - 6)) / 6, 3, 0.5, h - 6);
    }
  });

/** Window texture: frame + mullions over a reflective glass gradient. */
function windowMap(cols: number, rows: number, frame: string, glassTop: string, glassBottom: string) {
  return canvasTex(256, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, glassTop);
    grad.addColorStop(1, glassBottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.moveTo(0, h * 0.7);
    g.lineTo(w * 0.55, 0);
    g.lineTo(w * 0.75, 0);
    g.lineTo(0, h);
    g.fill();
    g.fillStyle = frame;
    const t = 14;
    g.fillRect(0, 0, w, t);
    g.fillRect(0, h - t, w, t);
    g.fillRect(0, 0, t, h);
    g.fillRect(w - t, 0, t, h);
    for (let i = 1; i < cols; i++) g.fillRect((i * w) / cols - 4, 0, 8, h);
    for (let j = 1; j < rows; j++) g.fillRect(0, (j * h) / rows - 4, w, 8);
  });
}

const rollerMap = () =>
  canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = "#eef0f1";
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 10) {
      g.fillStyle = "rgba(120,125,130,0.35)";
      g.fillRect(0, y, w, 2);
    }
  });

const gateMap = () =>
  canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = "#59603f";
    g.fillRect(0, 0, w, h);
    // window strip on top (photo 2)
    for (let i = 0; i < 8; i++) {
      g.fillStyle = "#c9d3d6";
      g.fillRect(8 + i * 63, 10, 52, 34);
    }
    for (let x = 0; x < w; x += 64) {
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.fillRect(x, 52, 3, h);
    }
    for (let y = 60; y < h; y += 28) {
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(0, y, w, 3);
    }
  });

/** The official SAG logo (assets/sag-logo.png, transparent background) for the gate wall lettering. */
const signMap = () => {
  const t = new THREE.TextureLoader().load(logoUrl);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

const acMap = () =>
  canvasTex(128, 96, (g, w, h) => {
    g.fillStyle = "#e9ebec";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#9aa0a6";
    g.beginPath();
    g.arc(w * 0.62, h / 2, h * 0.36, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#7d838a";
    for (let r = 6; r < h * 0.36; r += 6) {
      g.beginPath();
      g.arc(w * 0.62, h / 2, r, 0, Math.PI * 2);
      g.stroke();
    }
  });

function tiled(map: THREE.Texture, tile: { w: number; h: number }) {
  map.repeat.set(1 / tile.w, 1 / tile.h);
  return map;
}

/** All campus materials, created once and shared. */
export function createCampusMaterials() {
  const ribNormal = tiled(ribbedNormal(), RIB_TILE);
  const m = {
    ribbed: new THREE.MeshStandardMaterial({
      map: tiled(ribbedMap(), RIB_TILE), normalMap: ribNormal, normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.55, metalness: 0.15,
    }),
    stone: new THREE.MeshStandardMaterial({ map: tiled(stoneMap(), STONE_TILE), roughness: 0.85 }),
    stoneDark: new THREE.MeshStandardMaterial({ color: 0x8f7a68, roughness: 0.9 }),
    roof: new THREE.MeshStandardMaterial({ map: tiled(roofMap(), { w: 4, h: 1 }), roughness: 0.5, metalness: 0.55 }),
    blueTrim: new THREE.MeshStandardMaterial({ color: 0x1f3fb0, roughness: 0.35, metalness: 0.5 }),
    blueTiles: new THREE.MeshStandardMaterial({ color: 0x2440b8, roughness: 0.45, metalness: 0.3 }),
    asphalt: new THREE.MeshStandardMaterial({ map: tiled(asphaltMap(), { w: 8, h: 8 }), roughness: 0.92 }),
    paving: new THREE.MeshStandardMaterial({ map: tiled(pavingMap(), { w: 2.4, h: 2.4 }), roughness: 0.85 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xb9b5ad, roughness: 0.9 }),
    curb: new THREE.MeshStandardMaterial({ color: 0xcfcbc2, roughness: 0.8 }),
    marking: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6 }),
    markingYellow: new THREE.MeshStandardMaterial({ color: 0xe8c34a, roughness: 0.6 }),
    solar: new THREE.MeshStandardMaterial({ map: solarMap(), roughness: 0.18, metalness: 0.65 }),
    solarFrame: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.4, metalness: 0.7 }),
    winSmall: new THREE.MeshStandardMaterial({ map: windowMap(2, 2, "#f4f4f2", "#7a8c99", "#3e4c57"), roughness: 0.18, metalness: 0.35 }),
    winRibbon: new THREE.MeshStandardMaterial({ map: windowMap(2, 1, "#f4f4f2", "#8193a0", "#46545f"), roughness: 0.18, metalness: 0.35 }),
    winOffice: new THREE.MeshStandardMaterial({ map: windowMap(3, 2, "#f6f6f4", "#8da0ad", "#4a5966"), roughness: 0.18, metalness: 0.35 }),
    winTall: new THREE.MeshStandardMaterial({ map: windowMap(2, 3, "#f4f4f2", "#7f919d", "#414f5a"), roughness: 0.18, metalness: 0.35 }),
    // Annex / office: blue reflective curtain glass with dark frames (photos 2–3)
    winBlue: new THREE.MeshStandardMaterial({ map: windowMap(2, 2, "#2c3138", "#5f8fd8", "#173a7a"), roughness: 0.06, metalness: 0.8 }),
    roller: new THREE.MeshStandardMaterial({ map: rollerMap(), roughness: 0.5, metalness: 0.3 }),
    door: new THREE.MeshStandardMaterial({ color: 0xf1f1ef, roughness: 0.6 }),
    glassDoor: new THREE.MeshStandardMaterial({ color: 0x2a3f5a, roughness: 0.05, metalness: 0.8 }),
    gate: new THREE.MeshStandardMaterial({ map: gateMap(), roughness: 0.6, metalness: 0.2 }),
    canopy: new THREE.MeshStandardMaterial({ color: 0xe5e3dd, roughness: 0.6, metalness: 0.2 }),
    darkCanopy: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.4, metalness: 0.6 }),
    ac: new THREE.MeshStandardMaterial({ map: acMap(), roughness: 0.6 }),
    vent: new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.35, metalness: 0.8 }),
    red: new THREE.MeshStandardMaterial({ color: 0xc0262d, roughness: 0.5 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 }),
    brownRoof: new THREE.MeshStandardMaterial({ color: 0x5a3a2c, roughness: 0.8 }),
    sign: new THREE.MeshBasicMaterial({ map: signMap(), transparent: true, depthWrite: false, toneMapped: false }),
    pole: new THREE.MeshStandardMaterial({ color: 0x8c9196, roughness: 0.4, metalness: 0.7 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xf6f3e6, emissive: 0x36342a, roughness: 0.3 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 0.9 }),
    leaves: new THREE.MeshStandardMaterial({ color: 0x5c7a3a, roughness: 0.85 }),
    ground: new THREE.MeshStandardMaterial({ color: 0xbdb5a3, roughness: 1 }),
    // landscaping
    grass: new THREE.MeshStandardMaterial({ map: tiled(grassMap(), { w: 9, h: 9 }), roughness: 0.95 }),
    mulch: new THREE.MeshStandardMaterial({ map: tiled(mulchMap(), { w: 2, h: 2 }), roughness: 1 }),
    shrub: new THREE.MeshStandardMaterial({ color: 0x4f7a32, roughness: 0.9, flatShading: true }),
    hedge: new THREE.MeshStandardMaterial({ color: 0x3f6a2a, roughness: 0.9 }),
    // vehicles
    carBody: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.55 }),
    carGlass: new THREE.MeshStandardMaterial({ color: 0x1b222b, roughness: 0.08, metalness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.85 }),
    lightRed: new THREE.MeshStandardMaterial({ color: 0xb3161c, roughness: 0.3 }),
  };
  return m;
}

export type CampusMaterials = ReturnType<typeof createCampusMaterials>;

let shared: CampusMaterials | null = null;
/** One shared set (textures are generated once for the campus, the store lots and the landscaping). */
export const campusMaterials = () => (shared ??= createCampusMaterials());

/** Grass for the open land around the site: same lawn texture, slightly drier, tiled over a large ground. */
export function landMaterial(size: number): THREE.MeshStandardMaterial {
  const map = (campusMaterials().grass.map as THREE.Texture).clone();
  map.needsUpdate = true;
  map.repeat.set(size / 14, size / 14);
  return new THREE.MeshStandardMaterial({ map, color: 0xdfe0c8, roughness: 1 });
}

/** BoxGeometry whose UVs are in metres, so tiled textures keep their real-world scale on any box. */
export function boxGeometryM(w: number, h: number, d: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z (4 vertices each).
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++)
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
    }
  uv.needsUpdate = true;
  return g;
}

/** Plane lying on the ground (XZ) with metre UVs. */
export function groundPlaneM(w: number, d: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
  uv.needsUpdate = true;
  return g;
}
