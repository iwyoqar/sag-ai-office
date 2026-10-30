// Store buildings modelled after the owner's photos of each store (2026-10-30), with the new lowercase "saG" wordmark
// on the roof. A parametric facade kit (curtain glass, window grids, portal frame, fins, stripes, pilasters, gables,
// arched ribs, hip roof, glass setbacks, wood band) + one look per store. Stores without a confirmed photo get the
// standard SAG XL look. Matching is by the store name exactly as written in the owner's workbook.
import * as THREE from "three";
import logoUrl from "../../assets/sag-logo.png";

export interface StoreSign {
  /** main wordmark; "saG" = the official SAG logo (assets/sag-logo.png), anything else is drawn as text */
  text: string;
  /** e.g. "XL", "xs" next to the wordmark */
  suffix?: string;
  where: "roof" | "facade";
  /** small words left / right of the wordmark (e.g. "КОВРЫ", "GILAMLARI") */
  sides?: [string, string];
  color?: number;
}

export interface StoreLook {
  w: number; d: number; h: number; floors: number;
  wall: number;
  glass: "curtain" | "grid" | "ribbon" | "bays";
  /** curtain: covered part of the front, as fractions of the width */
  span?: [number, number];
  portal?: { w: number; h: number; color: number };
  fins?: { n: number; color: number };
  stripes?: { n: number; color: number };
  pilasters?: { n: number; color: number };
  gables?: { n: number; color: number };
  ribs?: { n: number; color: number };
  roof?: { color: number };
  setbacks?: number;
  band?: { color: number; h: number };
  sign: StoreSign;
  /** a second brand sign on the roof (Karmana: NARVARID) */
  second?: { text: string; color: number };
}

/** the logo's own blue (assets/sag-logo.png: rgb 27, 78, 155), used for every lettering next to it */
const BLUE = 0x1b4e9b;
const XL = (sides?: [string, string]): StoreSign => ({ text: "saG", suffix: "XL", where: "roof", sides });

/** Default for stores without a confirmed photo: the current SAG XL standard (beige stone, glass front, dark band). */
export const STANDARD_LOOK: StoreLook = {
  w: 22, d: 13, h: 9, floors: 2, wall: 0xe8e1d3, glass: "curtain", span: [0.12, 0.88],
  band: { color: 0x4a3f3a, h: 0.9 }, sign: XL(["КОВРЫ", "GILAMLAR"]),
};

export const HEAD_OFFICE_LOOK: StoreLook = {
  w: 26, d: 16, h: 14, floors: 3, wall: 0xd9d6cf, glass: "curtain", span: [0.08, 0.6],
  portal: { w: 8, h: 14, color: 0x9e958a }, sign: { text: "saG", where: "roof" },
};

