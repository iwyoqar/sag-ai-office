// Procedural floor interiors: slab, department zones, desks, props and agent figures.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { AgentDto, AgentStatus, DepartmentDto, FloorDto, PresenceDto } from "@sag/shared";
import { STATUS_META } from "../config/status";
import { X0, X1, Z0, Z1, floorRange, outline } from "./buildingGeometry";
import { layoutDesks, layoutZones, type Zone } from "./layout";

// ---- shared resources (created once, reused by every floor) ----------------
const G = {
  desk: new THREE.BoxGeometry(1.5, 0.08, 0.8),
  deskLeg: new THREE.BoxGeometry(1.4, 0.68, 0.06),
  monitor: new THREE.BoxGeometry(0.75, 0.46, 0.05),
  screen: new THREE.PlaneGeometry(0.68, 0.39),
  chair: new THREE.CylinderGeometry(0.26, 0.26, 0.08, 14),
  body: new THREE.CapsuleGeometry(0.24, 0.5, 4, 10),
  head: new THREE.SphereGeometry(0.19, 16, 12),
  ring: new THREE.RingGeometry(0.42, 0.55, 28),
  orb: new THREE.SphereGeometry(0.13, 14, 10),
  diamond: new THREE.OctahedronGeometry(0.17),
  cube: new THREE.BoxGeometry(0.22, 0.22, 0.22),
  packet: new THREE.SphereGeometry(0.11, 10, 8),
};

const M = {
  slab: new THREE.MeshStandardMaterial({ color: 0xc9c4bb, roughness: 0.95 }),
  desk: new THREE.MeshStandardMaterial({ color: 0xf5f3ef, roughness: 0.6 }),
  deskLeg: new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.5, metalness: 0.4 }),
  monitor: new THREE.MeshStandardMaterial({ color: 0x1d2229, roughness: 0.4 }),
  chair: new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.7 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xe9c7a8, roughness: 0.7 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xbcd3ea, transparent: true, opacity: 0.32, roughness: 0.1, metalness: 0.2, depthWrite: false }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x8d9096, roughness: 0.95, side: THREE.DoubleSide }),
  blocked: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.8 }),
  paused: new THREE.MeshStandardMaterial({ color: 0xc3c7cd, roughness: 0.8, transparent: true, opacity: 0.6 }),
};

const bodyMats = new Map<string, THREE.MeshStandardMaterial>();
function bodyMat(color: string) {
  let m = bodyMats.get(color);
  if (!m) bodyMats.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.6 })));
  return m;
}

const statusMats = new Map<AgentStatus, THREE.MeshBasicMaterial>();
function statusMat(s: AgentStatus) {
  let m = statusMats.get(s);
  if (!m) statusMats.set(s, (m = new THREE.MeshBasicMaterial({ color: STATUS_META[s].color, toneMapped: false })));
  return m;
}
const ringMats = new Map<AgentStatus, THREE.MeshBasicMaterial>();
function ringMat(s: AgentStatus) {
  let m = ringMats.get(s);
  if (!m)
    ringMats.set(s, (m = new THREE.MeshBasicMaterial({ color: STATUS_META[s].color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })));
  return m;
}

const SCREEN: Record<AgentStatus, number> = {
  IDLE: 0x334155, WORKING: 0x60a5fa, THINKING: 0xa78bfa, COMMUNICATING: 0x67e8f9,
  WAITING_APPROVAL: 0xfbbf24, BLOCKED: 0x475569, ERROR: 0xf87171, COMPLETED: 0x86efac,
};

function tint(hex: string, k: number): THREE.Color {
  return new THREE.Color(hex).lerp(new THREE.Color(0xffffff), k);
}

// ---- agent figure ----------------------------------------------------------
export class AgentFigure {
  readonly root = new THREE.Group();
  readonly pickables: THREE.Object3D[] = [];
  private body: THREE.Mesh;
  private head: THREE.Mesh;
  private indicator: THREE.Mesh;
  private ring: THREE.Mesh;
  private screenMat: THREE.MeshBasicMaterial;
  private phase: number;
  status: AgentStatus = "IDLE";
  paused = false;

