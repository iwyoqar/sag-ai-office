// Procedural office furniture. Every piece is built from a few primitives merged into one geometry per material,
// so a fully furnished floor stays at a few hundred draw calls. Prototypes are built once and cloned
// (clones share geometry + materials). Local frame: +Z is the "front" of a piece, Y up, metres.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Prop } from "./plan";

export const MAT = {
  white: new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.55 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x30353c, roughness: 0.45, metalness: 0.55 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.25, metalness: 0.85 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.4 }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.9 }),
  sofa: new THREE.MeshStandardMaterial({ color: 0x8b98a3, roughness: 0.95 }),
  accentFabric: new THREE.MeshStandardMaterial({ color: 0xc8735a, roughness: 0.95 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xb98d5f, roughness: 0.6 }),
  felt: new THREE.MeshStandardMaterial({ color: 0xa7b0a2, roughness: 1 }),
  rug: new THREE.MeshStandardMaterial({ color: 0xd8cfbf, roughness: 1 }),
  cork: new THREE.MeshStandardMaterial({ color: 0xc9a77c, roughness: 1 }),
  pot: new THREE.MeshStandardMaterial({ color: 0xf1efea, roughness: 0.5 }),
  soil: new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x3f7f4c, roughness: 0.8 }),
  leaf2: new THREE.MeshStandardMaterial({ color: 0x5d9a50, roughness: 0.8 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xcfe3ef, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1, depthWrite: false }),
  paper: new THREE.MeshStandardMaterial({ color: 0xfbfaf6, roughness: 0.9 }),
  ceramic: new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.4 }),
  rack: new THREE.MeshStandardMaterial({ color: 0x1e2530, roughness: 0.5, metalness: 0.5 }),
};

const glow = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
const GLOW = {
  screen: glow(0x2b3a4f),
  chart: glow(0x5aa9e6),
  chart2: glow(0x7dd3a8),
  chart3: glow(0xf6b26b),
  led: glow(0x22d3ee),
  brain: glow(0xa78bfa),
};
const STICKY = [0xfde68a, 0xfbcfe8, 0xbfdbfe, 0xbbf7d0].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));

// ---- geometry helpers -------------------------------------------------------
type Part = THREE.BufferGeometry;
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0): Part => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  return g.translate(x, y, z);
};
const cyl = (r0: number, r1: number, h: number, x = 0, y = 0, z = 0, seg = 14): Part =>
  new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z);
const sph = (r: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): Part =>
  new THREE.SphereGeometry(r, 12, 9).scale(sx, sy, sz).translate(x, y, z);

