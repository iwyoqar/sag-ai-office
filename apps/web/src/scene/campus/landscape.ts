// Landscaping around the head office (visual system v2): a lawn park behind the office with footpaths, hedges and
// tree groves, a planted west lawn, and grass verges with trees along the parking courtyard. The office model itself
// is untouched; everything here sits on unused paving outside its footprint (layout.ts, see the HQ and ROADS rects).
import * as THREE from "three";
import { Batch } from "./batch";
import type { Instancer } from "./instancer";
import type { CampusMaterials } from "./materials";
import { treeGeometries } from "./site";
import { addTruck } from "./buildings";

const hash = (n: number) => {
  const x = Math.sin(n * 91.7 + 47.3) * 43758.5453;
  return x - Math.floor(x);
};

interface R { x0: number; x1: number; z0: number; z1: number }

const PARK: R = { x0: -44.5, x1: 18.8, z0: -134.5, z1: -14.6 };
const WEST: R = { x0: -44.5, x1: -21.2, z0: -14.6, z1: 12.6 };
const VERGE_W: R = { x0: -44.8, x1: -40.2, z0: 12.9, z1: 57.8 };
const VERGE_S: R = { x0: -40.2, x1: 47.8, z0: 58.2, z1: 59.8 };
/**
 * Planted islands in the parking courtyard: row ends on the west, the east ends of the shortened rows, and a median
 * down the drive aisle. All kept clear of the traffic lanes (world/network.ts: gate lane x 45–49, access diagonal).
 */
export const PARKING_ISLANDS: R[] = [
  { x0: -39.8, x1: -38.3, z0: 15, z1: 20 }, { x0: -39.8, x1: -38.3, z0: 34, z1: 44 }, { x0: -39.8, x1: -38.3, z0: 51.5, z1: 56.5 },
  { x0: 42.3, x1: 43.6, z0: 34, z1: 44 },
  { x0: -36, x1: -16, z0: 26.2, z1: 27.8 }, { x0: -8, x1: 20, z0: 26.2, z1: 27.8 }, { x0: 28, x1: 40, z0: 26.2, z1: 27.8 },
];
const PATH_X = -14; // north–south footpath through the park
const PATH_Z = -52; // east–west footpath