  constructor(readonly agentId: string, private color: string, agent: AgentDto, x: number, z: number, y0: number) {
    this.phase = (x * 13.1 + z * 7.7) % (Math.PI * 2);
    this.root.position.set(x, y0, z);
    // Slightly larger than life so figures read from the floor-view distance.
    this.root.scale.setScalar(1.25);

    const desk = new THREE.Mesh(G.desk, M.desk);
    desk.position.set(0, 0.74, 0);
    const legs = new THREE.Mesh(G.deskLeg, M.deskLeg);
    legs.position.set(0, 0.36, -0.3);
    const mon = new THREE.Mesh(G.monitor, M.monitor);
    mon.position.set(0, 1.05, -0.2);
    this.screenMat = new THREE.MeshBasicMaterial({ color: SCREEN.IDLE, toneMapped: false });
    const screen = new THREE.Mesh(G.screen, this.screenMat);
    screen.position.set(0, 1.05, -0.17);
    const chair = new THREE.Mesh(G.chair, M.chair);
    chair.position.set(0, 0.48, 0.75);

    this.body = new THREE.Mesh(G.body, bodyMat(color));
    this.body.position.set(0, 0.98, 0.78);
    this.head = new THREE.Mesh(G.head, M.skin);
    this.head.position.set(0, 1.62, 0.76);
    this.indicator = new THREE.Mesh(G.orb, statusMat("IDLE"));
    this.indicator.position.set(0, 2.12, 0.76);
    this.ring = new THREE.Mesh(G.ring, ringMat("IDLE"));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(0, 0.03, 0.76);

    for (const m of [desk, legs, mon, chair, this.body, this.head]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.root.add(desk, legs, mon, screen, chair, this.body, this.head, this.indicator, this.ring);
    for (const m of [desk, mon, screen, this.body, this.head, this.indicator]) {
      m.userData.agentId = agentId;
      this.pickables.push(m);
    }
    this.apply(agent);
  }

  /** Reflect the backend state of this agent. */
  apply(agent: AgentDto) {
    this.status = agent.status;
    this.paused = agent.lifecycle === "PAUSED";
    const s = this.status;
    this.indicator.geometry = s === "WAITING_APPROVAL" ? G.diamond : s === "BLOCKED" ? G.cube : G.orb;
    this.indicator.material = statusMat(s);
    this.ring.material = ringMat(s);
    this.body.material = this.paused ? M.paused : s === "BLOCKED" ? M.blocked : bodyMat(this.color);
    this.screenMat.color.setHex(SCREEN[s]);
  }

  get headWorld(): THREE.Vector3 {
    return this.head.getWorldPosition(new THREE.Vector3());
  }

  update(t: number): void {
    const p = this.phase;
    this.body.position.y = 0.98;
    this.head.rotation.set(0, 0, 0);
    this.indicator.scale.setScalar(1);
    this.indicator.position.y = 2.12;
    if (this.paused) {
      this.head.position.y = this.body.position.y + 0.64;
      return;
    }
    switch (this.status) {
      case "IDLE":
        this.body.position.y += Math.sin(t * 1.4 + p) * 0.015;
        break;
      case "WORKING":
        this.body.position.y += Math.abs(Math.sin(t * 9 + p)) * 0.025;
        this.head.rotation.x = -0.12;
        this.screenMat.color.setHex(SCREEN.WORKING).multiplyScalar(0.85 + 0.15 * Math.sin(t * 11 + p));
        break;
      case "THINKING":
        this.head.rotation.z = Math.sin(t * 1.2 + p) * 0.18;
        this.indicator.rotation.y = t * 2;
        this.indicator.scale.setScalar(1 + 0.25 * Math.sin(t * 3 + p));
        break;
      case "COMMUNICATING":
        this.head.rotation.y = Math.sin(t * 2 + p) * 0.5;
        this.indicator.scale.setScalar(1 + 0.2 * Math.abs(Math.sin(t * 4 + p)));
        break;
      case "WAITING_APPROVAL":
        this.indicator.position.y = 2.18 + Math.abs(Math.sin(t * 3.2 + p)) * 0.22;
        this.indicator.rotation.y = t * 1.5;
        break;
      case "ERROR":
        this.indicator.scale.setScalar(1 + 0.45 * Math.abs(Math.sin(t * 6)));
        this.screenMat.color.setHex(SCREEN.ERROR).multiplyScalar(0.6 + 0.4 * Math.abs(Math.sin(t * 5)));
        break;
      case "COMPLETED": {
        const hop = (t + p) % 2.6;
        this.body.position.y += hop < 0.35 ? Math.sin((hop / 0.35) * Math.PI) * 0.12 : 0;
        break;
      }
      case "BLOCKED":
        break;
    }
    this.head.position.y = this.body.position.y + 0.64;
  }

  setHighlighted(on: boolean) {
    this.ring.scale.setScalar(on ? 1.35 : 1);
  }
}

// ---- links between communicating agents ------------------------------------
class Link {
  readonly root = new THREE.Group();
  private curve: THREE.QuadraticBezierCurve3;
  private packet: THREE.Mesh;
  constructor(from: THREE.Vector3, to: THREE.Vector3, color: string) {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 1.6 + from.distanceTo(to) * 0.15;
    this.curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const geo = new THREE.BufferGeometry().setFromPoints(this.curve.getPoints(32));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    this.packet = new THREE.Mesh(G.packet, new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    this.root.add(line, this.packet);
  }
  update(t: number) {
    this.packet.position.copy(this.curve.getPointAt((t * 0.45) % 1));
  }
}

/** Concrete box around the basement (it has no façade of its own). */
export function buildBasementShell(root: THREE.Object3D, y0: number) {
  const h = -y0;
  const w = X1 - X0, d = Z1 - Z0;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.3, d + 1), M.concrete);
  floor.position.set(0, y0 - 0.15, (Z0 + Z1) / 2);
  floor.receiveShadow = true;
  root.add(floor);
  const walls: [number, number, number, number][] = [
    [0, Z0 - 0.25, w + 1, 0.5], [0, Z1 + 0.25, w + 1, 0.5],
    [X0 - 0.25, (Z0 + Z1) / 2, 0.5, d], [X1 + 0.25, (Z0 + Z1) / 2, 0.5, d],
  ];
  for (const [x, z, sx, sz] of walls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), M.concrete);
    m.position.set(x, y0 + h / 2, z);
    m.receiveShadow = true;
    root.add(m);
  }
}

