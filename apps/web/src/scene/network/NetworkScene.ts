// SAG store network in 3D: one building per business unit, grouped on one plot per region.
// Positions are a SCHEMATIC layout (regions in a grid, stores in rows): the workbook has no addresses or coordinates,
// and none are invented. A unit with real coordinates (geo) is still drawn on its region plot; geo is shown in the
// panel, never turned into a fake map position.
// Buildings reuse the campus modules (buildBuilding + campus materials + instancer); people reuse the office
// Character. Clicking a store flies the camera in and opens it as a cut-away showing the people the viewer may see.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { NetworkDto, UnitCardDto } from "@sag/shared";
import { buildBuilding } from "../campus/buildings";
import { boxGeometryM, createCampusMaterials } from "../campus/materials";
import { Instancer } from "../campus/instancer";
import type { BuildingSpec } from "../campus/layout";
import { Character } from "../office/character";
import { Tweens, ease } from "../tween";

const PER_ROW = 3;
const STORE_PITCH_X = 40;
const STORE_PITCH_Z = 36;
/** store labels appear only closer than this (region labels are always on), so the overview stays readable */
const STORE_LABEL_DISTANCE = 420;
const PLOT_PAD = 14;
const REGION_COLS = 4;
const REGION_GAP = 26;
const FLY_MS = 1100;

export interface NetworkSceneEvents {
  onSelect(unitId: string): void;
  onHover(unit: UnitCardDto | null, x: number, y: number): void;
}

/** Someone inside a store: a person (only those the viewer is allowed to see) or the store's AI Director. */
export interface StoreOccupant {
  id: string;
  name: string;
  role: string;
  kind: "human" | "ai";
}

interface StoreBuilding {
  unit: UnitCardDto;
  spec: BuildingSpec;
  group: THREE.Group;
  label: CSS2DObject;
}

function label(text: string, cls: string, badge?: { text: string; cls: string }): CSS2DObject {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  if (badge) {
    const b = document.createElement("span");
    b.className = badge.cls;
    b.textContent = badge.text;
    el.prepend(b, " "); // badge first: a long name is shortened, never the ownership type
  }
  return new CSS2DObject(el);
}

/** Building spec for one store (campus modules): SAG-owned = stone with SAG blue trim, franchise = ribbed panels. */
function storeSpec(u: UnitCardDto, cx: number, cz: number): BuildingSpec {
  const own = u.ownershipModel === "SAG_OWNED";
  const hq = u.isHeadOffice;
  const w = hq ? 26 : own ? 18 : 16, d = hq ? 16 : own ? 12 : 11, h = hq ? 14 : own ? 7 : 6;
  return {
    id: u.id, name: u.name, category: "store", interaction: "inspect",
    x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, h,
    cladding: own ? "stone" : "ribbed",
    blueTrim: own,
    windows: [{ side: "+z", kind: own ? "office" : "ribbon", y: 1.2, from: 2, to: w - 2, every: own ? 4 : undefined }],
    doors: [{ side: "+z", kind: "personnel", at: w / 2, w: 2.4, h: 2.7 }],
    acUnits: hq ? { side: "+x", from: 2, to: d - 2, every: 4, y: 4 } : undefined,
  };
}

// ---- store interior (cut-away): carpet racks, display rugs, cash counter. Decorative fit-out, same for every store.
const CARPETS = [0x8c2f39, 0x1f3b5c, 0xc9b28a, 0x2f6f6a, 0x6b3f2a, 0x9a8f7a];
const imat = new Map<number, THREE.MeshStandardMaterial>();
const im = (c: number, rough = 0.85) => {
  let m = imat.get(c);
  if (!m) imat.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: rough })));
  return m;
};
const ROLL = new THREE.CylinderGeometry(0.22, 0.22, 2.4, 14).rotateZ(Math.PI / 2);

