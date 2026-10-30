// SAG logistics traffic. Vehicles run trips between named destinations of the road graph (docks, the main warehouse,
// the HQ car park, store loading gates, the M37 edges for inbound/outbound freight), dwell at each stop, then pick
// the next trip from where they are. Architecture:
//   - routes: RoadGraph.route (Dijkstra, cached per pair and vehicle kind) → LanePath (cached per node sequence),
//     so no pathfinding happens in the frame loop;
//   - per frame: a spatial hash of vehicles (and trailers) for car-following, junction reservations (one vehicle per
//     junction box, two on the roundabout, and only when the exit is clear), smooth acceleration / braking,
//     a stuck watchdog that retires a vehicle that has not moved for 30 s;
//   - drawing: one InstancedMesh per model part (see vehicles.ts), matrices written in place.
import * as THREE from "three";
import { buildLanePath, LanePath, type RoadGraph, type VehicleKind } from "./roads";
import { vehicleModels, type VehicleModel } from "./vehicles";

export interface TrafficConfig {
  minVehicles: number;
  maxVehicles: number;
  /** 0..1 between min and max */
  density: number;
  /** a new vehicle at most this often, ms */
  spawnIntervalMs: number;
  /** relative share of each vehicle kind */
  mix: Record<VehicleKind, number>;
  paused: boolean;
}

export const DEFAULT_TRAFFIC: TrafficConfig = {
  minVehicles: 10, maxVehicles: 40, density: 0.55, spawnIntervalMs: 1800,
  mix: { van: 0.38, medium: 0.27, large: 0.2, semi: 0.15 }, paused: false,
};

/** Trip templates: which kinds run which legs. Patterns end in ":*" to match any numbered dock / any store. */
const TRIPS: { kinds: VehicleKind[]; from: string; to: string; w: number }[] = [
  { kinds: ["semi", "large"], from: "factory-*", to: "warehouse", w: 3 },
  { kinds: ["semi"], from: "m37-*", to: "factory-*", w: 2 }, // raw materials arriving on the M37
  { kinds: ["semi"], from: "warehouse", to: "m37-*", w: 1.5 }, // outbound freight to other regions
  { kinds: ["semi", "large"], from: "warehouse", to: "factory-*", w: 1 }, // empty run back to a dock
  { kinds: ["large", "medium", "van"], from: "warehouse", to: "store:*", w: 4 },
  { kinds: ["large", "medium", "van"], from: "store:*", to: "warehouse", w: 2 },
  { kinds: ["van"], from: "hq", to: "store:*", w: 2 },
  { kinds: ["van"], from: "store:*", to: "hq", w: 1 },
  { kinds: ["van", "medium"], from: "store:*", to: "store:*", w: 1 },
];
/** where a new vehicle of each kind leaves from */
const DEPOTS: Record<VehicleKind, string[]> = {
  van: ["warehouse", "hq"], medium: ["warehouse"], large: ["warehouse", "factory-*"], semi: ["factory-*", "m37-*"],
};