// ---- floor interior --------------------------------------------------------
export interface ZoneInfo {
  zone?: Zone;
  label: CSS2DObject;
}

/** What SceneController needs from a floor's interior (simple zones or the realistic office). */
export interface Interior {
  readonly root: THREE.Group;
  readonly key: string;
  readonly zones: ZoneInfo[];
  readonly figures: { agentId: string; setHighlighted(on: boolean): void }[];
  readonly pickables: THREE.Object3D[];
  readonly baseY: number;
  applyAgents(agents: AgentDto[]): void;
  /** human presence (realistic floors only) */
  applyPeople?(people: PresenceDto[]): void;
  setLinks(pairs: [string, string][]): void;
  update(t: number): void;
  dispose(): void;
}

/** Signature of what an interior was built from; a change means rebuild, otherwise statuses update in place. */
export function interiorKey(
  floor: FloorDto, departments: DepartmentDto[], agents: AgentDto[], people: { id: string; departmentId: string }[] = [],
): string {
  return [
    floor.departments.join(","),
    departments.map((d) => `${d.id}:${d.weight}:${d.color}`).join(","),
    agents.map((a) => `${a.id}@${a.departmentId}`).sort().join(","),
    // a hire, transfer or departure of a person rebuilds the floor (their desk changes)
    people.map((p) => `${p.id}@${p.departmentId}`).sort().join(","),
  ].join("|");
}

export class FloorInterior implements Interior {
  readonly root = new THREE.Group();
  readonly figures: AgentFigure[] = [];
  readonly zones: ZoneInfo[] = [];
  readonly key: string;
  private links: Link[] = [];
  private linkKey = "";
  private animated: { update(t: number): void }[] = [];
  private y0: number;

