// The SAG store network as a district of buildings: one block per region, one building per business unit.
// Used on the campus (next to the head office) and in the stand-alone store view of store accounts.
// Positions are a SCHEMATIC layout (compact rows of stores, districtLayout.ts): the workbook has no addresses or
// coordinates, and none are invented. Buildings reuse the campus modules (buildBuilding + campus materials + instancer); people
// reuse the office Character. Opening a store turns it into a cut-away with the people the viewer may see.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { NetworkDto, UnitCardDto } from "@sag/shared";
import { Batch } from "../campus/batch";
import { Instancer } from "../campus/instancer";
import { Character } from "../office/character";
import { buildStore, lookFor } from "./storeLooks";
import { buildStoreInterior, type Rect, type Spot } from "./storeInterior";
import { buildBlockLamps, buildRegionPlot, buildStoreLot } from "./storeLot";
import { planDistrict, type DistrictPlan } from "./districtLayout";
/** lot props (cars, trees, lamps, fences) are drawn only closer than this */
const DETAIL_DISTANCE = 1400;
/** lot props are instanced per 120 m tile, so frustum culling drops the off-screen ones */
const PROP_TILE = 120;


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
  private lotBatch = new Batch();
  private lotProps = new Instancer(PROP_TILE);
  private details = new THREE.Group();
  private detailOn = true;
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

  /** the current layout (streets for the road graph, store positions) */
  plan: DistrictPlan | null = null;

  /** Builds the district from the compact layout plan (districtLayout.ts) and returns the plan. */
  setNetwork(net: NetworkDto): DistrictPlan {
    this.clear();
    const plan = planDistrict(net.regions.filter((r) => r.units.length));
    this.plan = plan;
    const { cellW, cellD } = plan.cfg;
    this.bounds.set(new THREE.Vector3(plan.bounds.x0, 0, plan.bounds.z0), new THREE.Vector3(plan.bounds.x1, 0, plan.bounds.z1));
    plan.blocks.forEach((blk, i) => {
      const inBlock = plan.stores.filter((s) => s.row === blk.row && s.cx > blk.x0 && s.cx < blk.x1);
      // keep street trees off the driveways (front) and the loading gates (rear)
      const front = inBlock.map((s) => ({ x0: s.cx + 9, x1: s.cx + 17 }));
      const rear = inBlock.map((s) => {
        const dock = s.cx + lookFor(s.unit.name, s.unit.isHeadOffice).w / 4;
        return { x0: dock - 4, x1: dock + 4 };
      });
      buildRegionPlot(blk.x0, blk.z0, blk.x1 - blk.x0, blk.z1 - blk.z0, this.lotBatch, this.lotProps, i * 7 + 3, { front, rear });
      buildBlockLamps(blk.x0, blk.z0, blk.x1 - blk.x0, blk.z1 - blk.z0, this.lotProps);
      if (blk.label) {
        const title = label(blk.region, "network-region");
        title.position.set((blk.x0 + blk.x1) / 2, 1, blk.z1 + plan.cfg.street / 2);
        this.root.add(title);
      }
    });
    plan.stores.forEach((p, i) => {
      const u = p.unit;
      const own = u.ownershipModel === "SAG_OWNED";
      // the building sits back on its lot: forecourt, a parking row and a drive aisle in front, loading yard behind
      const look = lookFor(u.name, u.isHeadOffice);
      const bz = p.cz - 4;
      const b = buildStore(look, p.cx, bz, true);
      buildStoreLot({ cx: p.cx, cz: p.cz, cellW, cellD, bz, look, own, seed: i * 3 + 7 }, this.lotBatch, this.lotProps);
      this.addStore(u, b, p.cx, p.cz, own);
    });
    this.root.add(...this.lotBatch.build());
    this.details = new THREE.Group();
    this.details.name = "store-lot-props";
    this.details.add(...this.lotProps.build());
    this.details.visible = this.detailOn;
    this.root.add(this.details);
    this.lotProps = new Instancer(PROP_TILE);
    this.applyLabels();
    return plan;
  }

  private addStore(u: UnitCardDto, b: ReturnType<typeof buildStore>, cx: number, cz: number, own: boolean) {
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
  }

  /** Level of detail: lot props only when the camera is close enough to see them. */
  setDetail(cameraDistance: number) {
    const on = cameraDistance < DETAIL_DISTANCE;
    if (on === this.detailOn) return;
    this.detailOn = on;
    this.details.visible = on;
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