/** Group of merged meshes, one per material. */
function piece(parts: [THREE.Material, Part[]][], shadow = true): THREE.Group {
  const g = new THREE.Group();
  for (const [mat, geos] of parts) {
    if (!geos.length) continue;
    const m = new THREE.Mesh(mergeGeometries(geos.map((p) => p.toNonIndexed()), false)!, mat);
    m.castShadow = shadow && !(mat as THREE.MeshStandardMaterial).transparent;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// ---- pieces -------------------------------------------------------------------
/** Ergonomic office chair facing +Z (the sitter looks toward +Z). Seat height 0.47 m. */
function chair(): THREE.Group {
  const fabric: Part[] = [
    box(0.48, 0.07, 0.46, 0, 0.47, 0), // seat
    box(0.44, 0.52, 0.05, 0, 0.82, -0.25).rotateX(0), // mesh back
    box(0.06, 0.04, 0.26, -0.27, 0.66, -0.02), box(0.06, 0.04, 0.26, 0.27, 0.66, -0.02), // arm pads
  ];
  const metal: Part[] = [
    cyl(0.03, 0.03, 0.34, 0, 0.27, 0), // gas lift
    box(0.03, 0.2, 0.03, -0.27, 0.56, -0.02), box(0.03, 0.2, 0.03, 0.27, 0.56, -0.02), // arm posts
    box(0.04, 0.32, 0.03, 0, 0.6, -0.25), // back spine
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    metal.push(box(0.3, 0.03, 0.04, Math.sin(a) * 0.15, 0.08, Math.cos(a) * 0.15, a + Math.PI / 2));
    metal.push(sph(0.03, Math.sin(a) * 0.3, 0.035, Math.cos(a) * 0.3));
  }
  return piece([[MAT.fabric, fabric], [MAT.metal, metal]]);
}

const DESK_W = 1.5, DESK_D = 0.75, GAP = 0.08;

/**
 * Back-to-back desk pod (2 rows × cols). Returns the group plus one screen mesh per seat in the same order
 * as plan.podSeats (north row west→east, then south row west→east), so screens can show agent status.
 */
export function deskPod(cols: number): { group: THREE.Group; screens: THREE.Mesh[] } {
  const white: Part[] = [], metal: Part[] = [], black: Part[] = [], felt: Part[] = [], ceramic: Part[] = [];
  const screens: THREE.Mesh[] = [];
  const screenGeo = new THREE.PlaneGeometry(0.56, 0.31);
  const group = new THREE.Group();
  const width = cols * (DESK_W + GAP);
  felt.push(box(width - 0.1, 0.42, 0.04, 0, 0.95, 0)); // privacy divider along the spine
  for (const row of [-1, 1]) {
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * (DESK_W + GAP);
      const z = row * (DESK_D / 2 + 0.02);
      white.push(box(DESK_W, 0.035, DESK_D, x, 0.735, z));
      // slim sled legs at both ends
      for (const lx of [-DESK_W / 2 + 0.05, DESK_W / 2 - 0.05]) {
        metal.push(box(0.035, 0.72, 0.035, x + lx, 0.36, z + row * 0.3));
        metal.push(box(0.035, 0.72, 0.035, x + lx, 0.36, z - row * 0.3));
        metal.push(box(0.035, 0.035, DESK_D - 0.1, x + lx, 0.02, z));
      }
      // monitor on an arm, facing the sitter (sitter is on the outside of the pod)
      const mz = z - row * 0.22;
      black.push(box(0.6, 0.36, 0.03, x, 1.06, mz));
      metal.push(box(0.04, 0.26, 0.04, x, 0.87, mz - row * 0.03), box(0.2, 0.015, 0.14, x, 0.76, mz - row * 0.03));
      black.push(box(0.42, 0.015, 0.14, x, 0.76, z + row * 0.05)); // keyboard
      black.push(box(0.06, 0.02, 0.1, x + 0.32, 0.76, z + row * 0.06)); // mouse
      ceramic.push(cyl(0.04, 0.035, 0.1, x - 0.5, 0.8, z + row * 0.1, 10)); // mug
      const s = new THREE.Mesh(screenGeo, GLOW.screen);
      s.position.set(x, 1.06, mz + row * 0.017);
      if (row === -1) s.rotation.y = Math.PI; // north row looks toward −Z…
      screens.push(s);
    }
  }
  // north row (row −1) seats are listed first by podSeats; reorder: they were pushed first already
  group.add(piece([[MAT.white, white], [MAT.metal, metal], [MAT.black, black], [MAT.felt, felt], [MAT.ceramic, ceramic]]));
  for (const s of screens) group.add(s);
  return { group, screens };
}

function meetingTable(): THREE.Group {
  return piece([
    [MAT.wood, [box(4.2, 0.05, 1.4, 0, 0.74, 0)]],
    [MAT.metal, [box(0.08, 0.7, 0.9, -1.5, 0.36, 0), box(0.08, 0.7, 0.9, 1.5, 0.36, 0), box(3.0, 0.06, 0.08, 0, 0.12, 0)]],
    [MAT.black, [box(0.3, 0.02, 0.2, 0, 0.775, 0)]],
  ]);
}

function wallScreen(): THREE.Group {
  const g = piece([[MAT.black, [box(2.4, 1.38, 0.06, 0, 1.75, 0)]]]);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.28), GLOW.chart);
  s.position.set(0, 1.75, 0.035);
  g.add(s);
  return g;
}

