// Realistic office floor: architecture, furniture from the floor plan, and agents as people who sit at their own
// desk, walk (A*) to the meeting table when communicating, and stand when waiting/failing/finished.
// Everything they do follows backend state (behaviour.ts); only breathing/typing/head motion is decorative.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { AgentDto, AgentStatus, DepartmentDto, FloorDto, PresenceDto } from "@sag/shared";
import { STATUS_META } from "../../config/status";
import { floorRange, outline, X0, X1, Z0 } from "../buildingGeometry";
import { buildBasementShell, interiorKey, type Interior, type ZoneInfo } from "../interior";
import { ActorMotion, seatSpot, type Spot } from "./actor";
import { activityFor, activityForPresence, isSeated, type Activity } from "./behaviour";
import { Character } from "./character";
import { buildProp, chairInstance, deskPod, MAT } from "./furniture";
import { buildNavGrid, type NavGrid } from "./nav";
import { planObstacles, type FloorPlan } from "./plan";

const SCREEN: Record<AgentStatus, number> = {
  IDLE: 0x2b3a4f, WORKING: 0x60a5fa, THINKING: 0xa78bfa, COMMUNICATING: 0x67e8f9,
  WAITING_APPROVAL: 0xfbbf24, BLOCKED: 0x475569, ERROR: 0xf87171, COMPLETED: 0x86efac,
};

let floorTex: THREE.CanvasTexture | null = null;
/** Subtle 60 cm tile grid for the floor finish. */
function tileTexture() {
  if (floorTex) return floorTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#dcdbd7";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(120,118,112,0.22)";
  g.lineWidth = 2;
  g.strokeRect(0, 0, 128, 128);
  floorTex = new THREE.CanvasTexture(c);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(1 / 0.6, 1 / 0.6);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = 4;
  return floorTex;
}

const RING = new THREE.RingGeometry(0.34, 0.44, 28);
const ringMats = new Map<AgentStatus, THREE.MeshBasicMaterial>();
const PRESENCE: Record<PresenceDto["state"], { label: string; color: string }> = {
  available: { label: "Bo'sh", color: "#94a3b8" },
  working: { label: "Ishlayapti", color: "#2563eb" },
  reviewing: { label: "Ish tekshiryapti", color: "#d97706" },
  blocked: { label: "Bloklangan vazifa", color: "#ea580c" },
  away: { label: "Joyida emas", color: "#cbd5e1" },
};
const presenceRings = new Map<string, THREE.MeshBasicMaterial>();
function presenceRing(state: PresenceDto["state"]) {
  let m = presenceRings.get(state);
  if (!m) presenceRings.set(state, (m = new THREE.MeshBasicMaterial({ color: PRESENCE[state].color, transparent: true, opacity: 0.5, depthWrite: false })));
  return m;
}

function ringMat(s: AgentStatus) {
  let m = ringMats.get(s);
  if (!m) ringMats.set(s, (m = new THREE.MeshBasicMaterial({ color: STATUS_META[s].color, transparent: true, opacity: 0.6, depthWrite: false })));
  return m;
}

/** Pick id of a human employee in the 3D scene (agents use their plain id). */
export const employeePickId = (id: string) => `emp:${id}`;

class Person {
  readonly char: Character;
  readonly ring: THREE.Mesh;
  readonly tag: CSS2DObject;
  private dot: HTMLSpanElement;
  activity: Activity = { place: "desk", pose: "sitRelax" };
  status: AgentStatus = "IDLE";
  meetingSeat = -1;
  /** human employees only */
  presence: PresenceDto["state"] | null = null;

  /** `agentId` is the pick id: the agent id, or `emp:<userId>` for a human employee. */
  constructor(
    readonly agentId: string, readonly desk: number, public motion: ActorMotion,
    who: { name: string; status?: AgentStatus; title?: string }, color: string, readonly human = false,
  ) {
    this.char = new Character(agentId, human);
    for (const m of this.char.meshes) m.userData.agentId = agentId;
    this.ring = new THREE.Mesh(RING, ringMat("IDLE"));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.015;
    this.char.root.add(this.ring);
    const el = document.createElement("div");
    el.className = `person-tag ${human ? "human" : "ai"}`;
    el.style.setProperty("--dep", color);
    this.dot = document.createElement("span");
    this.dot.className = "dot";
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = human ? "\u{1F464}" : "AI";
    el.append(this.dot, kind, document.createTextNode(who.name));
    if (human && who.title) el.dataset.title = who.title;
    this.tag = new CSS2DObject(el);
    this.tag.position.y = 1.6;
    this.char.root.add(this.tag);
    if (!human) this.setStatus(who.status ?? "IDLE");
  }