function box(g: THREE.Group, w: number, h: number, d: number, color: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(boxGeometryM(w, h, d), im(color));
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function buildInterior(s: BuildingSpec): THREE.Group {
  const g = new THREE.Group();
  const w = s.x1 - s.x0, d = s.z1 - s.z0, cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
  const base = 0.5;
  box(g, w, 0.12, d, 0xe9dcc6, cx, base, cz); // floor
  const wall = 0xece7de, t = 0.3, wh = 1.1;
  box(g, w, wh, t, wall, cx, base, s.z0 + t / 2); // back
  box(g, t, wh, d, wall, s.x0 + t / 2, base, cz);
  box(g, t, wh, d, wall, s.x1 - t / 2, base, cz);
  const gap = 2.6; // front wall with the door opening
  const side = (w - gap) / 2;
  box(g, side, wh, t, wall, s.x0 + side / 2, base, s.z1 - t / 2);
  box(g, side, wh, t, wall, s.x1 - side / 2, base, s.z1 - t / 2);
  // carpet racks along the back wall, rolled carpets stacked on them
  const racks = Math.max(2, Math.floor((w - 2) / 3.2));
  const pitch = (w - 2) / racks;
  for (let i = 0; i < racks; i++) {
    const x = s.x0 + 1 + pitch * (i + 0.5);
    // open rack: back board, two posts, rolls lying on it (visible from the aisle)
    box(g, 2.7, 2.1, 0.1, 0x5b4636, x, base + 0.12, s.z0 + 0.55);
    box(g, 0.1, 2.1, 0.7, 0x4a382b, x - 1.3, base + 0.12, s.z0 + 0.9);
    box(g, 0.1, 2.1, 0.7, 0x4a382b, x + 1.3, base + 0.12, s.z0 + 0.9);
    for (let r = 0; r < 4; r++) {
      const roll = new THREE.Mesh(ROLL, im(CARPETS[(i * 3 + r) % CARPETS.length], 0.95));
      roll.position.set(x, base + 0.35 + r * 0.46, s.z0 + 0.95);
      roll.castShadow = true;
      g.add(roll);
    }
  }
  // display rugs on the floor
  box(g, 3.2, 0.03, 2.2, CARPETS[0], cx - w * 0.2, base + 0.12, cz + 0.3);
  box(g, 3.2, 0.03, 2.2, CARPETS[3], cx + w * 0.2, base + 0.12, cz + 0.3);
  // cash counter beside the entrance
  box(g, 3.0, 1.05, 0.8, 0xf4f4f2, s.x1 - 3, base + 0.12, s.z1 - 2.2);
  box(g, 3.1, 0.06, 0.9, 0x2f3e4e, s.x1 - 3, base + 1.17, s.z1 - 2.2);
  return g;
}

/** Standing spots inside the store, front to back, never on the racks or the counter. */
function spots(s: BuildingSpec, n: number): THREE.Vector3[] {
  const w = s.x1 - s.x0, d = s.z1 - s.z0;
  const out: THREE.Vector3[] = [];
  const cols = Math.max(2, Math.floor((w - 4) / 2.2));
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    const x = s.x0 + 2 + ((w - 4) / Math.max(1, cols - 1)) * col;
    const z = s.z0 + d * 0.45 + row * 1.6;
    out.push(new THREE.Vector3(x, 0.62, Math.min(z, s.z1 - 1.2)));
  }
  return out;
}