function analyticsWall(): THREE.Group {
  const g = piece([[MAT.black, [-2, 0, 2].map((x) => box(1.9, 1.1, 0.06, x, 1.7, 0))]]);
  [GLOW.chart, GLOW.chart2, GLOW.chart3].forEach((m, i) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.0), m);
    s.position.set((i - 1) * 2, 1.7, 0.035);
    g.add(s);
  });
  return g;
}

function credenza(w: number): THREE.Group {
  return piece([
    [MAT.white, [box(w, 0.7, 0.45, 0, 0.4, 0)]],
    [MAT.wood, [box(w + 0.02, 0.03, 0.47, 0, 0.765, 0)]],
    [MAT.metal, [box(0.04, 0.05, 0.4, -w / 2 + 0.1, 0.025, 0), box(0.04, 0.05, 0.4, w / 2 - 0.1, 0.025, 0)]],
  ]);
}

/** L-sofa: main run along X (back toward −Z), chaise at +X running toward +Z. */
function sofaL(): THREE.Group {
  return piece([
    [MAT.sofa, [
      box(4.0, 0.42, 1.0, 0, 0.25, 0), box(4.0, 0.45, 0.22, 0, 0.62, -0.39),
      box(1.0, 0.42, 1.2, 1.5, 0.25, 1.1), box(0.22, 0.45, 2.2, 1.89, 0.62, 0.6),
      box(0.2, 0.3, 1.0, -1.9, 0.52, 0),
    ]],
    [MAT.accentFabric, [box(0.45, 0.4, 0.14, -1.2, 0.6, -0.22, 0.15), box(0.45, 0.4, 0.14, 1.55, 0.6, -0.22, -0.3)]],
    [MAT.metal, [-1.9, 1.9].flatMap((x) => [box(0.05, 0.06, 0.05, x, 0.03, 0.4), box(0.05, 0.06, 0.05, x, 0.03, -0.4)])],
  ]);
}

function armchair(): THREE.Group {
  return piece([
    [MAT.accentFabric, [box(0.85, 0.36, 0.8, 0, 0.3, 0), box(0.85, 0.42, 0.18, 0, 0.66, -0.33), box(0.14, 0.24, 0.8, -0.38, 0.58, 0), box(0.14, 0.24, 0.8, 0.38, 0.58, 0)]],
    [MAT.wood, [[-0.35, -0.32], [0.35, -0.32], [-0.35, 0.32], [0.35, 0.32]].map(([x, z]) => cyl(0.025, 0.018, 0.14, x, 0.07, z, 8))],
  ]);
}

function coffeeTable(): THREE.Group {
  return piece([
    [MAT.wood, [cyl(0.6, 0.6, 0.04, 0, 0.42, 0, 28)]],
    [MAT.metal, [cyl(0.03, 0.03, 0.4, 0, 0.2, 0), cyl(0.25, 0.25, 0.02, 0, 0.01, 0, 20)]],
    [MAT.paper, [box(0.3, 0.02, 0.22, 0.1, 0.45, -0.1, 0.4)]],
  ]);
}

function rug(w: number, d: number): THREE.Group {
  return piece([[MAT.rug, [box(w, 0.012, d, 0, 0.006, 0)]]], false);
}

function moodboard(w: number): THREE.Group {
  const g = piece([[MAT.cork, [box(w, 1.3, 0.04, 0, 1.6, 0)]]]);
  for (let i = 0; i < 9; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.42 + (i % 3) * 0.08, 0.3 + (i % 2) * 0.1), i % 4 === 0 ? MAT.paper : STICKY[i % 4]);
    m.position.set(-w / 2 + 0.45 + (i % 5) * ((w - 0.9) / 4), 1.25 + Math.floor(i / 5) * 0.55 + (i % 2) * 0.08, 0.025);
    m.rotation.z = ((i * 37) % 9 - 4) * 0.02;
    g.add(m);
  }
  return g;
}

