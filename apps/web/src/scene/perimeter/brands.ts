// Company logo assets. The primary SAG logo is the official file already used on the gate wall (assets/sag-logo.png);
// the other ten are cut from the owner's brand sheet without redrawing or recolouring (background made transparent).
// Replacing a PNG with a higher-resolution original keeps everything working: only the aspect below must match it.
import * as THREE from "three";
import sag from "../../assets/sag-logo.png";
import sagFlooring from "../../assets/brands/sag-flooring.png";
import sagHomeDesign from "../../assets/brands/sag-home-design.png";
import sagGardens from "../../assets/brands/sag-gardens.png";
import maroqandKlaster from "../../assets/brands/maroqand-klaster.png";
import turboPlast from "../../assets/brands/turbo-plast.png";
import set from "../../assets/brands/set.png";
import jarkurgan from "../../assets/brands/jarkurgan-plastic-recycling.png";
import seal from "../../assets/brands/seal.png";
import bionurMed from "../../assets/brands/bionur-med.png";
import casva from "../../assets/brands/casva.png";

/** logo key → image url and pixel size (width / height = the logo's own aspect ratio) */
export const LOGOS: Record<string, { url: string; w: number; h: number }> = {
  sag: { url: sag, w: 915, h: 298 },
  "sag-flooring": { url: sagFlooring, w: 101, h: 55 },
  "sag-home-design": { url: sagHomeDesign, w: 124, h: 52 },
  "sag-gardens": { url: sagGardens, w: 173, h: 54 },
  "maroqand-klaster": { url: maroqandKlaster, w: 165, h: 56 },
  "turbo-plast": { url: turboPlast, w: 203, h: 28 },
  set: { url: set, w: 145, h: 56 },
  "jarkurgan-plastic-recycling": { url: jarkurgan, w: 162, h: 56 },
  seal: { url: seal, w: 54, h: 55 },
  "bionur-med": { url: bionurMed, w: 81, h: 55 },
  casva: { url: casva, w: 201, h: 54 },
};

export interface LogoMaterial {
  mat: THREE.MeshBasicMaterial;
  aspect: number;
}

const cache = new Map<string, LogoMaterial>();

/** The logo as an unlit (sign-lit) material: original colours, never tone-mapped, alpha from the PNG. */
export function logoMaterial(key: string): LogoMaterial {
  let l = cache.get(key);
  if (l) return l;
  const src = LOGOS[key];
  if (!src) throw new Error(`unknown logo ${key}`);
  const map = new THREE.TextureLoader().load(src.url);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  l = {
    mat: new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.04, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    aspect: src.w / src.h,
  };
  cache.set(key, l);
  return l;
}
