import * as THREE from "three";

interface Bucket {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  matrices: THREE.Matrix4[];
  colors: (THREE.Color | null)[];
  shadow: { cast: boolean; receive: boolean };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Collects many placements of the same geometry + material and emits one InstancedMesh per pair.
 * Every window, door, AC unit, solar segment, car and lamp on the campus goes through here.
 */
export class Instancer {
  private buckets = new Map<string, Bucket>();

  /**
   * `tile` (metres): split each bucket into square tiles so frustum culling can skip what is off screen. Use it for
   * props spread over a large area (the store district); leave it off for compact sets.
   */
  constructor(private tile = 0) {}

  add(
    key: string, geo: THREE.BufferGeometry, mat: THREE.Material,
    pos: THREE.Vector3Like, scale: THREE.Vector3Like = { x: 1, y: 1, z: 1 },
    rot: { x?: number; y?: number; z?: number } = {}, color: THREE.Color | null = null,
    shadow = { cast: true, receive: true },
  ) {
    if (this.tile) key = `${key}@${Math.floor(pos.x / this.tile)},${Math.floor(pos.z / this.tile)}`;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { geo, mat, matrices: [], colors: [], shadow }));
    _e.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
    _q.setFromEuler(_e);
    b.matrices.push(
      _m.compose(new THREE.Vector3(pos.x, pos.y, pos.z), _q, new THREE.Vector3(scale.x, scale.y, scale.z)).clone(),
    );
    b.colors.push(color);
  }


  build(): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const [key, b] of this.buckets) {
      const mesh = new THREE.InstancedMesh(b.geo, b.mat, b.matrices.length);
      mesh.name = key;
      b.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      if (b.colors.some((c) => c)) b.colors.forEach((c, i) => mesh.setColorAt(i, c ?? new THREE.Color(1, 1, 1)));
      mesh.castShadow = b.shadow.cast;
      mesh.receiveShadow = b.shadow.receive;
      mesh.computeBoundingSphere();
      out.push(mesh);
    }
    return out;
  }
}

/** Shared unit geometries, scaled per instance. */
export const UNIT = {
  box: new THREE.BoxGeometry(1, 1, 1),
  /** box with only its +Z face textured nicely (front plane slightly proud) */
  panel: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
};
