// Draws the road surfaces that the graph marks as `draw` (district streets, the link road) and the M37 roundabout:
// asphalt with world-space UVs (overlapping junction pieces line up seamlessly), centre dashes that stop short of
// junctions, zebra crossings on junction approaches, and a planted roundabout island. One mesh per material.
import * as THREE from "three";
import { campusMaterials } from "../campus/materials";
import { Batch } from "../campus/batch";
import type { RoadGraph } from "./roads";
import { ROUNDABOUT } from "./network";

const ROAD_Y = 0.06;
const MARK_Y = 0.075;

/** Flat quad from a to b, `width` wide, at height y, UVs in world metres. */
function strip(ax: number, az: number, bx: number, bz: number, width: number, y: number): THREE.BufferGeometry {
  const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
  const nx = (-dz / L) * (width / 2), nz = (dx / L) * (width / 2);
  const p = [ax + nx, az + nz, ax - nx, az - nz, bx + nx, bz + nz, bx - nx, bz - nz];
  const pos = new Float32Array([p[0], y, p[1], p[2], y, p[3], p[4], y, p[5], p[6], y, p[7]]);
  const uv = new Float32Array([p[0], -p[1], p[2], -p[3], p[4], -p[5], p[6], -p[7]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  // winding so the face points up (+y)
  const up = (p[2] - p[0]) * (p[5] - p[1]) - (p[3] - p[1]) * (p[4] - p[0]) < 0;
  g.setIndex(up ? [0, 1, 2, 2, 1, 3] : [0, 2, 1, 2, 3, 1]);
  return g;
}

let markMat: THREE.MeshStandardMaterial | null = null;
const markings = () =>
  (markMat ??= new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));

/**
 * Road surfaces for every drawn edge accepted by `keep` (e.g. only the district in the store-account view).
 * Returns merged meshes ready to add to the scene.
 */
export function renderRoads(g: RoadGraph, keep: (ax: number, az: number, bx: number, bz: number) => boolean = () => true): THREE.Mesh[] {
  const m = campusMaterials();
  const b = new Batch();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => b.add(geo, mat, { x: 0, y: 0, z: 0 }, {}, false);
  for (const e of g.edges) {
    if (!e.draw) continue;
    const A = g.nodes[e.a], B = g.nodes[e.b];
    if (!keep(A.x, A.z, B.x, B.z)) continue;
    const dx = (B.x - A.x) / e.len, dz = (B.z - A.z) / e.len;
    // surface: extended by half a width at junction ends so the junction square is paved; cut back at the roundabout
    const ext = (n: number) => (g.nodes[n].ring ? -(ROUNDABOUT.outer - 1) : g.degree(n) >= 2 ? e.width / 2 : 0);
    const ea = ext(e.a), eb = ext(e.b);
    add(strip(A.x - dx * ea, A.z - dz * ea, B.x + dx * eb, B.z + dz * eb, e.width, ROAD_Y), m.asphalt);

    // centre dashes, kept clear of junctions
    const clear = (n: number) => (g.nodes[n].ring ? ROUNDABOUT.outer + 2 : g.degree(n) >= 3 ? e.width / 2 + 4 : 2);
    const s0 = clear(e.a), s1 = e.len - clear(e.b);
    for (let s = s0; s + 3 <= s1; s += 8)
      add(strip(A.x + dx * s, A.z + dz * s, A.x + dx * (s + 3), A.z + dz * (s + 3), 0.15, MARK_Y), markings());
    // zebra crossings on the approaches to street junctions
    for (const [n, sgn] of [[e.a, 1], [e.b, -1]] as const) {
      const N = g.nodes[n];
      if (g.degree(n) < 3 || N.ring) continue;
      const c = e.width / 2 + 1.6;
      const cx = N.x + dx * c * sgn, cz = N.z + dz * c * sgn;
      const px = -dz, pz = dx; // across the road
      for (let k = -e.width / 2 + 1.2; k < e.width / 2 - 0.8; k += 1.1) {
        const x = cx + px * k, z = cz + pz * k;
        add(strip(x - dx * 1.2, z - dz * 1.2, x + dx * 1.2, z + dz * 1.2, 0.55, MARK_Y), markings());
      }
    }
  }
  return b.build();
}

/** The roundabout at the campus entrance: asphalt disc over the M37, kerbed and planted island, lane ring markings. */
export function renderRoundabout(): THREE.Object3D[] {
  const m = campusMaterials();
  const R = ROUNDABOUT;
  const b = new Batch();
  const disc = new THREE.CircleGeometry(R.outer, 48).rotateX(-Math.PI / 2);
  const uv = disc.attributes.uv as THREE.BufferAttribute, pos = disc.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) + R.x, -(pos.getZ(i) + R.z));
  b.add(disc, m.asphalt, { x: R.x, y: 0.078, z: R.z }, {}, false);
  b.add(new THREE.CylinderGeometry(R.island + 0.3, R.island + 0.35, 0.3, 40), m.curb, { x: R.x, y: 0.15, z: R.z });
  b.add(new THREE.CylinderGeometry(R.island, R.island, 0.06, 40), m.grass, { x: R.x, y: 0.32, z: R.z }, {}, false);
  b.add(new THREE.CylinderGeometry(1.4, 1.4, 0.08, 24), m.mulch, { x: R.x, y: 0.36, z: R.z }, {}, false);
  // dashed lane ring and the give-way lines at each entry
  const ring = (r: number, w: number) => {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 14) {
      const g = new THREE.RingGeometry(r - w / 2, r + w / 2, 4, 1, a, Math.PI / 24).rotateX(-Math.PI / 2);
      b.add(g, markings(), { x: R.x, y: 0.09, z: R.z }, {}, false);
    }
  };
  ring(R.ring + 2.2, 0.15);
  const out: THREE.Object3D[] = b.build();
  // a small tree and shrubs on the island
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 2.4, 7), m.trunk);
  trunk.position.set(R.x, 1.5, R.z);
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), m.leaves);
  crown.position.set(R.x, 3.6, R.z);
  for (const o of [trunk, crown]) o.castShadow = true;
  out.push(trunk, crown);
  return out;
}