const match = (pattern: string, name: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

interface Vehicle {
  id: number;
  kind: VehicleKind;
  model: VehicleModel;
  livery: THREE.Color;
  path: LanePath;
  route: number[];
  s: number;
  v: number;
  /** where the trip ends (path.length) and the destination's name */
  to: string;
  dwell: number;
  stuck: number;
  /** junction node ids currently held */
  held: Set<number>;
  x: number; z: number; hx: number; hz: number;
  tx: number; tz: number; thx: number; thz: number; // trailer
  done: boolean;
}

const MAX_PER_KIND = 96;
const _p = { x: 0, z: 0 }, _q = { x: 0, z: 0 };
const _m = new THREE.Matrix4(), _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scale = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const ROAD_Y = 0.07;

export class TrafficManager {
  readonly root = new THREE.Group();
  config: TrafficConfig = { ...DEFAULT_TRAFFIC, mix: { ...DEFAULT_TRAFFIC.mix } };
  private g: RoadGraph | null = null;
  private vehicles: Vehicle[] = [];
  private nextId = 1;
  private sinceSpawn = 0;
  private paths = new Map<string, LanePath>();
  private locks = new Map<number, Set<number>>();
  private meshes = new Map<VehicleKind, { model: VehicleModel; body: THREE.InstancedMesh[]; trailer: THREE.InstancedMesh[] }>();
  private destNames: string[] = [];
  /** counters for the report / debug hook */
  stats = { spawned: 0, arrived: 0, retired: 0, trips: 0 };

  constructor() {
    this.root.name = "traffic";
    const models = vehicleModels();
    for (const kind of Object.keys(models) as VehicleKind[]) {
      const model = models[kind];
      const body: THREE.InstancedMesh[] = [], trailer: THREE.InstancedMesh[] = [];
      for (const part of model.parts) {
        const mesh = new THREE.InstancedMesh(part.geo, part.mat, MAX_PER_KIND);
        mesh.count = 0;
        mesh.frustumCulled = false; // instances move every frame; ~45 small draw calls for the whole fleet
        mesh.castShadow = false;
        mesh.receiveShadow = !(part.mat as THREE.Material).transparent;
        mesh.name = `vehicle-${kind}`;
        if (part.tint) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_KIND * 3), 3);
        (part.trailer ? trailer : body).push(mesh);
        this.root.add(mesh);
      }
      this.meshes.set(kind, { model, body, trailer });
    }
  }

  /** New road graph (the district layout changed): routes and vehicles start over. */
  setGraph(g: RoadGraph) {
    this.g = g;
    this.paths.clear();
    this.locks.clear();
    this.vehicles = [];
    this.destNames = [...g.dests.keys()];
    this.prewarm();
    this.draw();
  }

  configure(c: Partial<TrafficConfig>) {
    this.config = { ...this.config, ...c, mix: { ...this.config.mix, ...(c.mix ?? {}) } };
  }

  get active() {
    return this.vehicles.length;
  }

  get paused() {
    return this.config.paused;
  }

  /** Counts per kind (for the report). */
  census() {
    const out: Record<string, number> = {};
    for (const v of this.vehicles) out[v.kind] = (out[v.kind] ?? 0) + 1;
    return out;
  }

  // ---- trips -------------------------------------------------------------------------------------------------------

  private namesFor(pattern: string) {
    return this.destNames.filter((n) => match(pattern, n));
  }

  private pick<T>(items: T[], weight: (t: T) => number): T | undefined {
    const total = items.reduce((a, t) => a + weight(t), 0);
    let r = Math.random() * total;
    for (const t of items) if ((r -= weight(t)) <= 0) return t;
    return items[items.length - 1];
  }

  /** A trip from `from` (a destination name) for this kind: the target name, or undefined when none applies. */
  private nextTarget(kind: VehicleKind, from: string): string | undefined {
    const options = TRIPS.filter((t) => t.kinds.includes(kind) && match(t.from, from));
    for (let tries = 0; tries < 4; tries++) {
      const t = this.pick(options, (o) => o.w);
      if (!t) return undefined;
      const targets = this.namesFor(t.to).filter((n) => n !== from);
      if (targets.length) return targets[Math.floor(Math.random() * targets.length)];
    }
    return undefined;
  }

  /** Lane path for a node sequence, cached (paths are immutable and shared by every vehicle on that route). */
  private pathFor(route: number[]): LanePath {
    const key = route.join(",");
    let p = this.paths.get(key);
    if (!p) this.paths.set(key, (p = buildLanePath(this.g!, route)));
    return p;
  }

  /** Starts a trip; `prev` is the node the vehicle came from, so the new path continues from its current lane. */
  private startTrip(v: Vehicle | null, kind: VehicleKind, from: string, to: string, prev?: number): Vehicle | null {
    const g = this.g!;
    const a = g.dests.get(from), b = g.dests.get(to);
    if (a === undefined || b === undefined) return null;
    const r = g.route(a, b, kind);
    if (!r || r.length < 2) return null;
    const route = prev !== undefined && prev !== a && g.edgeBetween(prev, a) ? [prev, ...r] : r;
    const path = this.pathFor(route);
    const s = route === r ? 0 : path.stops.get(1) ?? 0;
    const models = vehicleModels();
    const veh: Vehicle = v ?? {
      id: this.nextId++, kind, model: models[kind],
      livery: new THREE.Color(models[kind].liveries[Math.floor(Math.random() * models[kind].liveries.length)]),
      path, route, s, v: 0, to, dwell: 0, stuck: 0, held: new Set(),
      x: 0, z: 0, hx: 1, hz: 0, tx: 0, tz: 0, thx: 1, thz: 0, done: false,
    };
    veh.path = path;
    veh.route = route;
    veh.s = s;
    veh.to = to;
    veh.dwell = 0;
    veh.stuck = 0;
    this.stats.trips++;
    this.place(veh);
    return veh;
  }

  /** Fills the network at start: vehicles already on their way, spread along their routes and kept apart. */
  private prewarm() {
    const target = this.targetCount();
    for (let tries = 0; this.vehicles.length < target && tries < target * 6; tries++) {
      const v = this.spawn(true);
      if (!v) continue;
      v.s = Math.random() * v.path.length * 0.85;
      this.place(v);
      if (this.vehicles.some((o) => o !== v && Math.hypot(o.x - v.x, o.z - v.z) < 22)) continue;
      v.v = v.model.vmax * 0.6;
      this.vehicles.push(v);
      this.stats.spawned++;
    }
  }

  private targetCount() {
    const c = this.config;
    return Math.round(c.minVehicles + (c.maxVehicles - c.minVehicles) * Math.max(0, Math.min(1, c.density)));
  }

  private spawn(silent = false): Vehicle | null {
    if (!this.g) return null;
    const kind = this.pick(Object.keys(this.config.mix) as VehicleKind[], (k) => this.config.mix[k])!;
    const depots = DEPOTS[kind].flatMap((d) => this.namesFor(d));
    if (!depots.length) return null;
    const from = depots[Math.floor(Math.random() * depots.length)];
    const to = this.nextTarget(kind, from);
    if (!to) return null;
    const v = this.startTrip(null, kind, from, to);
    if (!v) return null;
    if (!silent && this.vehicles.some((o) => Math.hypot(o.x - v.x, o.z - v.z) < 16)) return null; // depot busy
    return v;
  }

  // ---- simulation --------------------------------------------------------------------------------------------------

  /** Position / heading (and trailer) from the path at the vehicle's distance. */
  private place(v: Vehicle) {
    const p = v.path;
    p.at(v.s, _p);
    p.at(v.s + 1.5, _q);
    let hx = _q.x - _p.x, hz = _q.z - _p.z;
    if (v.s + 1.5 > p.length) {
      p.at(v.s - 1.5, _q);
      hx = _p.x - _q.x;
      hz = _p.z - _q.z;
    }
    const hl = Math.hypot(hx, hz) || 1;
    v.x = _p.x; v.z = _p.z; v.hx = hx / hl; v.hz = hz / hl;
    if (v.model.kingpin) {
      // trailer: kingpin on the path behind the tractor, axis toward a point one trailer length further back
      const k = v.s - v.model.kingpin;
      p.at(k, _p);
      p.at(k - (v.model.trailerLength ?? 12), _q);
      let tx = _p.x - _q.x, tz = _p.z - _q.z;
      if (k - (v.model.trailerLength ?? 12) < 0) {
        // at the very start of a path the trailer trails straight behind the tractor
        _p.x = v.x - v.hx * v.model.kingpin;
        _p.z = v.z - v.hz * v.model.kingpin;
        tx = v.hx; tz = v.hz;
      }
      const tl = Math.hypot(tx, tz) || 1;
      v.tx = _p.x; v.tz = _p.z; v.thx = tx / tl; v.thz = tz / tl;
    }
  }

  private lockCap(node: number) {
    return this.g!.nodes[node].ring ? 2 : 1;
  }

  private release(v: Vehicle, node?: number) {
    for (const n of node === undefined ? [...v.held] : [node]) {
      this.locks.get(n)?.delete(v.id);
      v.held.delete(n);
    }
  }

  update(dt: number) {
    if (!this.g || this.config.paused) return;
    dt = Math.min(dt, 0.1);
    // keep the population near its target: one new vehicle per interval, never a burst
    this.sinceSpawn += dt * 1000;
    if (this.vehicles.length < this.targetCount() && this.sinceSpawn > this.config.spawnIntervalMs) {
      this.sinceSpawn = 0;
      const v = this.spawn();
      if (v) {
        this.vehicles.push(v);
        this.stats.spawned++;
      }
    }

    // spatial hash (16 m cells) of tractors and trailers, for car-following
    const cell = 16;
    const grid = new Map<number, { v: Vehicle; x: number; z: number; hx: number; hz: number; half: number }[]>();
    const key = (x: number, z: number) => (Math.floor(x / cell) + 1000) * 4096 + Math.floor(z / cell) + 1000;
    const put = (v: Vehicle, x: number, z: number, hx: number, hz: number, half: number) => {
      const k = key(x, z);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push({ v, x, z, hx, hz, half });
    };
    for (const v of this.vehicles) {
      put(v, v.x, v.z, v.hx, v.hz, v.model.length / 2);
      if (v.model.kingpin) {
        const tl = v.model.trailerLength ?? 12;
        put(v, v.tx - v.thx * tl / 2, v.tz - v.thz * tl / 2, v.thx, v.thz, tl / 2 + 0.6);
      }
    }
    const near = (x: number, z: number, r: number) => {
      const out: { v: Vehicle; x: number; z: number; hx: number; hz: number; half: number }[] = [];
      const c0x = Math.floor((x - r) / cell), c1x = Math.floor((x + r) / cell), c0z = Math.floor((z - r) / cell), c1z = Math.floor((z + r) / cell);
      for (let cx = c0x; cx <= c1x; cx++)
        for (let cz = c0z; cz <= c1z; cz++) {
          const list = grid.get((cx + 1000) * 4096 + cz + 1000);
          if (list) out.push(...list);
        }
      return out;
    };

    for (const v of this.vehicles) {
      if (v.dwell > 0) {
        v.dwell -= dt;
        if (v.dwell <= 0) this.depart(v);
        continue;
      }
      const m = v.model, half = m.length / 2;
      const tail = half + (m.kingpin ? m.kingpin + (m.trailerLength ?? 0) - half : 0); // rear end behind the reference point
      const p = v.path;
      const remaining = p.length - v.s;
      // 1. limits: road speed ahead, stopping at the end of the trip
      let target = Math.min(m.vmax, p.limitAt(v.s + 8), p.limitAt(v.s + 2));
      target = Math.min(target, Math.sqrt(Math.max(0, 2 * m.decel * 0.8 * remaining)));
      // 2. car-following: the nearest vehicle (or trailer) ahead in this lane
      const look = 12 + v.v * 2.2;
      for (const o of near(v.x + v.hx * look / 2, v.z + v.hz * look / 2, look / 2 + 8)) {
        if (o.v === v) continue;
        const rx = o.x - v.x, rz = o.z - v.z;
        const proj = rx * v.hx + rz * v.hz;
        if (proj <= 0 || proj > look + o.half) continue;
        const lat = Math.abs(rx * v.hz - rz * v.hx);
        const same = o.hx * v.hx + o.hz * v.hz;
        if (lat > 2.4 || (same < 0.2 && proj > half + o.half + 4)) continue;
        const gap = proj - half - o.half;
        target = Math.min(target, Math.max(0, (gap - 2.5) * 0.8));
      }
      // 3. junctions: enter only with a reservation, and only if the far side has room for the whole vehicle
      for (const j of p.junctions) {
        if (j.exit + tail + 1 < v.s) {
          if (v.held.has(j.node)) this.release(v, j.node);
          continue;
        }
        if (v.held.has(j.node)) continue;
        const dist = j.enter - v.s - half;
        if (dist > 6 + (v.v * v.v) / (2 * m.decel)) break; // not close yet: later junctions can wait too
        const holders = this.locks.get(j.node) ?? new Set<number>();
        let ok = holders.size < this.lockCap(j.node);
        if (ok) {
          p.at(j.exit + tail + 3, _p);
          for (const o of near(_p.x, _p.z, 6)) if (o.v !== v && Math.hypot(o.x - _p.x, o.z - _p.z) < o.half + 2 && o.v.v < 2) ok = false;
        }
        if (ok) {
          holders.add(v.id);
          this.locks.set(j.node, holders);
          v.held.add(j.node);
        } else {
          target = Math.min(target, Math.sqrt(Math.max(0, 2 * m.decel * Math.max(0, dist - 1))));
          break;
        }
      }
      // 4. integrate: smooth acceleration, firm braking
      const dv = target - v.v;
      v.v += dv > 0 ? Math.min(dv, m.accel * dt) : Math.max(dv, -m.decel * 1.6 * dt);
      v.v = Math.max(0, v.v);
      v.s = Math.min(p.length, v.s + v.v * dt);
      this.place(v);
      // 5. arrival, and the stuck watchdog
      if (p.length - v.s < 0.3 && v.v < 0.5) {
        this.release(v);
        this.stats.arrived++;
        if (v.to.startsWith("m37-")) v.done = true; // left the region on the M37
        else v.dwell = 3 + Math.random() * 5; // loading / unloading
        v.v = 0;
      } else if (v.v < 0.15) {
        v.stuck += dt;
        if (v.stuck > 30) {
          v.done = true;
          this.stats.retired++;
          this.release(v);
        }
      } else v.stuck = 0;
    }
    if (this.vehicles.some((v) => v.done)) {
      for (const v of this.vehicles) if (v.done) this.release(v);
      this.vehicles = this.vehicles.filter((v) => !v.done);
    }
    this.draw();
  }

  /** After a stop: the next trip from here, continuing from the lane the vehicle is in. */
  private depart(v: Vehicle) {
    const to = this.nextTarget(v.kind, v.to);
    const prev = v.route[v.route.length - 2];
    if (!to || !this.startTrip(v, v.kind, v.to, to, prev)) v.done = true;
  }

  // ---- drawing -----------------------------------------------------------------------------------------------------
  private draw() {
    const counts = new Map<VehicleKind, number>();
    for (const v of this.vehicles) {
      const set = this.meshes.get(v.kind)!;
      const i = counts.get(v.kind) ?? 0;
      if (i >= MAX_PER_KIND) continue;
      counts.set(v.kind, i + 1);
      _pos.set(v.x, ROAD_Y, v.z);
      _quat.setFromAxisAngle(_up, Math.atan2(-v.hz, v.hx));
      _m.compose(_pos, _quat, _scale);
      for (const mesh of set.body) {
        mesh.setMatrixAt(i, _m);
        if (mesh.instanceColor) mesh.setColorAt(i, v.livery);
      }
      if (set.trailer.length) {
        _pos.set(v.tx, ROAD_Y, v.tz);
        _quat.setFromAxisAngle(_up, Math.atan2(-v.thz, v.thx));
        _m.compose(_pos, _quat, _scale);
        for (const mesh of set.trailer) mesh.setMatrixAt(i, _m);
      }
    }
    for (const [kind, set] of this.meshes) {
      const n = counts.get(kind) ?? 0;
      for (const mesh of [...set.body, ...set.trailer]) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Debug / test view of the fleet. */
  snapshot() {
    return this.vehicles.map((v) => ({ id: v.id, kind: v.kind, to: v.to, x: +v.x.toFixed(1), z: +v.z.toFixed(1), v: +v.v.toFixed(1), dwell: v.dwell > 0 }));
  }
}
