// The SAG store network as a district of buildings: one plot per region, one building per business unit.
// Used on the campus (next to the head office) and in the stand-alone store view of store accounts.
// Positions are a SCHEMATIC layout (regions in a grid, stores in rows): the workbook has no addresses or coordinates,
// and none are invented. Buildings reuse the campus modules (buildBuilding + campus materials + instancer); people
// reuse the office Character. Opening a store turns it into a cut-away with the people the viewer may see.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { NetworkDto, UnitCardDto } from "@sag/shared";
import { boxGeometryM } from "../campus/materials";
import { Character } from "../office/character";
import { buildStore, lookFor } from "./storeLooks";

/** store footprint on the plot */
interface Rect { x0: number; x1: number; z0: number; z1: number }

const PER_ROW = 3;
const STORE_PITCH_X = 38;
const STORE_PITCH_Z = 34;
const PLOT_PAD = 10;
const REGION_COLS = 4;
const REGION_GAP = 22;

/**
 * Someone at a store: a person the viewer may see, the store's AI Director, or a vacant / not yet activated
 * position (drawn translucent; no identity is invented for it).
 */
export interface StoreOccupant {
  id: string;
  name: string;
  role: string;
  kind: "human" | "ai" | "vacant";
}

interface StoreBuilding {
  unit: UnitCardDto;
  rect: Rect;
  group: THREE.Group;
  label: CSS2DObject;
  outline: THREE.LineSegments;
}

export function label(text: string, cls: string, badge?: { text: string; cls: string }): CSS2DObject {
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

// ---- store interior (cut-away): terracotta walls, carpet racks, display rugs, blue reception desk.
const TERRACOTTA = 0xc0623f;
const RECEPTION_BLUE = 0x1f4fbf;
const CARPETS = [0x8c2f39, 0x1f3b5c, 0xc9b28a, 0x2f6f6a, 0x6b3f2a, 0x9a8f7a];
const imat = new Map<number, THREE.MeshStandardMaterial>();
const im = (c: number, rough = 0.85) => {
  let m = imat.get(c);
  if (!m) imat.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: rough })));
  return m;
};
const ROLL = new THREE.CylinderGeometry(0.22, 0.22, 2.4, 14).rotateZ(Math.PI / 2);
const RING = new THREE.RingGeometry(0.42, 0.5, 32);

