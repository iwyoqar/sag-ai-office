// Procedural office worker: jointed skeleton (hips → spine → chest → neck → head; shoulders → elbows → hands;
// hips → knees → feet), ~1.75 m. Poses are joint-angle tables blended smoothly; the walk cycle is computed.
// Looks (skin, hair, clothes) come from a hash of the agent id, so each agent always looks the same.
import * as THREE from "three";
import type { PoseName } from "./behaviour";

const SKIN = [0xf1d3b8, 0xe2b48f, 0xc98e66, 0x9c6a48, 0x6e4a33];
const HAIR = [0x1e1a17, 0x3b2a20, 0x6b4a2e, 0xa77b4f, 0x2b2b2b, 0x8a8a8a];
const TOP = [0xf5f5f2, 0x2f4a6d, 0x7b8f6a, 0xc65f4b, 0x3d3d45, 0xe3d6bf, 0x5b6f8a, 0x9a6a8e, 0xd9a441];
const BOTTOM = [0x23262d, 0x3b4252, 0x5a4a3a, 0x2e3a4d, 0x6b6f76];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const mats = new Map<number, THREE.MeshStandardMaterial>();
const mat = (c: number, rough = 0.75) => {
  let m = mats.get(c);
  if (!m) mats.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: rough })));
  return m;
};
const SHOE = mat(0x1a1a1a, 0.5);

const GEO = {
  torso: new THREE.CapsuleGeometry(0.15, 0.3, 4, 12).scale(1.05, 1, 0.68),
  pelvis: new THREE.CapsuleGeometry(0.14, 0.08, 4, 12).scale(1.05, 1, 0.75),
  neck: new THREE.CylinderGeometry(0.045, 0.05, 0.1, 10),
  head: new THREE.SphereGeometry(0.105, 18, 14).scale(0.92, 1.08, 1),
  hairShort: new THREE.SphereGeometry(0.112, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.95, 1.05, 1.04),
  hairLong: new THREE.CapsuleGeometry(0.11, 0.12, 4, 14).scale(0.98, 1, 0.9),
  upperArm: new THREE.CapsuleGeometry(0.045, 0.22, 4, 8),
  foreArm: new THREE.CapsuleGeometry(0.038, 0.2, 4, 8),
  hand: new THREE.SphereGeometry(0.042, 10, 8).scale(0.8, 1.2, 0.5),
  thigh: new THREE.CapsuleGeometry(0.065, 0.34, 4, 10),
  shin: new THREE.CapsuleGeometry(0.05, 0.34, 4, 10),
  foot: new THREE.BoxGeometry(0.09, 0.06, 0.24),
  shadow: new THREE.CircleGeometry(0.3, 20),
  badge: new THREE.BoxGeometry(0.07, 0.095, 0.01),
  lanyard: new THREE.TorusGeometry(0.075, 0.006, 4, 16, Math.PI).rotateZ(Math.PI).rotateX(-0.35),
};
const BADGE = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x334155, emissiveIntensity: 0.15 });
const LANYARD = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.7 });
const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false });

/** Joint angles (radians). Positive x bends a limb backward, negative forward (character faces +Z). */
interface Pose {
  hipY: number; // pelvis height above the floor
  hipZ: number; // pelvis forward offset
  spine: number; // forward lean (−) / back lean (+)
  head: [number, number, number]; // x (nod), y (turn), z (tilt)
  lArm: [number, number, number]; // shoulder x, shoulder z (out), elbow x
  rArm: [number, number, number];
  lLeg: [number, number]; // hip x, knee x
  rLeg: [number, number];
}

const STAND: Pose = { hipY: 0.94, hipZ: 0, spine: 0, head: [0, 0, 0], lArm: [0.05, 0.08, -0.1], rArm: [0.05, -0.08, -0.1], lLeg: [0, 0], rLeg: [0, 0] };
const SIT: Pose = { ...STAND, hipY: 0.57, hipZ: -0.04, lLeg: [-1.5, 1.45], rLeg: [-1.5, 1.45], spine: 0.05 };

