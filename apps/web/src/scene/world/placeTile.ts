// Hover marker for placing a new store on the map: a flat black square (20 % opacity) the size of one store lot,
// lying on the ground, with a crisp white "+" in its centre. It fades in and out quickly (no other animation) and is
// depth-tested, so buildings and trees in front of it hide it as they should.
import * as THREE from "three";

const OPACITY = 0.2;
const FADE_PER_S = 9; // ~110 ms to full

function plusTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  const t = 14, len = 92, o = (128 - len) / 2;
  g.beginPath();
  g.roundRect(64 - t / 2, o, t, len, t / 2);
  g.roundRect(o, 64 - t / 2, len, t, t / 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class PlaceTile {
  readonly root = new THREE.Group();
  private square: THREE.MeshBasicMaterial;
  private plus: THREE.MeshBasicMaterial;
  private level = 0;
  private target = 0;
  /** the slot the marker currently shows (null: hidden or fading out) */
  slot: { gridX: number; gridZ: number } | null = null;

  constructor(width: number, depth: number) {
    this.root.name = "place-tile";
    this.square = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.plus = new THREE.MeshBasicMaterial({ map: plusTexture(), transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    const sq = new THREE.Mesh(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2), this.square);
    const icon = new THREE.Mesh(new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2), this.plus);
    icon.position.y = 0.02;
    sq.renderOrder = 5;
    icon.renderOrder = 6;
    this.root.add(sq, icon);
    this.root.visible = false;
  }

  /** Show the marker on a free slot (lot centre cx, cz), or hide it with null. */
  set(slot: { gridX: number; gridZ: number; cx: number; cz: number } | null) {
    if (slot) {
      this.root.position.set(slot.cx, 0.12, slot.cz);
      this.slot = { gridX: slot.gridX, gridZ: slot.gridZ };
      this.target = 1;
    } else {
      this.slot = null;
      this.target = 0;
    }
  }

  /** Per frame: ease the fade; true while it is still changing. */
  step(dt: number): boolean {
    if (this.level === this.target) return false;
    const d = FADE_PER_S * dt;
    this.level = this.target > this.level ? Math.min(this.target, this.level + d) : Math.max(this.target, this.level - d);
    this.square.opacity = OPACITY * this.level;
    this.plus.opacity = this.level;
    this.root.visible = this.level > 0;
    return true;
  }
}
