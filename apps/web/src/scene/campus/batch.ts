import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { boxGeometryM } from "./materials";

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const ATTRS = ["position", "normal", "uv"];

/**
 * Collects static, uniquely placed parts (slabs, curbs, mullions, copings…) and merges them into one mesh per
 * material, so a detailed building or lot costs a handful of draw calls instead of hundreds.
 */
export class Batch {
  private parts = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean }>();

  add(geo: THREE.BufferGeometry, mat: THREE.Material, pos: THREE.Vector3Like, rot: { x?: number; y?: number; z?: number } = {}, cast = true) {
    _e.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
    _m.compose(new THREE.Vector3(pos.x, pos.y, pos.z), _q.setFromEuler(_e), new THREE.Vector3(1, 1, 1));
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (!ATTRS.includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g = g.applyMatrix4(_m);
    let p = this.parts.get(mat);
    if (!p) this.parts.set(mat, (p = { geos: [], cast }));
    p.cast ||= cast;
    p.geos.push(g);
  }

  /** Box standing on `y` (its bottom), centred on x/z; metre UVs so tiled textures keep their scale. */
  box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rotY = 0, cast = true) {
    this.add(boxGeometryM(w, h, d), mat, { x, y: y + h / 2, z }, { y: rotY }, cast);
  }

  /** Vertical plane facing +z (rotated by rotY). */
  plane(w: number, h: number, mat: THREE.Material, x: number, y: number, z: number, rotY = 0) {
    this.add(new THREE.PlaneGeometry(w, h), mat, { x, y, z }, { y: rotY }, false);
  }

  build(receive = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, p] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(p.geos), mat);
      mesh.castShadow = p.cast;
      mesh.receiveShadow = receive;
      out.push(mesh);
      for (const g of p.geos) g.dispose();
    }
    this.parts.clear();
    return out;
  }
}

/**
 * Merges the direct mesh children of `group` that share a material into one mesh each (transforms baked in).
 * `keep` meshes (picking volumes, outlines) stay as they are. Used after a building is assembled from many parts.
 */
export function mergeByMaterial(group: THREE.Group, keep: THREE.Object3D[]) {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const o of group.children) {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || keep.includes(mesh) || Array.isArray(mesh.material) || (mesh as THREE.InstancedMesh).isInstancedMesh) continue;
    const list = byMat.get(mesh.material) ?? [];
    list.push(mesh);
    byMat.set(mesh.material, list);
  }
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const b = new Batch();
    let cast = false, receive = false;
    for (const mesh of meshes) {
      mesh.updateMatrix();
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrix);
      b.add(geo, mat, { x: 0, y: 0, z: 0 }, {}, mesh.castShadow);
      geo.dispose();
      cast ||= mesh.castShadow;
      receive ||= mesh.receiveShadow;
      group.remove(mesh);
    }
    for (const merged of b.build(receive)) {
      merged.castShadow = cast;
      merged.renderOrder = meshes[0].renderOrder;
      group.add(merged);
    }
  }
}