/** Store name (as in the workbook) → look from its photo. */
export const STORE_LOOKS: Record<string, StoreLook> = {
  // Karmana: 3 storeys, beige stone piers, large glass curtain walls, "saG XL" + red "NARVARID"
  "Sag Navoiy (N.sh Karmana t K.9 uy)": {
    w: 26, d: 14, h: 13, floors: 3, wall: 0xe3d3b5, glass: "curtain", span: [0.06, 0.94], pilasters: { n: 4, color: 0xe3d3b5 },
    sign: { text: "saG", suffix: "XL", where: "roof" }, second: { text: "NARVARID", color: 0xc8202f },
  },
  // Urganch, Do'stov: grey fins, glass, wood band on top, grey central portal
  "Sag Urganch (Do'stov k)": {
    w: 26, d: 13, h: 10, floors: 2, wall: 0xb9bcc0, glass: "curtain", span: [0.02, 0.98], fins: { n: 7, color: 0xc9cbcf },
    band: { color: 0x8a4b33, h: 1.4 }, portal: { w: 7, h: 11, color: 0xa7abb1 }, sign: XL(["КОВРЫ", "GILAMLARI"]),
  },
  // Xiva: single tall storey, travertine, grid of large windows, roof letters
  "Sag Xiva": {
    w: 26, d: 13, h: 7.5, floors: 1, wall: 0xe6dcc8, glass: "grid", sign: XL(["КОВРЫ", "GILAMLARI"]),
  },
  // Termiz: cream two storeys, three gables, blue columns, glass ground floor, facade sign
  "Sag Termiz": {
    w: 24, d: 12, h: 9, floors: 2, wall: 0xefe6cf, glass: "ribbon", pilasters: { n: 4, color: 0x7f9fc2 }, gables: { n: 3, color: 0x7f9fc2 },
    sign: { text: "saG", suffix: "XL", where: "facade", sides: ["", "GILAMLAR"] },
  },
  // Nukus: white two storeys, dark portal frame with glass
  "Sag Nukus": {
    w: 22, d: 12, h: 10, floors: 2, wall: 0xf2f2f0, glass: "grid", portal: { w: 7, h: 10.5, color: 0x3a3d42 },
    sign: { text: "saG", where: "facade" },
  },
  // Bekobod: mirror glass, dark central portal, brown roof band
  "Sag Bekobod": {
    w: 24, d: 13, h: 8, floors: 2, wall: 0x5a6068, glass: "curtain", span: [0.02, 0.98], band: { color: 0x7a5244, h: 1 },
    portal: { w: 10, h: 9.5, color: 0x4a4f57 }, sign: { text: "saG", where: "roof" },
  },
  // Jizzax: three storeys of dark glass, grey floor bands, central dark tower, white sign band
  "Sag Jizzax Qahramon Mahallasi": {
    w: 26, d: 14, h: 13, floors: 3, wall: 0x8e949b, glass: "ribbon", portal: { w: 5, h: 14.5, color: 0x3b4048 },
    band: { color: 0xf4f4f2, h: 1.6 }, sign: { text: "saG", where: "facade", sides: ["КОВРЫ", "GILAMLAR"] },
  },
  // Navoiy, Islom Karimov: white arched ribs, brown infill, curved glass centre
  "Sag Navoiy (N.sh Islom Karimov shoh k)": {
    w: 24, d: 14, h: 10, floors: 2, wall: 0x5b3a2e, glass: "curtain", span: [0.33, 0.67], ribs: { n: 6, color: 0xf6f6f4 },
    sign: { text: "saG", where: "roof" },
  },
  // Jomboy: white single storey, green stripes, glass bays
  "Sag Jomboy": {
    w: 20, d: 11, h: 6.5, floors: 1, wall: 0xf7f7f5, glass: "bays", stripes: { n: 4, color: 0x2e9d48 },
    band: { color: 0x2e9d48, h: 0.25 }, sign: { text: "saG", where: "roof", sides: ["GILAMLAR", "КОВРЫ"] },
  },
  // Sergeli: long two storeys, beige with dark band, glass upper and lower ribbons
  "Sag Sergili": {
    w: 28, d: 13, h: 9, floors: 2, wall: 0xe9e2d4, glass: "ribbon", band: { color: 0x4a3f3a, h: 0.8 }, sign: XL(["КОВРЫ", "gilamlar"]),
  },
  // Qushbegi: white with maroon portal frame, big glass front
  "Sag Qushbegi": {
    w: 24, d: 13, h: 9, floors: 2, wall: 0xf5f5f3, glass: "curtain", span: [0.05, 0.95], portal: { w: 11, h: 9.6, color: 0x5a2e2a },
    sign: { text: "saG", suffix: "XL", where: "facade" },
  },
  // Urganch, Fidokorlar: white with maroon frames and pillars, dark glass centre
  "Sag Urganch (Fidokorlar k)": {
    w: 26, d: 13, h: 9, floors: 2, wall: 0xf3f1ee, glass: "grid", pilasters: { n: 6, color: 0x5b2b33 }, portal: { w: 10, h: 10, color: 0x5b2b33 },
    sign: { text: "saG", suffix: "XL", where: "facade", sides: ["КОВРЫ", "GILAMLAR"] },
  },
  // Hasanboy: three storeys, cream classical facade, red hip roof
  "Sag Xasanboy": {
    w: 24, d: 14, h: 11, floors: 3, wall: 0xf1e6d6, glass: "grid", pilasters: { n: 6, color: 0xe2d2bb }, roof: { color: 0xb8323f },
    sign: { text: "saG", where: "facade" },
  },
};

