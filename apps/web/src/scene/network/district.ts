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
import { buildStoreInterior, type Rect, type Spot } from "./storeInterior";

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

const RING = new THREE.RingGeometry(0.42, 0.5, 32);

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
  private inside: { unitId: string; interior: THREE.Group; aiSpot: Spot; spots: Spot[]; people: Character[]; extra: THREE.Object3D[] } | null = null;

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
      const built = buildStoreInterior(b.rect);
      this.root.add(built.group);
      this.inside = { unitId, interior: built.group, aiSpot: built.aiSpot, spots: built.spots, people: [], extra: [] };
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
    const inside = this.inside;
    // the AI Director works at the monitor desk; people take the consultant desk, the reception, then the aisles
    const free = [...inside.spots];
    const place = (p: StoreOccupant): Spot => (p.kind === "ai" ? inside.aiSpot : free.shift() ?? inside.spots[inside.spots.length - 1]);
    people.forEach((p) => {
      const spot = place(p);
      const pos = spot.pos;
      const c = new Character(p.id, p.kind !== "ai");
      c.pose = p.kind === "ai" ? "standWait" : "stand";
      if (p.kind === "vacant") ghost(c);
      c.root.position.copy(pos);
      c.root.rotation.y = spot.yaw;
      inside.interior.add(c.root);
      inside.people.push(c);
      if (p.kind === "ai") {
        const ring = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8 }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(pos.x, pos.y + 0.02, pos.z);
        inside.interior.add(ring);
        inside.extra.push(ring);
      }
      const l = label(p.name, `network-person ${p.kind}`, { text: p.role, cls: "net-role" });
      l.position.set(pos.x, pos.y + 1.95, pos.z);
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