  setPresence(state: PresenceDto["state"]) {
    this.presence = state;
    this.ring.material = presenceRing(state);
    this.dot.style.background = PRESENCE[state].color;
    const title = this.tag.element.dataset.title;
    this.tag.element.title = `${title ? `${title} - ` : ""}${PRESENCE[state].label}`;
    this.tag.element.classList.toggle("away", state === "away");
    // away: the desk stays empty (only the name plate remains, dimmed)
    for (const m of this.char.meshes) m.visible = state !== "away";
    this.ring.visible = state !== "away";
  }

  setStatus(s: AgentStatus) {
    this.status = s;
    this.ring.material = ringMat(s);
    this.dot.style.background = STATUS_META[s].color;
    this.tag.element.title = STATUS_META[s].label;
  }

  setHighlighted(on: boolean) {
    this.ring.scale.setScalar(on ? 1.45 : 1);
    this.tag.element.classList.toggle("on", on);
  }
}

export class OfficeFloor implements Interior {
  readonly root = new THREE.Group();
  readonly key: string;
  readonly zones: ZoneInfo[] = [];
  readonly figures: Person[] = [];
  private grid: NavGrid;
  private screens: THREE.Mesh[] = [];
  private screenMats: THREE.MeshBasicMaterial[] = [];
  private y0: number;
  private fy: number;
  private animated: ((t: number) => void)[] = [];
  private links: { line: THREE.Line; packet: THREE.Mesh; a: Person; b: Person | null; pos: Float32Array }[] = [];
  private linkKey = "";
  private lastT = -1;

  constructor(readonly floor: FloorDto, private plan: FloorPlan, departments: DepartmentDto[], agents: AgentDto[], people: PresenceDto[] = []) {
    this.key = interiorKey(floor, departments, agents, people);
    this.y0 = floorRange(floor.level).y0;
    const fy = (this.fy = this.y0 + 0.02);
    this.root.name = `office-${floor.id}`;
    this.grid = buildNavGrid(plan.bounds, planObstacles(plan));

    this.buildShell(floor.level);
    this.buildFurniture();
    for (const a of plan.areas) {
      const el = document.createElement("div");
      el.className = "zone-label office-area";
      if (a.color) el.style.setProperty("--dep", a.color);
      el.textContent = a.label;
      const label = new CSS2DObject(el);
      label.position.set(a.x, fy + 0.1, a.z);
      this.root.add(label);
      this.zones.push({ label });
    }

    // People: an agent takes the n-th desk of its department (agents.workstation = n, persisted by the backend).
    const deptColor = new Map(departments.map((d) => [d.id, d.color]));
    const takenDesks = new Set<number>();
    const byDept = new Map<string, AgentDto[]>();
    for (const a of agents) byDept.set(a.departmentId, [...(byDept.get(a.departmentId) ?? []), a]);
    for (const [dep, list] of byDept) {
      const desks = plan.deskDept.flatMap((d, i) => (d === dep ? [i] : []));
      list.sort((a, b) => (a.workstation ?? 1e9) - (b.workstation ?? 1e9) || a.id.localeCompare(b.id));
      const taken = takenDesks;
      // keep persisted desk numbers; agents without one (or beyond the plan) take the next free desk
      const want = list.map((a) => (a.workstation != null && a.workstation < desks.length ? desks[a.workstation] : -1));
      want.forEach((d) => d >= 0 && taken.add(d));
      list.forEach((a, i) => {
        let desk = want[i];
        if (desk < 0 || (want.indexOf(desk) !== i)) desk = desks.find((d) => !taken.has(d)) ?? -1;
        if (desk < 0) return; // more agents than desks: not drawn (the panel still lists them)
        taken.add(desk);
        const p = new Person(a.id, desk, new ActorMotion(this.spotFor(desk, { place: "desk", pose: "sitRelax" }, -1)), { name: a.name, status: a.status }, deptColor.get(dep) ?? "#888");
        p.activity = activityFor(a.status, a.lifecycle);
        if (p.activity.place === "meeting") this.claimMeeting(p);
        p.motion = new ActorMotion(this.spotFor(desk, p.activity, p.meetingSeat));
        this.figures.push(p);
        this.root.add(p.char.root);
        this.zones.push({ label: p.tag });
        this.place(p, 0);
        this.paintScreen(desk, p.status);
      });
    }
    // Human employees take the department's free desks (in hiring order), after the agents' persisted desks.
    for (const h of people) {
      const desk = plan.deskDept.findIndex((d, i) => d === h.departmentId && !takenDesks.has(i));
      if (desk < 0) continue; // no free desk on the plan: listed in the directory, not drawn
      takenDesks.add(desk);
      const act: Activity = activityForPresence(h.state) ?? { place: "desk", pose: "sitRelax" };
      const p = new Person(employeePickId(h.id), desk, new ActorMotion(this.spotFor(desk, act, -1)), { name: h.displayName, title: h.jobTitle }, deptColor.get(h.departmentId) ?? "#888", true);
      p.activity = act;
      p.setPresence(h.state);
      this.figures.push(p);
      this.root.add(p.char.root);
      this.zones.push({ label: p.tag });
      this.place(p, 0);
      this.paintHumanScreen(p);
    }
    for (const p of this.figures) this.screens[p.desk].userData.agentId = p.agentId; // clicking a desk selects its owner
    this.root.updateMatrixWorld(true);
  }

