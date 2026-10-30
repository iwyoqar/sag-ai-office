// RooftopLogo: a lit logo panel on a steel frame standing on a roof, facing the aerial camera (+z, tilted back), and
// the smaller facade-mounted version used on the office buildings.
import * as THREE from "three";
import type { Batch } from "../campus/batch";
import type { LogoMaterial } from "./brands";
import type { PerimeterMaterials } from "./facade";

const TILT = THREE.MathUtils.degToRad(14);

export interface SignSpot {
  /** centre x of the panel, roof level, and the roof's +z edge */
  x: number; roofY: number; zEdge: number;
  /** room on the roof along x, and the largest panel height wanted */
  maxW: number; maxH: number;
  /** posts lifting the panel clear of the parapet */
  lift?: number;
}

/** Panel size for a logo: as tall as allowed, narrowed to fit, always at the logo's own aspect ratio. */
export function signSize(aspect: number, maxW: number, maxH: number) {
  const pad = 0.12; // white margin round the artwork, as a fraction of the panel height
  let h = maxH, w = h * aspect + h * pad * 2;
  if (w > maxW) {
    w = maxW;
    h = w / (aspect + pad * 2);
  }
  return { w, h, art: { w: w - h * pad * 2, h: h * (1 - pad * 2) } };
}

export function rooftopLogo(b: Batch, logo: LogoMaterial, m: PerimeterMaterials, s: SignSpot) {
  const { w, h, art } = signSize(logo.aspect, s.maxW, s.maxH);
  const lift = s.lift ?? 1.4;
  const zc = s.zEdge - 2.2; // set back from the parapet
  const yc = s.roofY + lift + (h / 2) * Math.cos(TILT);
  const lean = (h / 2) * Math.sin(TILT); // panel centre leans back by this much
  const rot = { x: -TILT };
  // backing panel (lit white face), artwork just in front of it, light bar along the bottom edge
  b.add(new THREE.BoxGeometry(w, h, 0.35), m.signBack, { x: s.x, y: yc, z: zc - lean }, rot);
  const ny = Math.sin(TILT) * 0.2, nz = Math.cos(TILT) * 0.2; // 0.2 m along the panel normal
  b.add(new THREE.PlaneGeometry(art.w, art.h), logo.mat, { x: s.x, y: yc + ny, z: zc - lean + nz }, rot, false);
  b.add(new THREE.BoxGeometry(w * 0.96, 0.22, 0.3), m.lightBar, { x: s.x, y: s.roofY + lift - 0.05, z: zc + 0.35 }, {}, false);
  // steel frame: posts behind the panel, a rail under it, raking struts back to the roof
  const posts = Math.max(2, Math.ceil(w / 6) + 1);
  const backZ = zc - lean * 2 - 0.5;
  for (let i = 0; i < posts; i++) {
    const x = s.x - w / 2 + 0.4 + (i * (w - 0.8)) / (posts - 1);
    const top = s.roofY + lift + h * Math.cos(TILT) - 0.4;
    b.box(0.3, top - s.roofY, 0.3, m.steel, x, s.roofY, backZ + 0.4);
    const len = Math.hypot(top - s.roofY, 3);
    b.add(new THREE.BoxGeometry(0.18, len, 0.18), m.steel, { x, y: s.roofY + (top - s.roofY) / 2, z: backZ - 1.1 }, { x: Math.atan2(3, top - s.roofY) });
    b.box(0.6, 0.12, 0.6, m.steel, x, s.roofY, backZ - 2.6); // base plate of the strut
  }
  b.box(w, 0.3, 0.3, m.steel, s.x, s.roofY + lift - 0.3, zc - 0.1);
}

/** A logo panel fixed to a facade facing +z, near the top: for office buildings that are not the company tower. */
export function facadeLogo(b: Batch, logo: LogoMaterial, m: PerimeterMaterials, x: number, yTop: number, zFace: number, maxW: number, maxH: number) {
  const { w, h, art } = signSize(logo.aspect, maxW, maxH);
  const y = yTop - h / 2 - 0.8;
  b.add(new THREE.BoxGeometry(w, h, 0.3), m.signBack, { x, y, z: zFace + 0.35 });
  b.add(new THREE.PlaneGeometry(art.w, art.h), logo.mat, { x, y, z: zFace + 0.52 }, {}, false);
}