export function buildHqLandscape(m: CampusMaterials, inst: Instancer): THREE.Mesh[] {
  const b = new Batch();
  const lawn = (r: R) => b.box(r.x1 - r.x0, 0.1, r.z1 - r.z0, m.grass, (r.x0 + r.x1) / 2, -0.02, (r.z0 + r.z1) / 2, 0, false);
  for (const r of [PARK, WEST, VERGE_W, VERGE_S]) lawn(r);

  // footpaths (paving, a little proud of the lawn) with curbs
  b.box(3, 0.12, PARK.z1 - PARK.z0, m.paving, PATH_X, 0, (PARK.z0 + PARK.z1) / 2, 0, false);
  b.box(PARK.x1 - PARK.x0, 0.12, 3, m.paving, (PARK.x0 + PARK.x1) / 2, 0, PATH_Z, 0, false);
  b.add(new THREE.CylinderGeometry(5, 5, 0.13, 40), m.paving, { x: PATH_X, y: 0.065, z: PATH_Z }, {}, false); // small plaza
  b.add(new THREE.CylinderGeometry(2.4, 2.6, 0.5, 32), m.curb, { x: PATH_X, y: 0.25, z: PATH_Z });
  b.add(new THREE.CylinderGeometry(2.1, 2.1, 0.06, 32), m.mulch, { x: PATH_X, y: 0.52, z: PATH_Z }, {}, false);

  // clipped hedge along the back of the office and round the west lawn, with a gap for the path
  const hedge = (x0: number, x1: number, z0: number, z1: number) => b.box(x1 - x0, 1.1, z1 - z0, m.hedge, (x0 + x1) / 2, 0.05, (z0 + z1) / 2);
  hedge(PARK.x0 + 1, PATH_X - 2.2, -16.4, -15.6);
  hedge(PATH_X + 2.2, PARK.x1 - 1, -16.4, -15.6);
  hedge(WEST.x0 + 0.6, WEST.x0 + 1.4, WEST.z0 + 1, WEST.z1 - 1);
  for (let x = VERGE_S.x0 + 1; x < VERGE_S.x1 - 4; x += 9) hedge(x, x + 6.5, 58.6, 59.4);

  // planting beds against the office's west and back walls
  b.box(2.2, 0.06, 22, m.mulch, -22.6, 0.08, -0.5, 0, false);
  b.box(30, 0.06, 1.8, m.mulch, -2, 0.08, -14, 0, false);

  let n = 0;
  const r = () => hash(n++);
  const shrub = new THREE.IcosahedronGeometry(0.6, 1);
  shrub.scale(1, 0.8, 1);
  shrub.translate(0, 0.45, 0);
  const shrubAt = (x: number, z: number, s = 1) =>
    inst.add("hq-shrub", shrub, m.shrub, { x, y: 0.1, z }, { x: s, y: s * (0.8 + r() * 0.4), z: s }, { y: r() * 6 },
      new THREE.Color().setHSL(0.22 + r() * 0.07, 0.45, 0.3 + r() * 0.1));
  for (let z = -10.5; z < 10; z += 1.6) shrubAt(-22.6 + (r() - 0.5) * 0.6, z, 0.9);
  for (let x = -16; x < 12; x += 1.7) shrubAt(x, -14 + (r() - 0.5) * 0.5, 0.9);
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 5) shrubAt(PATH_X + Math.cos(a) * 1.3, PATH_Z + Math.sin(a) * 1.3, 0.75);

  const { trunk, crown } = treeGeometries();
  const tree = (x: number, z: number, s: number) => {
    inst.add("tree-trunk", trunk, m.trunk, { x, y: 0.08, z }, { x: s, y: s, z: s });
    inst.add("tree-crown", crown, m.leaves, { x, y: 0.08, z }, { x: s, y: s, z: s }, { y: r() * 6 },
      new THREE.Color().setHSL(0.21 + r() * 0.08, 0.42, 0.28 + r() * 0.1));
  };
  // park groves: a jittered grid, kept off the paths and the plaza
  for (let x = PARK.x0 + 4; x < PARK.x1 - 2; x += 8.5)
    for (let z = PARK.z0 + 4; z < PARK.z1 - 5; z += 8.5) {
      const tx = x + (r() - 0.5) * 4, tz = z + (r() - 0.5) * 4;
      if (Math.abs(tx - PATH_X) < 4 || Math.abs(tz - PATH_Z) < 4 || Math.hypot(tx - PATH_X, tz - PATH_Z) < 8) continue;
      if (r() < 0.22) continue; // clearings
      tree(tx, tz, 0.9 + r() * 0.6);
    }
  // avenue along the footpath
  for (let z = PARK.z0 + 6; z < PARK.z1 - 4; z += 7) {
    if (Math.abs(z - PATH_Z) < 6) continue;
    tree(PATH_X - 3.2, z, 1.0);
    tree(PATH_X + 3.2, z + 3.5, 1.0);
  }
  for (let z = WEST.z0 + 3; z < WEST.z1 - 2; z += 7.5) tree(-37 + (r() - 0.5) * 3, z, 1.1);
  for (let z = VERGE_W.z0 + 3; z < VERGE_W.z1; z += 7) tree(-42.5, z, 0.95);

  // parking courtyard: raised planted islands at the row ends and a tree median down the wide drive aisle
  // (the model's centre dashes at z = 27 run under it), with gaps where cars cross between the rows
  const island = (x0: number, x1: number, z0: number, z1: number, trees: boolean) => {
    b.box(x1 - x0, 0.2, z1 - z0, m.curb, (x0 + x1) / 2, 0.02, (z0 + z1) / 2);
    b.box(x1 - x0 - 0.3, 0.03, z1 - z0 - 0.3, m.grass, (x0 + x1) / 2, 0.22, (z0 + z1) / 2, 0, false);
    if (!trees) return;
    const long = x1 - x0 > z1 - z0;
    const len = long ? x1 - x0 : z1 - z0;
    const count = Math.max(1, Math.floor(len / 8));
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      tree(long ? x0 + (x1 - x0) * t : (x0 + x1) / 2, long ? (z0 + z1) / 2 : z0 + (z1 - z0) * t, 0.85);
    }
    for (let i = 0; i < len / 1.4; i++) {
      const t = (i + 0.5) / (len / 1.4);
      if (r() < 0.45) shrubAt(long ? x0 + (x1 - x0) * t : (x0 + x1) / 2 + (r() - 0.5) * 0.6, long ? (z0 + z1) / 2 + (r() - 0.5) * 0.6 : z0 + (z1 - z0) * t, 0.6);
    }
  };
  for (const r of PARKING_ISLANDS) island(r.x0, r.x1, r.z0, r.z1, true);

  // factory frontage on M37: lawn verge with a clipped hedge and a tree row in front of Factory A
  b.box(444 - 62.4, 0.1, 3.4, m.grass, (62.4 + 444) / 2, -0.02, 58.1, 0, false);
  for (let x = 66; x < 440; x += 14) {
    hedge(x, x + 9, 59.2, 59.8);
    tree(x + 11.5, 58.2, 0.95);
  }
  // service yard: two trucks waiting by the gate, nose out
  addTruck(inst, m, new THREE.Vector3(28, 0.03, -30), -Math.PI / 2);
  addTruck(inst, m, new THREE.Vector3(34, 0.03, -30), -Math.PI / 2);

  return b.build();
}