const POSES: Record<Exclude<PoseName, "walk">, Pose> = {
  stand: STAND,
  sitRelax: { ...SIT, spine: 0.18, head: [0.05, 0, 0], lArm: [-0.45, 0.1, -0.55], rArm: [-0.45, -0.1, -0.55] },
  sitType: { ...SIT, spine: -0.12, head: [0.18, 0, 0], lArm: [-0.55, 0.12, -1.15], rArm: [-0.55, -0.12, -1.15] },
  sitThink: { ...SIT, spine: -0.05, head: [0.05, 0.12, 0.12], lArm: [-0.45, 0.1, -0.7], rArm: [-0.9, -0.25, -2.3] },
  sitTalk: { ...SIT, spine: -0.05, head: [0, 0, 0], lArm: [-0.6, 0.15, -1.2], rArm: [-0.5, -0.15, -1.0] },
  sitBlocked: { ...SIT, spine: 0.12, head: [0.42, 0, 0], lArm: [-0.25, 0.1, -0.35], rArm: [-0.25, -0.1, -0.35] },
  standWait: { ...STAND, head: [0.05, -0.15, 0], lArm: [-0.25, 0.25, -1.9], rArm: [-0.25, -0.25, -1.9] },
  standError: { ...STAND, spine: -0.05, head: [0.15, 0, 0], lArm: [-2.6, 0.55, -1.7], rArm: [-2.6, -0.55, -1.7] },
  celebrate: { ...STAND, head: [-0.2, 0, 0], lArm: [-2.9, 0.35, -0.2], rArm: [-2.9, -0.35, -0.2] },
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function blend(a: Pose, b: Pose, k: number): Pose {
  const v3 = (x: [number, number, number], y: [number, number, number]) => x.map((v, i) => lerp(v, y[i], k)) as [number, number, number];
  const v2 = (x: [number, number], y: [number, number]) => [lerp(x[0], y[0], k), lerp(x[1], y[1], k)] as [number, number];
  return {
    hipY: lerp(a.hipY, b.hipY, k), hipZ: lerp(a.hipZ, b.hipZ, k), spine: lerp(a.spine, b.spine, k),
    head: v3(a.head, b.head), lArm: v3(a.lArm, b.lArm), rArm: v3(a.rArm, b.rArm), lLeg: v2(a.lLeg, b.lLeg), rLeg: v2(a.rLeg, b.rLeg),
  };
}

export class Character {
  readonly root = new THREE.Group();
  readonly meshes: THREE.Mesh[] = [];
  private hips = new THREE.Group();
  private chest = new THREE.Group();
  private headJ = new THREE.Group();
  private sh: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private el: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private hp: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private kn: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private current: Pose = { ...STAND };
  private phase: number;
  /** target pose; "walk" uses the procedural cycle */
  pose: PoseName = "stand";
  /** metres per second while walking (drives the cycle) */
  speed = 0;
  private walkT = 0;

  /** `human`: a real employee - wears an ID badge on a lanyard (AI agents never do), so the two read differently. */
  constructor(readonly id: string, readonly human = false) {
    const h = hash(id);
    this.phase = (h % 1000) / 159;
    const skin = mat(SKIN[h % SKIN.length], 0.7);
    const hair = mat(HAIR[(h >>> 4) % HAIR.length], 0.85);
    const top = mat(TOP[(h >>> 8) % TOP.length], 0.8);
    const bottom = mat(BOTTOM[(h >>> 12) % BOTTOM.length], 0.85);
    const longHair = ((h >>> 16) & 3) === 0;

    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    };

    // pelvis & spine
    this.root.add(this.hips);
    add(this.hips, GEO.pelvis, bottom, 0, 0.06, 0);
    this.hips.add(this.chest);
    this.chest.position.y = 0.1;
    add(this.chest, GEO.torso, top, 0, 0.25, 0);
    add(this.chest, GEO.neck, skin, 0, 0.52, 0);
    this.chest.add(this.headJ);
    this.headJ.position.y = 0.56;
    add(this.headJ, GEO.head, skin, 0, 0.1, 0.005);
    add(this.headJ, longHair ? GEO.hairLong : GEO.hairShort, hair, 0, longHair ? 0.06 : 0.12, longHair ? -0.03 : -0.005);

    // arms
    for (const s of [0, 1] as const) {
      const side = s === 0 ? 1 : -1; // left = +X
      const shoulder = this.sh[s];
      shoulder.position.set(side * 0.2, 0.47, 0);
      this.chest.add(shoulder);
      add(shoulder, GEO.upperArm, top, 0, -0.14, 0);
      const elbow = this.el[s];
      elbow.position.y = -0.29;
      shoulder.add(elbow);
      add(elbow, GEO.foreArm, skin, 0, -0.13, 0);
      add(elbow, GEO.hand, skin, 0, -0.29, 0);

      const hip = this.hp[s];
      hip.position.set(side * 0.09, 0, 0);
      this.hips.add(hip);
      add(hip, GEO.thigh, bottom, 0, -0.22, 0);
      const knee = this.kn[s];
      knee.position.y = -0.44;
      hip.add(knee);
      add(knee, GEO.shin, bottom, 0, -0.21, 0);
      add(knee, GEO.foot, SHOE, 0, -0.45, 0.05);
    }
    if (human) {
      add(this.chest, GEO.badge, BADGE, 0, 0.3, 0.115).castShadow = false;
      add(this.chest, GEO.lanyard, LANYARD, 0, 0.42, 0.1).castShadow = false;
    }
    const shadow = new THREE.Mesh(GEO.shadow, SHADOW_MAT);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    shadow.renderOrder = -1;
    this.root.add(shadow);
    this.apply(STAND, 0);
  }

  /** Advance animation by dt seconds (t = absolute time for idle motion). */
  update(dt: number, t: number) {
    let target: Pose;
    if (this.pose === "walk") {
      this.walkT += dt * (this.speed / 1.3) * 2 * Math.PI * 0.95;
      const s = Math.sin(this.walkT), c = Math.cos(this.walkT);
      target = {
        ...STAND, spine: -0.04, hipY: 0.94 + Math.abs(c) * 0.025,
        lLeg: [-s * 0.45, Math.max(0, s) * 0.7 + 0.08], rLeg: [s * 0.45, Math.max(0, -s) * 0.7 + 0.08],
        lArm: [s * 0.4, 0.08, -0.25], rArm: [-s * 0.4, -0.08, -0.25],
      };
    } else target = POSES[this.pose];
    const k = Math.min(1, Math.max(0, 1 - Math.exp(-dt * (this.pose === "walk" ? 14 : 6))));
    this.current = blend(this.current, target, k);
    this.apply(this.current, t);
  }

  private apply(p: Pose, t: number) {
    const ph = this.phase;
    // decorative only: breathing, typing, head motion — never invents work
    const breathe = Math.sin(t * 1.6 + ph) * 0.012;
    let headY = p.head[1], armJit = 0, hop = 0, talk = 0;
    switch (this.pose) {
      case "sitType": armJit = Math.sin(t * 14 + ph) * 0.06; break;
      case "sitThink": headY += Math.sin(t * 0.6 + ph) * 0.15; break;
      case "sitTalk": headY += Math.sin(t * 1.3 + ph) * 0.45; talk = Math.sin(t * 2.4 + ph) * 0.25; break;
      case "standWait": headY += Math.sin(t * 0.8 + ph) * 0.3; break;
      case "celebrate": { const q = (t + ph) % 2.2; hop = q < 0.4 ? Math.sin((q / 0.4) * Math.PI) * 0.1 : 0; break; }
      case "standError": armJit = Math.sin(t * 5) * 0.05; break;
    }
    this.hips.position.set(0, p.hipY + hop, p.hipZ);
    this.chest.rotation.x = -p.spine + breathe; // spine: + = lean back
    this.headJ.rotation.set(p.head[0], headY, p.head[2]);
    const arms = [p.lArm, p.rArm];
    for (const s of [0, 1] as const) {
      const [sx, sz, ex] = arms[s];
      this.sh[s].rotation.set(sx + (s === 0 ? armJit : -armJit) + (s === 1 ? talk : 0), 0, sz);
      this.el[s].rotation.set(ex + (s === 0 ? -armJit : armJit), 0, 0);
      const [hx, kx] = s === 0 ? p.lLeg : p.rLeg;
      this.hp[s].rotation.x = hx;
      this.kn[s].rotation.x = kx;
    }
  }

  get headHeight() {
    return this.hips.position.y + 0.1 + 0.56 + 0.22;
  }
}