function shelf(w: number): THREE.Group {
  const wood: Part[] = [], white: Part[] = [], books: Part[] = [];
  for (const y of [0.02, 0.5, 0.98, 1.46]) wood.push(box(w, 0.03, 0.42, 0, y, 0));
  for (let x = -w / 2; x <= w / 2 + 0.01; x += w / 4) white.push(box(0.03, 1.5, 0.42, x, 0.75, 0));
  for (let i = 0; i < 14; i++) {
    const y = [0.03, 0.51, 0.99][i % 3];
    const h = 0.22 + ((i * 7) % 5) * 0.03;
    books.push(box(0.05 + (i % 3) * 0.02, h, 0.3, -w / 2 + 0.25 + ((i * 0.31) % (w - 0.5)), y + h / 2, 0));
  }
  return piece([[MAT.wood, wood], [MAT.white, white], [MAT.accentFabric, books]]);
}

function kanban(w: number): THREE.Group {
  const g = piece([
    [MAT.white, [box(w, 1.2, 0.04, 0, 1.4, 0)]],
    [MAT.metal, [box(0.04, 1.6, 0.04, -w / 2, 0.8, 0.04), box(0.04, 1.6, 0.04, w / 2, 0.8, 0.04), box(w, 0.03, 0.4, 0, 0.02, 0.1)]],
  ]);
  const cols = 4;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < 3 + (c % 2); r++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.14), STICKY[(c + r) % 4]);
      m.position.set(-w / 2 + (c + 0.5) * (w / cols) + ((r % 2) - 0.5) * 0.1, 1.82 - r * 0.2, 0.025);
      g.add(m);
    }
  return g;
}

function highTable(): THREE.Group {
  return piece([[MAT.wood, [box(1.6, 0.04, 0.8, 0, 1.05, 0)]], [MAT.metal, [box(0.06, 1.03, 0.6, -0.65, 0.52, 0), box(0.06, 1.03, 0.6, 0.65, 0.52, 0)]]]);
}

function stool(): THREE.Group {
  return piece([[MAT.fabric, [cyl(0.19, 0.19, 0.06, 0, 0.75, 0, 16)]], [MAT.chrome, [cyl(0.025, 0.025, 0.72, 0, 0.38, 0), cyl(0.2, 0.2, 0.02, 0, 0.01, 0, 16), cyl(0.15, 0.15, 0.02, 0, 0.3, 0, 16)]]]);
}

function displayStand(): THREE.Group {
  const g = piece([[MAT.white, [box(1.7, 0.9, 0.5, 0, 0.45, 0)]], [MAT.black, [box(1.4, 0.85, 0.05, 0, 1.45, -0.1)]], [MAT.metal, [box(0.06, 0.6, 0.06, 0, 0.98, -0.12)]]]);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.78), GLOW.chart3);
  s.position.set(0, 1.45, -0.07);
  g.add(s);
  return g;
}

function coffeePoint(): THREE.Group {
  return piece([
    [MAT.white, [box(2.4, 0.9, 0.62, 0, 0.45, 0), box(2.4, 0.7, 0.35, 0, 1.95, -0.13)]],
    [MAT.wood, [box(2.42, 0.04, 0.65, 0, 0.92, 0)]],
    [MAT.black, [box(0.4, 0.45, 0.35, -0.6, 1.17, -0.08)]],
    [MAT.chrome, [box(0.3, 0.05, 0.2, -0.6, 0.97, 0.05)]],
    [MAT.ceramic, [0.2, 0.35, 0.5].map((x) => cyl(0.04, 0.035, 0.1, x, 0.99, 0.1, 10))],
  ]);
}