export class NetworkScene {
  private renderer: THREE.WebGLRenderer;
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private root = new THREE.Group();
  private hits: THREE.Mesh[] = [];
  private outlines = new Map<string, THREE.LineSegments>();
  private buildings = new Map<string, StoreBuilding>();
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private frame = 0;
  private selected: string | null = null;
  private hovered: string | null = null;
  private resize: ResizeObserver;
  private down = { x: 0, y: 0 };
  private storeLabels: CSS2DObject[] = [];
  private near: boolean | null = null;
  private tweens = new Tweens();
  private clock = new THREE.Clock();
  /** the store currently opened as a cut-away */
  private inside: { unitId: string; interior: THREE.Group; people: Character[]; peopleLabels: CSS2DObject[] } | null = null;
  /** overview camera to return to when leaving a store */
  private overview: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  constructor(private host: HTMLElement, private ev: NetworkSceneEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.append(this.renderer.domElement);
    this.labels.domElement.className = "network-labels";
    host.append(this.labels.domElement);

    this.scene.background = new THREE.Color(0xe8eef3);
    this.scene.fog = new THREE.Fog(0xe8eef3, 900, 2200);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.44;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 1600;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c4cc, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(300, 500, 260);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -700, right: 700, top: 700, bottom: -700, near: 10, far: 1600 });
    this.scene.add(sun, sun.target);
    this.scene.add(this.root);

    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointerleave", this.onLeave);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.loop();
  }

  /** Rebuilds the network (cheap: a few dozen buildings). */
  setNetwork(net: NetworkDto) {
    this.clear();
    const m = createCampusMaterials();
    const regions = net.regions.filter((r) => r.units.length);
    const plots = regions.map((r) => {
      const cols = Math.min(PER_ROW, r.units.length);
      const rows = Math.ceil(r.units.length / PER_ROW);
      return { r, w: cols * STORE_PITCH_X + PLOT_PAD * 2, d: rows * STORE_PITCH_Z + PLOT_PAD * 2 };
    });
    // place plots in a grid; each grid row is as deep as its deepest plot
    const colW = Math.max(...plots.map((p) => p.w), 100);
    let z = 0;
    const boxes = new THREE.Box3();
    for (let i = 0; i < plots.length; i += REGION_COLS) {
      const row = plots.slice(i, i + REGION_COLS);
      const depth = Math.max(...row.map((p) => p.d));
      row.forEach((p, j) => {
        const x0 = j * (colW + REGION_GAP);
        this.addPlot(p.r.name, p.r.units, x0 + (colW - p.w) / 2, z, p.w, p.d, m);
        boxes.expandByPoint(new THREE.Vector3(x0, 0, z)).expandByPoint(new THREE.Vector3(x0 + colW, 0, z + depth));
      });
      z += depth + REGION_GAP;
    }
    const size = boxes.getSize(new THREE.Vector3());
    const center = boxes.getCenter(new THREE.Vector3());
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size.x + 600, size.z + 600), new THREE.MeshStandardMaterial({ color: 0xd9e2e8, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, -0.05, center.z);
    ground.receiveShadow = true;
    this.root.add(ground);
    this.controls.target.copy(center);
    const span = Math.max(size.x, size.z, 160);
    this.camera.position.set(center.x + span * 0.1, span * 0.55, center.z + span * 0.7);
    this.near = null;
  }

  private addPlot(name: string, units: UnitCardDto[], x0: number, z0: number, w: number, d: number, m: ReturnType<typeof createCampusMaterials>) {
    const plot = new THREE.Mesh(boxGeometryM(w, 0.4, d), new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.95 }));
    plot.position.set(x0 + w / 2, 0.2, z0 + d / 2);
    plot.receiveShadow = true;
    this.root.add(plot);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.4, d)), new THREE.LineBasicMaterial({ color: 0x9aa9b6 }));
    edge.position.copy(plot.position);
    this.root.add(edge);
    const title = label(name, "network-region");
    title.position.set(x0 + w / 2, 1, z0 + d + 4);
    this.root.add(title);

    units.forEach((u, i) => {
      const cx = x0 + PLOT_PAD + (i % PER_ROW) * STORE_PITCH_X + STORE_PITCH_X / 2;
      const cz = z0 + PLOT_PAD + Math.floor(i / PER_ROW) * STORE_PITCH_Z + STORE_PITCH_Z / 2;
      // ownership pad under the building: SAG blue for SAG-owned, amber for franchise
      const own = u.ownershipModel === "SAG_OWNED";
      const pad = new THREE.Mesh(boxGeometryM(24, 0.12, 20), new THREE.MeshStandardMaterial({ color: own ? 0xc9dcf0 : 0xf2dfb4, roughness: 0.9 }));
      pad.position.set(cx, 0.46, cz);
      pad.receiveShadow = true;
      this.root.add(pad);
      // one instancer per building, so its windows and doors hide with it when the store is opened
      const spec = storeSpec(u, cx, cz);
      const inst = new Instancer();
      const b = buildBuilding(spec, m, inst);
      for (const mesh of inst.build()) b.group.add(mesh);
      this.root.add(b.group);
      b.hit.userData.unitId = u.id;
      this.hits.push(b.hit);
      this.outlines.set(u.id, b.outline);
      const tag = u.isHeadOffice
        ? { text: "BOSH OFIS", cls: "net-badge hq" }
        : own ? { text: "HD · SAG", cls: "net-badge hd" } : { text: "F · Franshiza", cls: "net-badge f" };
      const l = label(u.name, "network-label", tag);
      l.position.set(cx, b.size.y + 4, cz);
      l.element.title = u.name;
      this.root.add(l);
      this.storeLabels.push(l);
      this.buildings.set(u.id, { unit: u, spec, group: b.group, label: l });
    });
  }

  /** Highlight + fly into the store and open it as a cut-away. `null` leaves the store and flies back out. */
  select(unitId: string | null) {
    if (unitId === this.selected) return;
    this.selected = unitId;
    this.paintOutlines();
    this.closeInterior();
    const b = unitId ? this.buildings.get(unitId) : undefined;
    if (!b) {
      if (this.overview) {
        const o = this.overview;
        this.overview = null;
        this.controls.minDistance = 40;
        void this.fly(o.pos, o.target);
      }
      return;
    }
    if (!this.overview) this.overview = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    const s = b.spec;
    const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2, w = s.x1 - s.x0;
    b.group.visible = false;
    b.label.visible = false;
    const interior = buildInterior(s);
    this.root.add(interior);
    this.inside = { unitId: b.unit.id, interior, people: [], peopleLabels: [] };
    this.controls.minDistance = 6;
    void this.fly(new THREE.Vector3(cx + w * 0.35, 10 + w * 0.25, cz + w * 0.95), new THREE.Vector3(cx, 0.8, cz));
  }

  /** People inside the opened store (only what the server returned for this viewer). */
  setOccupants(unitId: string, people: StoreOccupant[]) {
    if (!this.inside || this.inside.unitId !== unitId) return;
    this.clearPeople();
    const b = this.buildings.get(unitId)!;
    const at = spots(b.spec, people.length);
    people.forEach((p, i) => {
      const c = new Character(p.id, p.kind === "human");
      c.pose = p.kind === "ai" ? "standWait" : "stand";
      c.root.position.copy(at[i]);
      c.root.rotation.y = 0; // facing the entrance / camera side
      this.inside!.interior.add(c.root);
      this.inside!.people.push(c);
      if (p.kind === "ai") {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32), new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8 }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(at[i].x, 0.64, at[i].z);
        this.inside!.interior.add(ring);
      }
      const l = label(p.name, `network-person${p.kind === "ai" ? " ai" : ""}`, { text: p.role, cls: "net-role" });
      l.position.set(at[i].x, 2.35, at[i].z);
      this.inside!.interior.add(l);
      this.inside!.peopleLabels.push(l);
    });
  }

  private clearPeople() {
    if (!this.inside) return;
    for (const c of this.inside.people) c.root.removeFromParent();
    for (const l of this.inside.peopleLabels) {
      l.element.remove();
      l.removeFromParent();
    }
    this.inside.people = [];
    this.inside.peopleLabels = [];
  }

  private closeInterior() {
    if (!this.inside) return;
    this.clearPeople();
    this.inside.interior.traverse((x) => {
      if (x instanceof CSS2DObject) x.element.remove();
    });
    this.inside.interior.removeFromParent();
    const b = this.buildings.get(this.inside.unitId);
    if (b) {
      b.group.visible = true;
      b.label.visible = !!this.near;
    }
    this.inside = null;
  }

  private fly(pos: THREE.Vector3, target: THREE.Vector3) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    this.controls.enabled = false;
    return this.tweens.run(FLY_MS, (k) => {
      this.camera.position.lerpVectors(p0, pos, k);
      this.controls.target.lerpVectors(t0, target, k);
    }, ease.inOutCubic).then(() => {
      this.controls.enabled = true;
    });
  }

  private paintOutlines() {
    for (const [id, o] of this.outlines) {
      o.visible = id === this.selected || id === this.hovered;
      (o.material as THREE.LineBasicMaterial).color.set(id === this.selected ? 0x1d4ed8 : 0x64748b);
    }
  }

  private pick(e: PointerEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    return (this.ray.intersectObjects(this.hits, false)[0]?.object.userData.unitId as string | undefined) ?? null;
  }

  private onMove = (e: PointerEvent) => {
    const id = this.pick(e);
    if (id !== this.hovered) {
      this.hovered = id;
      this.paintOutlines();
      this.renderer.domElement.style.cursor = id ? "pointer" : "";
    }
    this.ev.onHover(id ? this.buildings.get(id)?.unit ?? null : null, e.clientX, e.clientY);
  };
  private onDown = (e: PointerEvent) => (this.down = { x: e.clientX, y: e.clientY });
  private onUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) return; // a drag, not a click
    const id = this.pick(e);
    if (id) this.ev.onSelect(id);
  };
  private onLeave = () => {
    this.hovered = null;
    this.paintOutlines();
    this.ev.onHover(null, 0, 0);
  };

  private fit() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.tweens.tick(performance.now());
    if (this.controls.enabled) this.controls.update();
    else this.camera.lookAt(this.controls.target);
    if (this.inside) for (const c of this.inside.people) c.update(dt, this.clock.elapsedTime);
    const near = this.camera.position.distanceTo(this.controls.target) < STORE_LABEL_DISTANCE || this.storeLabels.length <= 3;
    if (near !== this.near) {
      this.near = near;
      for (const l of this.storeLabels) l.visible = near && !(this.inside && this.buildings.get(this.inside.unitId)?.label === l);
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  private clear() {
    this.closeInterior();
    this.selected = null;
    this.overview = null;
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      o.traverse((x) => {
        if (x instanceof CSS2DObject) x.element.remove();
        const mesh = x as THREE.Mesh;
        mesh.geometry?.dispose?.();
      });
    }
    this.hits = [];
    this.storeLabels = [];
    this.outlines.clear();
    this.buildings.clear();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.tweens.finishAll();
    this.resize.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointerleave", this.onLeave);
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
    el.remove();
    this.labels.domElement.remove();
  }
}