  constructor(readonly floor: FloorDto, departments: DepartmentDto[], agents: AgentDto[]) {
    this.key = interiorKey(floor, departments, agents);
    const { y0 } = floorRange(floor.level);
    this.y0 = y0;
    const fy = y0 + 0.02;
    this.root.name = `interior-${floor.id}`;

    if (floor.level === -1) buildBasementShell(this.root, y0);

    // Slab following the facade outline.
    const shape = new THREE.Shape(outline(-0.08).map(([x, z]) => new THREE.Vector2(x, -z)));
    const slab = new THREE.Mesh(new THREE.ShapeGeometry(shape), M.slab);
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = fy;
    slab.receiveShadow = true;
    this.root.add(slab);

    const byId = new Map(departments.map((d) => [d.id, d]));
    const zones = layoutZones(floor.departments.map((id) => byId.get(id)).filter((d): d is DepartmentDto => !!d));
    zones.forEach((z, i) => {
      const dep = byId.get(z.dep)!;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(z.x1 - z.x0 - 0.3, z.z1 - z.z0 - 0.3),
        // Upward faces take full sun; a deeper tint keeps the department colour readable.
        new THREE.MeshStandardMaterial({ color: tint(dep.color, 0.45), roughness: 0.95 }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set((z.x0 + z.x1) / 2, fy + 0.015, (z.z0 + z.z1) / 2);
      plane.receiveShadow = true;
      this.root.add(plane);

      if (i > 0) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, z.z1 - z.z0 - 3), M.glass);
        wall.position.set(z.x0, fy + 0.7, (z.z0 + z.z1) / 2 - 1.2);
        this.root.add(wall);
      }

      const el = document.createElement("div");
      el.className = "zone-label";
      el.style.setProperty("--dep", dep.color);
      el.textContent = dep.name;
      const label = new CSS2DObject(el);
      label.position.set((z.x0 + z.x1) / 2, fy + 0.2, z.z1 - 0.9);
      this.root.add(label);
      this.zones.push({ zone: z, label });

      this.buildProps(z, fy, dep.color);

      // Persisted desk index keeps every agent at the same workstation across sessions.
      const deptAgents = agents
        .filter((a) => a.departmentId === z.dep)
        .sort((a, b) => (a.workstation ?? 1e9) - (b.workstation ?? 1e9) || a.id.localeCompare(b.id));
      layoutDesks(z, deptAgents.length).forEach((d, k) => {
        const fig = new AgentFigure(deptAgents[k].id, dep.color, deptAgents[k], d.x, d.z, fy);
        this.figures.push(fig);
        this.root.add(fig.root);
      });
    });
    this.root.updateMatrixWorld(true);
  }

  /** Update statuses in place (no rebuild). */
  applyAgents(agents: AgentDto[]) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const f of this.figures) {
      const a = byId.get(f.agentId);
      if (a) f.apply(a);
    }
  }

  /**
   * Draw communication arcs between agent pairs. A partner on another floor gets an arc leaving
   * upward through the cut. Pairs come from real agent-to-agent messages (Phase 4).
   */
  setLinks(pairs: [string, string][]) {
    const key = pairs.map((p) => p.join(">")).sort().join(",");
    if (key === this.linkKey) return;
    this.linkKey = key;
    for (const l of this.links) l.root.removeFromParent();
    this.links = [];
    for (const [a, b] of pairs) {
      const from = this.figures.find((f) => f.agentId === a);
      if (!from) continue;
      const other = this.figures.find((f) => f.agentId === b);
      const p0 = from.headWorld.add(new THREE.Vector3(0, 0.5, 0));
      const p1 = other ? other.headWorld.add(new THREE.Vector3(0, 0.5, 0)) : p0.clone().add(new THREE.Vector3(2.5, 7, -1.5));
      const link = new Link(p0, p1, STATUS_META.COMMUNICATING.color);
      this.links.push(link);
      this.root.add(link.root);
    }
  }

  private buildProps(z: Zone, fy: number, color: string) {
    const cx = (z.x0 + z.x1) / 2;
    if (z.dep === "it") {
      // Server racks along the back wall with blinking LEDs.
      const rackGeo = new THREE.BoxGeometry(0.9, 2.1, 0.9);
      const rackMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.5, metalness: 0.5 });
      const ledMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false });
      const leds: THREE.Mesh[] = [];
      for (let i = 0; i < 9; i++) {
        const r = new THREE.Mesh(rackGeo, rackMat);
        r.position.set(z.x0 + 2 + i * 1.1, fy + 1.05, z.z0 + 0.8);
        r.castShadow = true;
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.02), ledMat);
        led.position.set(r.position.x, fy + 1.5, z.z0 + 1.26);
        leds.push(led);
        this.root.add(r, led);
      }
      this.animated.push({ update: (t) => leds.forEach((l, i) => (l.visible = Math.sin(t * 3 + i * 1.7) > -0.3)) });
    } else if (z.dep === "reception") {
      const counter = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 1.1, 32, 1, false, -Math.PI / 2, Math.PI), M.desk);
      counter.position.set(cx, fy + 0.55, z.z1 - 3.2);
      counter.castShadow = true;
      const screen = new THREE.Mesh(new THREE.BoxGeometry(7, 2.2, 0.12), new THREE.MeshBasicMaterial({ color: 0x0f766e, toneMapped: false }));
      screen.position.set(cx, fy + 2.1, z.z0 + 0.4);
      this.root.add(counter, screen);
    } else if (z.dep === "brain") {
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.2, 1),
        new THREE.MeshBasicMaterial({ color, wireframe: true, toneMapped: false }),
      );
      const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 2), new THREE.MeshStandardMaterial({ color: 0xc4b5fd, emissive: 0x7c3aed, emissiveIntensity: 0.6 }));
      const g = new THREE.Group();
      g.add(core, inner);
      g.position.set(cx, fy + 2.0, z.z1 - 3.0);
      this.root.add(g);
      this.animated.push({ update: (t) => { g.rotation.y = t * 0.4; g.position.y = fy + 2.0 + Math.sin(t) * 0.12; } });
    } else if (z.dep === "director") {
      const table = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.1, 1.4), M.desk);
      table.position.set(cx, fy + 0.76, z.z1 - 2.6);
      table.castShadow = true;
      this.root.add(table);
    }
  }

  update(t: number): void {
    for (const f of this.figures) f.update(t);
    for (const l of this.links) l.update(t);
    for (const a of this.animated) a.update(t);
  }

  get pickables(): THREE.Object3D[] {
    return this.figures.flatMap((f) => f.pickables);
  }

  get baseY() {
    return this.y0;
  }

  dispose() {
    this.root.removeFromParent();
    for (const z of this.zones) z.label.element.remove();
  }
}