function box(g: THREE.Group, w: number, h: number, d: number, color: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(boxGeometryM(w, h, d), im(color));
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function buildInterior(s: Rect): THREE.Group {
  const g = new THREE.Group();
  const w = s.x1 - s.x0, d = s.z1 - s.z0, cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
  const base = 0.5;
  box(g, w, 0.12, d, 0xead8c4, cx, base, cz); // warm floor
  const wall = TERRACOTTA, t = 0.3, wh = 1.6;
  box(g, w, wh, t, wall, cx, base, s.z0 + t / 2); // back
  box(g, t, wh, d, wall, s.x0 + t / 2, base, cz);
  box(g, t, wh, d, wall, s.x1 - t / 2, base, cz);
  const gap = 2.6; // front wall with the door opening
  const side = (w - gap) / 2;
  box(g, side, wh, t, wall, s.x0 + side / 2, base, s.z1 - t / 2);
  box(g, side, wh, t, wall, s.x1 - side / 2, base, s.z1 - t / 2);
  // open carpet racks along the back wall: back board, two posts, rolled carpets lying on them
  const racks = Math.max(2, Math.floor((w - 2) / 3.2));
  const pitch = (w - 2) / racks;
  for (let i = 0; i < racks; i++) {
    const x = s.x0 + 1 + pitch * (i + 0.5);
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
  // terracotta accent floor zone and the blue reception desk beside the entrance
  box(g, w * 0.4, 0.02, d * 0.35, 0xb85a3a, cx + w * 0.25, base + 0.12, s.z1 - d * 0.2);
  box(g, 4.2, 1.05, 0.9, RECEPTION_BLUE, s.x1 - 3.6, base + 0.12, s.z1 - 2.4);
  box(g, 4.3, 0.06, 1.0, 0xf4f4f2, s.x1 - 3.6, base + 1.17, s.z1 - 2.4);
  box(g, 0.9, 1.05, 2.2, RECEPTION_BLUE, s.x1 - 1.95, base + 0.12, s.z1 - 3.4);
  return g;
}

/** Standing spots inside the store, front to back, never on the racks or the counter. */
function spots(s: Rect, n: number): THREE.Vector3[] {
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

/** A vacant position reads as a translucent figure: same body, no identity. */
function ghost(c: Character) {
  for (const m of c.meshes) {
    const mat = (m.material as THREE.MeshStandardMaterial).clone();
    mat.transparent = true;
    mat.opacity = 0.32;
    mat.depthWrite = false;
    m.material = mat;
    m.castShadow = false;
  }
}

export class StoreDistrict {
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  private hits: THREE.Mesh[] = [];
  private buildings = new Map<string, StoreBuilding>();
  private storeLabels: CSS2DObject[] = [];
  private labelsNear = true;
  private hovered: string | null = null;
  private selected: string | null = null;
  private inside: { unitId: string; interior: THREE.Group; people: Character[]; extra: THREE.Object3D[] } | null = null;

  constructor() {
    this.root.name = "store-district";
  }

  get pickables(): THREE.Object3D[] {
    return this.hits;
  }

  get openStore(): string | null {
    return this.inside?.unitId ?? null;
  }

  card(unitId: string): UnitCardDto | undefined {
    return this.buildings.get(unitId)?.unit;
  }

  /** Builds the district with its north-west corner at `origin` (x, z). */
  setNetwork(net: NetworkDto, origin = new THREE.Vector3()) {
    this.clear();
    const regions = net.regions.filter((r) => r.units.length);
    const plots = regions.map((r) => {
      const cols = Math.min(PER_ROW, r.units.length);
      const rows = Math.ceil(r.units.length / PER_ROW);
      return { r, w: cols * STORE_PITCH_X + PLOT_PAD * 2, d: rows * STORE_PITCH_Z + PLOT_PAD * 2 };
    });
    // place plots in a grid; each grid row is as deep as its deepest plot
    const colW = Math.max(...plots.map((p) => p.w), 80);
    let z = origin.z;
    this.bounds.makeEmpty();
    for (let i = 0; i < plots.length; i += REGION_COLS) {
      const row = plots.slice(i, i + REGION_COLS);
      const depth = Math.max(...row.map((p) => p.d));
      row.forEach((p, j) => {
        const x0 = origin.x + j * (colW + REGION_GAP);
        this.addPlot(p.r.name, p.r.units, x0 + (colW - p.w) / 2, z, p.w, p.d);
        this.bounds.expandByPoint(new THREE.Vector3(x0, 0, z)).expandByPoint(new THREE.Vector3(x0 + colW, 0, z + depth));
      });
      z += depth + REGION_GAP;
    }
    this.applyLabels();
  }

  private addPlot(name: string, units: UnitCardDto[], x0: number, z0: number, w: number, d: number) {
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
      const pad = new THREE.Mesh(boxGeometryM(STORE_PITCH_X - 4, 0.12, STORE_PITCH_Z - 4), new THREE.MeshStandardMaterial({ color: own ? 0xc9dcf0 : 0xf2dfb4, roughness: 0.9 }));
      pad.position.set(cx, 0.46, cz);
      pad.receiveShadow = true;
      this.root.add(pad);
      // facade modelled after the store's photo (storeLooks.ts); the whole building hides when the store is opened
      const b = buildStore(lookFor(u.name, u.isHeadOffice), cx, cz - 2);
      this.root.add(b.group);
      b.hit.userData.unitId = u.id;
      this.hits.push(b.hit);
      const tag = u.isHeadOffice
        ? { text: "BOSH OFIS", cls: "net-badge hq" }
        : own ? { text: "HD · SAG", cls: "net-badge hd" } : { text: "F · Franshiza", cls: "net-badge f" };
      const l = label(u.name, "network-label", tag);
      l.position.set(cx, b.size.y + 4, cz);
      l.element.title = u.name;
      this.root.add(l);
      this.storeLabels.push(l);
      this.buildings.set(u.id, { unit: u, rect: b.rect, group: b.group, label: l, outline: b.outline });
    });
  }

  /** Store labels only when close enough to read them (region labels are always on). */
  setLabelDetail(near: boolean) {
    if (near === this.labelsNear) return;
    this.labelsNear = near;
    this.applyLabels();
  }

  private applyLabels() {
    const few = this.storeLabels.length <= 3;
    for (const b of this.buildings.values()) b.label.visible = (this.labelsNear || few) && b.unit.id !== this.inside?.unitId;
  }

  unitAt(hit: THREE.Intersection | undefined): string | null {
    return (hit?.object.userData.unitId as string | undefined) ?? null;
  }

  setHovered(id: string | null) {
    this.hovered = id;
    this.paintOutlines();
  }

  private paintOutlines() {
    for (const [id, b] of this.buildings) {
      b.outline.visible = id === this.selected || id === this.hovered;
      (b.outline.material as THREE.LineBasicMaterial).color.set(id === this.selected ? 0x1d4ed8 : 0x64748b);
    }
  }

  /** Opens a store as a cut-away and returns where the camera should look from. */
  open(unitId: string): { pos: THREE.Vector3; target: THREE.Vector3 } | null {
    const b = this.buildings.get(unitId);
    if (!b) return null;
    if (this.inside?.unitId !== unitId) {
      this.close();
      b.group.visible = false;
      const interior = buildInterior(b.rect);
      this.root.add(interior);
      this.inside = { unitId, interior, people: [], extra: [] };
    }
    this.selected = unitId;
    this.paintOutlines();
    this.applyLabels();
    const s = b.rect;
    const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2, w = s.x1 - s.x0;
    return { pos: new THREE.Vector3(cx + w * 0.35, 10 + w * 0.25, cz + w * 0.95), target: new THREE.Vector3(cx, 0.8, cz) };
  }

  close() {
    if (this.inside) {
      this.clearPeople();
      this.inside.interior.removeFromParent();
      const b = this.buildings.get(this.inside.unitId);
      if (b) b.group.visible = true;
      this.inside = null;
    }
    this.selected = null;
    this.paintOutlines();
    this.applyLabels();
  }

  /** People at the opened store (only what the server returned for this viewer, plus vacant positions). */
  setOccupants(unitId: string, people: StoreOccupant[]) {
    if (!this.inside || this.inside.unitId !== unitId) return;
    this.clearPeople();
    const b = this.buildings.get(unitId)!;
    const at = spots(b.rect, people.length);
    const inside = this.inside;
    people.forEach((p, i) => {
      const c = new Character(p.id, p.kind !== "ai");
      c.pose = p.kind === "ai" ? "standWait" : "stand";
      if (p.kind === "vacant") ghost(c);
      c.root.position.copy(at[i]);
      inside.interior.add(c.root);
      inside.people.push(c);
      if (p.kind === "ai") {
        const ring = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8 }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(at[i].x, 0.64, at[i].z);
        inside.interior.add(ring);
        inside.extra.push(ring);
      }
      const l = label(p.name, `network-person ${p.kind}`, { text: p.role, cls: "net-role" });
      l.position.set(at[i].x, 2.35, at[i].z);
      inside.interior.add(l);
      inside.extra.push(l);
    });
  }

  private clearPeople() {
    if (!this.inside) return;
    for (const c of this.inside.people) c.root.removeFromParent();
    for (const x of this.inside.extra) {
      if (x instanceof CSS2DObject) x.element.remove();
      x.removeFromParent();
    }
    this.inside.people = [];
    this.inside.extra = [];
  }

  /** Idle animation of the people in the opened store; true while there is something to animate. */
  update(dt: number, t: number): boolean {
    if (!this.inside?.people.length) return false;
    for (const c of this.inside.people) c.update(dt, t);
    return true;
  }

  clear() {
    this.close();
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      o.traverse((x) => {
        if (x instanceof CSS2DObject) x.element.remove();
      });
    }
    this.hits = [];
    this.storeLabels = [];
    this.buildings.clear();
    this.bounds.makeEmpty();
  }
}