  // ---- building ---------------------------------------------------------------
  private buildShell(level: number) {
    const fy = this.fy;
    if (level === -1) buildBasementShell(this.root, this.y0);
    // floor finish on a thick slab (reads as a cut-away model)
    const shape = new THREE.Shape(outline(-0.08).map(([x, z]) => new THREE.Vector2(x, -z)));
    const slab = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: 0.32, bevelEnabled: false }),
      new THREE.MeshStandardMaterial({ color: 0xe9e7e2, roughness: 0.9 }),
    );
    slab.rotation.x = -Math.PI / 2;
    slab.position.y = fy - 0.32;
    slab.receiveShadow = true;
    const top = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.35, metalness: 0.02 }));
    top.rotation.x = -Math.PI / 2;
    top.position.y = fy + 0.002;
    top.receiveShadow = true;
    // the tile UVs come straight from world X/Z
    const uv = top.geometry.attributes.uv as THREE.BufferAttribute;
    const pos = top.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getY(i));
    this.root.add(slab, top);

    // white perimeter wall: low toward the camera, full height along the back
    const ring = new THREE.Shape(outline(0).map(([x, z]) => new THREE.Vector2(x, -z)));
    ring.holes.push(new THREE.Path(outline(-0.25).map(([x, z]) => new THREE.Vector2(x, -z))));
    const low = new THREE.Mesh(new THREE.ExtrudeGeometry(ring, { depth: 0.9, bevelEnabled: false }), MAT.white);
    low.rotation.x = -Math.PI / 2;
    low.position.y = fy;
    low.castShadow = low.receiveShadow = true;
    // back wall thick enough that wall-mounted screens/boards (plan z ≈ −11.05) sit on its face
    const back = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0 - 0.5, 2.9, 0.55), MAT.white);
    back.position.set(0, fy + 1.45, Z0 + 0.25 + 0.275);
    back.receiveShadow = true;
    this.root.add(low, back);
  }

  private buildFurniture() {
    const fy = this.fy;
    for (const p of this.plan.props) {
      const g = buildProp(p, fy);
      if (p.kind === "serverRack") {
        const leds = g.children.filter((c) => c.userData.blink !== undefined);
        const k = this.animated.length;
        this.animated.push((t) => leds.forEach((l, i) => (l.visible = Math.sin(t * 2.6 + i * 1.9 + k) > -0.4)));
      }
      if (p.kind === "brainCore") {
        const core = g.children.find((c) => c.userData.spin);
        if (core) this.animated.push((t) => { core.rotation.y = t * 0.35; core.position.y = 1.35 + Math.sin(t) * 0.06; });
      }
      this.root.add(g);
    }
    for (const pod of this.plan.pods) {
      const { group, screens } = deskPod(pod.cols);
      group.position.set(pod.x, fy, pod.z);
      this.root.add(group);
      for (const s of screens) {
        const m = new THREE.MeshBasicMaterial({ color: SCREEN.IDLE, toneMapped: false });
        s.material = m;
        this.screens.push(s);
        this.screenMats.push(m);
      }
    }
    for (const s of [...this.plan.workstations, ...this.plan.meetingSeats]) {
      const c = chairInstance();
      c.position.set(s.x, fy, s.z);
      c.rotation.y = s.face;
      this.root.add(c);
    }
  }

  // ---- people -------------------------------------------------------------------
  private spotFor(desk: number, act: Activity, meeting: number): Spot {
    if (act.place === "meeting" && meeting >= 0) return seatSpot(`m${meeting}`, this.plan.meetingSeats[meeting], true);
    const seat = this.plan.workstations[desk];
    return seatSpot(`d${desk}`, seat, act.place === "desk");
  }

  private claimMeeting(p: Person) {
    if (p.meetingSeat >= 0) return;
    const used = new Set(this.figures.map((f) => f.meetingSeat));
    const free = this.plan.meetingSeats.findIndex((_, i) => !used.has(i));
    p.meetingSeat = free;
  }

  private paintScreen(desk: number, s: AgentStatus) {
    this.screenMats[desk]?.color.setHex(SCREEN[s]);
  }

  /** Update statuses in place: people walk to wherever their new state puts them. */
  applyAgents(agents: AgentDto[]) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const p of this.figures) {
      if (p.human) continue;
      const a = byId.get(p.agentId);
      if (!a) continue;
      p.setStatus(a.status);
      this.paintScreen(p.desk, a.status);
      p.activity = activityFor(a.status, a.lifecycle);
      if (p.activity.place === "meeting") this.claimMeeting(p);
      else p.meetingSeat = -1;
      p.motion.goTo(this.spotFor(p.desk, p.activity, p.meetingSeat), this.grid);
    }
  }

  private paintHumanScreen(p: Person) {
    this.screenMats[p.desk]?.color.setHex(p.presence === "working" ? SCREEN.WORKING : p.presence === "away" ? 0x111827 : SCREEN.IDLE);
  }

  /** Presence changes of human employees: they stay at their desk; only pose and visibility follow the data. */
  applyPeople(people: PresenceDto[]) {
    const byId = new Map(people.map((h) => [employeePickId(h.id), h]));
    for (const p of this.figures) {
      if (!p.human) continue;
      const h = byId.get(p.agentId);
      if (!h || h.state === p.presence) continue;
      p.setPresence(h.state);
      p.activity = activityForPresence(h.state) ?? p.activity;
      this.paintHumanScreen(p);
    }
  }

  private place(p: Person, t: number) {
    const m = p.motion;
    p.char.root.position.set(m.x, this.fy, m.z);
    p.char.root.rotation.y = m.yaw;
    p.char.pose =
      m.state === "walking" ? "walk"
      : m.state === "rising" || m.state === "sitting" ? "stand"
      : m.spot.sit === isSeated(p.activity.pose) ? p.activity.pose
      : m.spot.sit ? "sitRelax" : "stand";
    p.char.speed = m.state === "walking" ? 1.3 : 0;
    p.tag.position.y = p.char.headHeight + 0.3; // follows sitting/standing
    void t;
  }

  /** Communication arcs between people (recomputed from head positions every frame, so they follow walkers). */
  setLinks(pairs: [string, string][]) {
    const key = pairs.map((p) => p.join(">")).sort().join(",");
    if (key === this.linkKey) return;
    this.linkKey = key;
    for (const l of this.links) {
      l.line.removeFromParent();
      l.packet.removeFromParent();
      l.line.geometry.dispose();
    }
    this.links = [];
    const color = STATUS_META.COMMUNICATING.color;
    for (const [a, b] of pairs) {
      const from = this.figures.find((f) => f.agentId === a);
      if (!from) continue;
      const pos = new Float32Array(33 * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
      line.frustumCulled = false;
      const packet = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
      this.root.add(line, packet);
      this.links.push({ line, packet, a: from, b: this.figures.find((f) => f.agentId === b) ?? null, pos });
    }
  }

  private updateLinks(t: number) {
    const v = new THREE.Vector3();
    for (const l of this.links) {
      const p0 = l.a.char.root.position.clone().setY(this.fy + l.a.char.headHeight + 0.35);
      const p1 = l.b ? l.b.char.root.position.clone().setY(this.fy + l.b.char.headHeight + 0.35) : p0.clone().add(new THREE.Vector3(2.5, 7, -1.5));
      const mid = p0.clone().lerp(p1, 0.5);
      mid.y += 1.2 + p0.distanceTo(p1) * 0.15;
      const c = new THREE.QuadraticBezierCurve3(p0, mid, p1);
      for (let i = 0; i <= 32; i++) {
        c.getPoint(i / 32, v);
        l.pos.set([v.x, v.y, v.z], i * 3);
      }
      (l.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      l.packet.position.copy(c.getPointAt((t * 0.45) % 1));
    }
  }

  update(t: number) {
    const dt = this.lastT < 0 ? 0 : Math.max(0, Math.min(0.1, t - this.lastT)); // never negative (clock resets)
    this.lastT = t;
    for (const p of this.figures) {
      p.motion.step(dt);
      this.place(p, t);
      p.char.update(dt, t);
    }
    for (const a of this.animated) a(t);
    // working screens flicker gently
    for (const p of this.figures) if (!p.human && p.status === "WORKING") this.screenMats[p.desk]?.color.setHex(SCREEN.WORKING).multiplyScalar(0.88 + 0.12 * Math.sin(t * 9 + p.desk));
    this.updateLinks(t);
  }

  get pickables(): THREE.Object3D[] {
    return [...this.figures.flatMap((f) => f.char.meshes), ...this.figures.map((f) => this.screens[f.desk])];
  }

  get baseY() {
    return this.y0;
  }

  dispose() {
    this.root.removeFromParent();
    for (const z of this.zones) z.label.element.remove();
  }
}
