import * as THREE from "three";

function puffTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  // Several overlapping soft blobs give a lumpy cumulus edge instead of a perfect disc.
  const blobs = [
    [0.5, 0.55, 0.42], [0.34, 0.6, 0.28], [0.66, 0.6, 0.3], [0.45, 0.42, 0.26], [0.6, 0.45, 0.24],
  ];
  for (const [x, y, r] of blobs) {
    const grad = g.createRadialGradient(x * s, y * s, 0, x * s, y * s, r * s);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.55, "rgba(250,252,255,0.55)");
    grad.addColorStop(1, "rgba(240,246,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Cluster {
  group: THREE.Group;
  base: THREE.Vector3;
  away: THREE.Vector3;
  pathT: number;
  sprites: THREE.Sprite[];
}

/** Volumetric-looking cloud bank along the intro camera path. Clusters part sideways as the camera passes. */
export class CloudBank {
  readonly root = new THREE.Group();
  private clusters: Cluster[] = [];
  private tex = puffTexture();
  private mats: THREE.SpriteMaterial[] = [];

  /** `scale` sizes the bank to the shot: 1 ≈ single-building framing, larger for the whole campus. */
  constructor(path: THREE.Curve<THREE.Vector3>, count = 16, seed = 11, private scale = 1) {
    const S = scale;
    let r = seed;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const t = 0.04 + (i / count) * 0.78;
      const p = path.getPointAt(t);
      const tangent = path.getTangentAt(t);
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(side, tangent).normalize();
      const ang = rnd() * Math.PI * 2;
      const rad = (7 + rnd() * 16) * S;
      const away = side.clone().multiplyScalar(Math.cos(ang)).add(up.clone().multiplyScalar(Math.sin(ang) * 0.6)).normalize();
      const base = p.clone().addScaledVector(away, rad);
      const group = new THREE.Group();
      group.position.copy(base);
      const sprites: THREE.Sprite[] = [];
      const n = 6 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const m = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0.9, fog: false });
        m.color.setHSL(0.6, 0.25, 0.94 + rnd() * 0.06);
        this.mats.push(m);
        const sp = new THREE.Sprite(m);
        const sc = (14 + rnd() * 18) * S;
        sp.scale.set(sc, sc * 0.7, 1);
        sp.position.set((rnd() - 0.5) * 22 * S, (rnd() - 0.5) * 7 * S, (rnd() - 0.5) * 16 * S);
        group.add(sp);
        sprites.push(sp);
      }
      this.root.add(group);
      this.clusters.push({ group, base, away, pathT: t, sprites });
    }
  }

  /** k = intro progress 0..1. Clusters drift outward and fade once the camera reaches them. */
  update(k: number, time: number): void {
    for (const c of this.clusters) {
      const passed = THREE.MathUtils.clamp((k - c.pathT + 0.12) / 0.2, 0, 1);
      const spread = 1 + passed * 2.2 + k * 0.4;
      c.group.position.copy(c.base).addScaledVector(c.away, (spread - 1) * 14 * this.scale);
      c.group.position.y += Math.sin(time * 0.0004 + c.pathT * 9) * 0.6 * this.scale;
      const fade = 1 - passed;
      for (const s of c.sprites) (s.material as THREE.SpriteMaterial).opacity = 0.9 * fade;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.tex.dispose();
    for (const m of this.mats) m.dispose();
  }
}