/** Potted plant: white lathe pot + leaf clusters (deterministic variation from the position). */
function plant(tall: boolean, seed: number): THREE.Group {
  const pts = [[0, 0], [0.2, 0], [0.24, 0.05], [0.27, tall ? 0.55 : 0.4], [0.25, tall ? 0.56 : 0.41]].map(([r, y]) => new THREE.Vector2(r, y));
  const pot = new THREE.LatheGeometry(pts, 18);
  const top = tall ? 0.55 : 0.4;
  const leaves: Part[] = [], leaves2: Part[] = [];
  if (tall) {
    // sansevieria: upright blades
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + seed;
      const h = 0.7 + ((i * 13 + seed * 7) % 5) * 0.09;
      const blade = new THREE.BoxGeometry(0.07, h, 0.015).rotateZ(Math.sin(a) * 0.15).rotateX(Math.cos(a) * 0.15).rotateY(a);
      (i % 2 ? leaves : leaves2).push(blade.translate(Math.sin(a) * 0.08, top + h / 2, Math.cos(a) * 0.08));
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + seed;
      const r = 0.12 + (i % 3) * 0.04;
      (i % 2 ? leaves : leaves2).push(sph(0.17, Math.sin(a) * r, top + 0.2 + (i % 3) * 0.08, Math.cos(a) * r, 1, 0.8, 1));
    }
    leaves.push(sph(0.2, 0, top + 0.38, 0));
  }
  return piece([[MAT.pot, [pot]], [MAT.soil, [cyl(0.24, 0.24, 0.02, 0, top - 0.03, 0)]], [MAT.leaf, leaves], [MAT.leaf2, leaves2]]);
}

function bench(): THREE.Group {
  return piece([[MAT.wood, [box(2.0, 0.06, 0.45, 0, 0.45, 0)]], [MAT.metal, [box(0.05, 0.42, 0.4, -0.85, 0.21, 0), box(0.05, 0.42, 0.4, 0.85, 0.21, 0)]]]);
}

/** Floor-to-ceiling glass partition (built in world orientation: along X for rot 0, along +Z otherwise). */
function glassWall(p: Prop): THREE.Group {
  const len = p.w ?? 4;
  const alongZ = Math.abs(Math.sin(p.rot ?? 0)) > 0.7;
  const segs: [number, number][] = p.gap ? [[0, p.gap[0]], [p.gap[1], len]] : [[0, len]];
  const glass: Part[] = [], frame: Part[] = [];
  const H = 2.9;
  for (const [a, b] of segs) {
    const l = b - a, c = (a + b) / 2;
    const at = (g: Part) => (alongZ ? g.rotateY(Math.PI / 2).translate(0, 0, c) : g.translate(c, 0, 0));
    glass.push(at(box(l, H, 0.02, 0, H / 2, 0)));
    frame.push(at(box(l, 0.06, 0.06, 0, 0.03, 0)), at(box(l, 0.05, 0.06, 0, H, 0)));
    for (const e of [a, b]) frame.push(at(box(0.05, H, 0.07, e - c, H / 2, 0)));
  }
  const g = piece([[MAT.glass, glass], [MAT.white, frame]]);
  return g;
}

function serverRack(): THREE.Group {
  const g = piece([[MAT.rack, [box(0.85, 2.05, 0.85, 0, 1.025, 0)]], [MAT.black, [box(0.75, 1.85, 0.02, 0, 1.03, 0.43)]]]);
  for (let i = 0; i < 6; i++) {
    const led = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.025), GLOW.led);
    led.position.set(0, 0.45 + i * 0.28, 0.445);
    led.userData.blink = i;
    g.add(led);
  }
  return g;
}

function receptionDesk(): THREE.Group {
  const curve = new THREE.CylinderGeometry(2.6, 2.6, 1.08, 40, 1, true, -Math.PI / 2.6, (2 * Math.PI) / 2.6);
  curve.translate(0, 0.54, -1.8);
  const top = new THREE.CylinderGeometry(2.72, 2.72, 0.05, 40, 1, false, -Math.PI / 2.6, (2 * Math.PI) / 2.6).translate(0, 1.1, -1.8);
  return piece([[MAT.white, [curve]], [MAT.wood, [top]], [MAT.black, [box(0.55, 0.34, 0.03, -0.6, 1.33, -0.1), box(0.55, 0.34, 0.03, 0.6, 1.33, -0.1)]]]);
}