export function lookFor(name: string, isHeadOffice: boolean): StoreLook {
  if (isHeadOffice) return HEAD_OFFICE_LOOK;
  return STORE_LOOKS[name] ?? STANDARD_LOOK;
}

// ---- textures ---------------------------------------------------------------------------------------------------

/** Mirror-glass with mullions: a sky reflection gradient on a 1-cell canvas, repeated per panel. */
function glassTexture(dark: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, dark ? "#5d7897" : "#9cc6ea");
  grad.addColorStop(1, dark ? "#24364d" : "#3d6fa8");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.beginPath();
  g.moveTo(0, 80); g.lineTo(70, 0); g.lineTo(95, 0); g.lineTo(0, 110);
  g.fill();
  g.strokeStyle = "#2a2f36";
  g.lineWidth = 6;
  g.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const GLASS_TEX = { light: null as THREE.CanvasTexture | null, dark: null as THREE.CanvasTexture | null };

function glassMat(cellsX: number, cellsY: number, dark = false): THREE.MeshStandardMaterial {
  const key = dark ? "dark" : "light";
  const base = (GLASS_TEX[key] ??= glassTexture(dark));
  const map = base.clone();
  map.needsUpdate = true;
  map.repeat.set(Math.max(1, Math.round(cellsX)), Math.max(1, Math.round(cellsY)));
  return new THREE.MeshStandardMaterial({ map, roughness: 0.12, metalness: 0.25, emissive: 0x0b1a33, emissiveIntensity: 0.25 });
}

const SIGN_FONT = '"Century Gothic", "Futura", "Avenir Next", "Montserrat", "Trebuchet MS", sans-serif';

// ---- the official SAG logo (owner's file, 915 × 298), with any white background made transparent
const LOGO_ASPECT = 915 / 298;
let logoCanvas: HTMLCanvasElement | null = null;
const onLogo: (() => void)[] = [];
if (typeof Image !== "undefined") {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const min = Math.min(px.data[i], px.data[i + 1], px.data[i + 2]);
      if (min > 200) px.data[i + 3] = Math.round(px.data[i + 3] * Math.max(0, (255 - min) / 55)); // white → transparent, soft edge
    }
    g.putImageData(px, 0, 0);
    logoCanvas = c;
    for (const f of onLogo.splice(0)) f();
  };
  img.src = logoUrl;
}

/** The logo alone as a texture (aspect 915 : 298), optionally recoloured white (the blue reception wall). */
export function logoTexture(white = false): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 915;
  c.height = 298;
  const tex = new THREE.CanvasTexture(c);
  const draw = () => {
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(logoCanvas!, 0, 0, c.width, c.height);
    if (white) {
      g.globalCompositeOperation = "source-in";
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "source-over";
    }
    tex.needsUpdate = true;
  };
  if (logoCanvas) draw();
  else onLogo.push(draw);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A sign as a transparent texture: the official logo (text "saG") or plain text, plus an optional suffix ("XL", "xs").
 * Returns the width/height ratio. Until the logo image has loaded the texture is redrawn when it arrives.
 */
function signTexture(text: string, suffix: string | undefined, color: number, small = false): { tex: THREE.CanvasTexture; aspect: number } {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const H = 240;
  const isLogo = text === "saG";
  const main = `700 ${small ? 140 : 210}px ${SIGN_FONT}`;
  const sub = `800 ${small ? 90 : 130}px ${SIGN_FONT}`;
  const logoH = H * 0.86, logoW = logoH * LOGO_ASPECT;
  g.font = main;
  const w1 = isLogo ? logoW : g.measureText(text).width;
  g.font = sub;
  const gap = 30;
  const w2 = suffix ? g.measureText(suffix).width + gap : 0;
  c.width = Math.ceil(w1 + w2 + 20);
  c.height = H;
  const css = `#${color.toString(16).padStart(6, "0")}`;
  const tex = new THREE.CanvasTexture(c);
  const draw = () => {
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = css;
    g.textBaseline = "alphabetic";
    if (isLogo && logoCanvas) g.drawImage(logoCanvas, 10, (H - logoH) / 2, logoW, logoH);
    else {
      g.font = main;
      g.fillText(text, 10, H * 0.8);
    }
    if (suffix) {
      // the suffix sits on the logo's baseline, like "saG XL" on the stores
      g.font = sub;
      g.fillText(suffix, 10 + w1 + gap, isLogo ? (H + logoH) / 2 - logoH * 0.02 : H * 0.8);
    }
    tex.needsUpdate = true;
  };
  draw();
  if (isLogo && !logoCanvas) onLogo.push(draw);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  return { tex, aspect: c.width / H };
}