function brainCore(): THREE.Group {
  const g = piece([[MAT.white, [cyl(1.0, 1.15, 0.35, 0, 0.175, 0, 32)]], [MAT.metal, [cyl(1.05, 1.05, 0.04, 0, 0.37, 0, 32)]]]);
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 1), new THREE.MeshBasicMaterial({ color: 0x8b5cf6, wireframe: true, toneMapped: false }));
  const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 2), GLOW.brain);
  core.position.y = inner.position.y = 1.35;
  core.userData.spin = true;
  g.add(core, inner);
  return g;
}

function execDesk(): THREE.Group {
  return piece([
    [MAT.wood, [box(2.4, 0.06, 1.0, 0, 0.75, 0)]],
    [MAT.white, [box(0.5, 0.72, 0.9, -0.95, 0.36, 0), box(0.06, 0.6, 0.9, 1.15, 0.36, 0)]],
    [MAT.black, [box(0.7, 0.42, 0.03, 0.2, 1.05, -0.3)]],
    [MAT.paper, [box(0.3, 0.02, 0.22, -0.5, 0.79, 0.15, 0.2)]],
  ]);
}

function whiteboard(w: number): THREE.Group {
  const g = piece([[MAT.paper, [box(w, 1.1, 0.03, 0, 1.55, 0)]], [MAT.chrome, [box(w + 0.04, 0.04, 0.06, 0, 0.98, 0.02)]]]);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, 0.05), GLOW.chart);
  m.position.set(-w * 0.1, 1.75, 0.02);
  g.add(m);
  return g;
}

// ---- factory ------------------------------------------------------------------
const protos = new Map<string, THREE.Group>();
function cached(key: string, make: () => THREE.Group): THREE.Group {
  let p = protos.get(key);
  if (!p) protos.set(key, (p = make()));
  return p.clone();
}

export const chairInstance = () => cached("chair", chair);

/** World-placed object for a plan prop (`y0` = floor surface height). */
export function buildProp(p: Prop, y0: number): THREE.Group {
  const seed = Math.abs(Math.round(p.x * 7 + p.z * 13)) % 17;
  const g = (() => {
    switch (p.kind) {
      case "meetingTable": return cached("meetingTable", meetingTable);
      case "wallScreen": return cached("wallScreen", wallScreen);
      case "analyticsWall": return cached("analyticsWall", analyticsWall);
      case "credenza": return cached(`credenza:${p.w ?? 4}`, () => credenza(p.w ?? 4));
      case "sofaL": return cached("sofaL", sofaL);
      case "armchair": return cached("armchair", armchair);
      case "coffeeTable": return cached("coffeeTable", coffeeTable);
      case "rug": return rug(p.w ?? 3, p.d ?? 2);
      case "moodboard": return cached(`moodboard:${p.w ?? 3}`, () => moodboard(p.w ?? 3));
      case "shelf": return cached(`shelf:${p.w ?? 4}`, () => shelf(p.w ?? 4));
      case "kanban": return cached(`kanban:${p.w ?? 3}`, () => kanban(p.w ?? 3));
      case "highTable": return cached("highTable", highTable);
      case "stool": return cached("stool", stool);
      case "displayStand": return cached("displayStand", displayStand);
      case "coffeePoint": return cached("coffeePoint", coffeePoint);
      case "plant": return cached(`plant:${seed % 4}`, () => plant(false, seed % 4));
      case "plantTall": return cached(`plantTall:${seed % 3}`, () => plant(true, seed % 3));
      case "bench": return cached("bench", bench);
      case "glassWall": return glassWall(p);
      case "serverRack": return cached("serverRack", serverRack);
      case "receptionDesk": return cached("receptionDesk", receptionDesk);
      case "brainCore": return brainCore();
      case "execDesk": return cached("execDesk", execDesk);
      case "whiteboard": return cached(`whiteboard:${p.w ?? 2}`, () => whiteboard(p.w ?? 2));
    }
  })();
  g.position.set(p.x, y0, p.z);
  if (p.kind !== "glassWall") g.rotation.y = p.rot ?? 0;
  g.userData.kind = p.kind;
  return g;
}

export const glowMaterials = GLOW;