// ---- builder ----------------------------------------------------------------------------------------------------

const mats = new Map<number, THREE.MeshStandardMaterial>();
const mat = (c: number, rough = 0.8) => {
  let m = mats.get(c);
  if (!m) mats.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: rough })));
  return m;
};

function addBox(g: THREE.Group, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

function addPlane(g: THREE.Group, w: number, h: number, m: THREE.Material, x: number, y: number, z: number, rotY = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  g.add(mesh);
  return mesh;
}

/** A sign on posts above the roof, or flat on the facade. */
/** `lowY`: facade signs without a portal sit on a canopy above the ground floor (as in the photos), not under the roof. */
function addSign(g: THREE.Group, s: StoreSign, x: number, topY: number, frontZ: number, maxW: number, lowY?: number, backing = false) {
  const color = s.color ?? BLUE;
  const { tex, aspect } = signTexture(s.text, s.suffix, color);
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const h = Math.min(s.where === "roof" ? 2.4 : 2.0, (maxW * 0.45) / aspect);
  const w = h * aspect;
  const onRoof = s.where === "roof";
  const y = onRoof ? topY + 0.9 + h / 2 : lowY !== undefined ? lowY + 0.45 + h / 2 : topY - h / 2 - 0.5;
  const z = onRoof ? frontZ - 1.2 : lowY !== undefined ? frontZ + 1.05 : frontZ + 0.08;
  if (!onRoof && lowY !== undefined) addBox(g, Math.min(maxW * 0.7, h * aspect + 3), 0.35, 1.4, mat(0xf4f4f2, 0.5), x, lowY, frontZ + 0.7);
  // on a dark portal the logo sits on a white panel, as in the photos (Nukus, Qushbegi, Fidokorlar)
  if (backing) addBox(g, w + 1.2, h + 0.7, 0.12, mat(0xf7f7f5, 0.5), x, y - h / 2 - 0.35, z - 0.08);
  addPlane(g, w, h, m, x, y, z + (backing ? 0.02 : 0));
  if (onRoof)
    for (const px of [-w * 0.35, 0, w * 0.35]) addBox(g, 0.12, 0.9, 0.12, mat(0x6b7280), x + px, topY, z - 0.1);
  if (s.sides) {
    s.sides.forEach((word, i) => {
      if (!word) return;
      const t = signTexture(word, undefined, color, true);
      const sm = new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const sh = h * 0.42, sw = sh * t.aspect;
      const sx = x + (i === 0 ? -1 : 1) * (w / 2 + sw / 2 + 1.2);
      if (Math.abs(sx - x) + sw / 2 > maxW / 2 + 1) return; // keep the side words on the building
      addPlane(g, sw, sh, sm, sx, onRoof ? topY + 0.6 + sh / 2 : y - h * 0.1, z);
    });
  }
  return y + h / 2;
}

export interface BuiltStore {
  group: THREE.Group;
  hit: THREE.Mesh;
  outline: THREE.LineSegments;
  size: THREE.Vector3;
  /** footprint for the interior: x0..x1, z0..z1 */
  rect: { x0: number; x1: number; z0: number; z1: number };
}

/** Builds one store at (cx, cz), front facing +z, standing on the plot surface (y = 0.5). */
export function buildStore(look: StoreLook, cx: number, cz: number): BuiltStore {
  const g = new THREE.Group();
  const { w, d, h, floors } = look;
  const base = 0.5;
  const front = cz + d / 2;
  const floorH = h / floors;
  const wall = mat(look.wall, 0.85);

  if (look.setbacks) {
    for (let i = 0; i < look.setbacks; i++) {
      const k = 1 - i * 0.07;
      addBox(g, w * k, floorH, d * k, glassMat(w * k / 2, 2), cx, base + i * floorH, cz - i * 0.6);
    }
  } else addBox(g, w, h, d, wall, cx, base, cz);
  const top = base + h;

  // glass on the front
  const z = front + 0.04;
  if (look.glass === "curtain") {
    const [a, b] = look.span ?? [0.1, 0.9];
    const gw = w * (b - a), gx = cx - w / 2 + w * (a + b) / 2;
    addPlane(g, gw, h - 1.2, glassMat(gw / 1.8, floors * 2, look.wall < 0x808080), gx, base + 0.4 + (h - 1.2) / 2, z);
  } else if (look.glass === "grid") {
    const bays = Math.max(3, Math.floor(w / 4.2));
    const pitch = w / bays;
    for (let f = 0; f < floors; f++)
      for (let i = 0; i < bays; i++)
        addPlane(g, pitch * 0.72, floorH * 0.7, glassMat(2, 2), cx - w / 2 + pitch * (i + 0.5), base + f * floorH + floorH * 0.52, z);
  } else if (look.glass === "ribbon") {
    for (let f = 0; f < floors; f++)
      addPlane(g, w - 1.6, floorH * 0.62, glassMat((w - 1.6) / 1.6, 1, f > 0), cx, base + f * floorH + floorH * 0.5, z);
  } else {
    const bays = 3;
    const pitch = (w - 2) / bays;
    for (let i = 0; i < bays; i++) addPlane(g, pitch * 0.82, h * 0.62, glassMat(3, 2, true), cx - w / 2 + 1 + pitch * (i + 0.5), base + 0.3 + h * 0.31, z);
  }

  if (look.band) {
    // a cladding strip around the top of the walls (not a slab over the roof)
    const bm = mat(look.band.color, 0.7), bh = look.band.h, t = 0.25, y = top - bh + 0.05;
    addBox(g, w + 2 * t, bh, t, bm, cx, y, front + t / 2);
    addBox(g, w + 2 * t, bh, t, bm, cx, y, cz - d / 2 - t / 2);
    addBox(g, t, bh, d, bm, cx - w / 2 - t / 2, y, cz);
    addBox(g, t, bh, d, bm, cx + w / 2 + t / 2, y, cz);
  }
  if (look.fins)
    for (let i = 0; i <= look.fins.n; i++)
      addBox(g, 0.35, h - 0.4, 0.5, mat(look.fins.color), cx - w / 2 + (w / look.fins.n) * i, base, front + 0.25);
  if (look.stripes)
    for (let i = 0; i <= look.stripes.n; i++)
      addBox(g, 0.35, h - 0.3, 0.12, mat(look.stripes.color, 0.5), cx - w / 2 + 0.2 + ((w - 0.4) / look.stripes.n) * i, base, front + 0.06);
  if (look.pilasters)
    for (let i = 0; i <= look.pilasters.n; i++)
      addBox(g, 0.7, h, 0.4, mat(look.pilasters.color), cx - w / 2 + 0.35 + ((w - 0.7) / look.pilasters.n) * i, base, front + 0.2);
  if (look.ribs) {
    for (let i = 0; i <= look.ribs.n; i++) {
      const x = cx - w / 2 + 0.4 + ((w - 0.8) / look.ribs.n) * i;
      const rib = addBox(g, 0.8, h + 0.6, 0.7, mat(look.ribs.color, 0.5), x, base, front + 0.35);
      rib.rotation.z = (i - look.ribs.n / 2) * 0.05; // fan outwards like the arched ribs in the photo
    }
    // curved glass bay in the centre
    const r = w * 0.2;
    const bay = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.8, 24, 1, true, -Math.PI / 2, Math.PI), glassMat(8, 3, true));
    bay.position.set(cx, base + h * 0.45, front);
    bay.scale.z = 0.35;
    g.add(bay);
  }
  if (look.portal) {
    const p = look.portal;
    addBox(g, p.w, p.h, 1.2, mat(p.color, 0.6), cx, base, front + 0.3);
    addPlane(g, p.w - 1.4, p.h - 2.2, glassMat((p.w - 1.4) / 1.6, 4, true), cx, base + 0.4 + (p.h - 2.2) / 2, front + 0.92);
  }
  if (look.gables) {
    // small pitched dormers on the front edge of the roof (Termiz): cream face, coloured trim
    const tri = new THREE.Shape([new THREE.Vector2(-2.2, 0), new THREE.Vector2(2.2, 0), new THREE.Vector2(0, 1.9)]);
    const geo = new THREE.ExtrudeGeometry(tri, { depth: 1.6, bevelEnabled: false });
    const trim = new THREE.ExtrudeGeometry(new THREE.Shape([
      new THREE.Vector2(-2.5, -0.05), new THREE.Vector2(2.5, -0.05), new THREE.Vector2(0, 2.15),
    ]), { depth: 0.25, bevelEnabled: false });
    for (let i = 0; i < look.gables.n; i++) {
      const x = cx - w / 2 + (w / look.gables.n) * (i + 0.5);
      const body = new THREE.Mesh(geo, wall);
      body.position.set(x, top, front - 1.7);
      body.castShadow = true;
      const edge = new THREE.Mesh(trim, mat(look.gables.color, 0.6));
      edge.position.set(x, top, front - 0.15);
      edge.castShadow = true;
      const win = new THREE.Mesh(new THREE.CircleGeometry(0.55, 3), glassMat(1, 1, true));
      win.rotation.z = Math.PI / 2;
      win.position.set(x, top + 0.75, front + 0.12);
      g.add(body, edge, win);
    }
  }
  if (look.roof) {
    const hip = new THREE.Mesh(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1), mat(look.roof.color, 0.55));
    hip.rotation.y = Math.PI / 4;
    hip.scale.set(w + 1.2, 3.2, d + 1.2);
    hip.position.set(cx, top + 1.6, cz);
    hip.castShadow = true;
    g.add(hip);
  }
  // entrance: glass doors and steps
  addPlane(g, 3, 2.7, glassMat(2, 1, true), cx, base + 1.35, front + (look.portal ? 0.95 : 0.06));
  addBox(g, 5, 0.25, 1.2, mat(0x9ca3af), cx, base - 0.25, front + 1.2);

  // with a second brand on the roof (Karmana), the SAG sign takes the left half and the other brand the right half
  const onPortal = look.sign.where === "facade" && !!look.portal;
  const signX = look.second ? cx - w / 4 : cx;
  const signW = look.second ? w / 2 : onPortal ? look.portal!.w * 1.6 : w;
  const low = look.sign.where === "facade" && !onPortal ? base + floorH : undefined;
  const signTop = Math.max(top, addSign(g, look.sign, signX, look.roof ? top + 0.1 : top, front + (onPortal ? 0.95 : 0), signW, low, onPortal));
  if (look.second) {
    const { tex, aspect } = signTexture(look.second.text, undefined, look.second.color);
    const sw = Math.min(w / 2 - 1, 2.2 * aspect), sh = sw / aspect;
    addPlane(g, sw, sh, new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      cx + w / 4, top + 0.9 + sh / 2, front - 1.2);
    for (const px of [-sw * 0.35, sw * 0.35]) addBox(g, 0.12, 0.9, 0.12, mat(0x6b7280), cx + w / 4 + px, top, front - 1.3);
  }

  const fullH = Math.max(signTop, top + (look.roof ? 3.2 : 0)) - base;
  const hitGeo = new THREE.BoxGeometry(w + 0.6, fullH, d + 0.6);
  const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  hit.position.set(cx, base + fullH / 2, cz);
  g.add(hit);
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(hitGeo), new THREE.LineBasicMaterial({ color: 0x1d4ed8 }));
  outline.position.copy(hit.position);
  outline.visible = false;
  g.add(outline);
  return { group: g, hit, outline, size: new THREE.Vector3(w, fullH + base, d), rect: { x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 } };
}
