// Assembles the SAG campus around the existing office model: buildings, site, labels, picking.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { AREAS, BUILDINGS, CAMPUS_BOUNDS, HQ, type BuildingSpec } from "./layout";
import { createCampusMaterials } from "./materials";
import { Instancer } from "./instancer";
import { buildBuilding, type BuiltBuilding } from "./buildings";
import { buildSite } from "./site";

export interface CampusBuildingInfo {
  id: string;
  name: string;
  category: string;
  interaction: "office" | "inspect";
  info?: string;
}

export interface CampusTarget {
  info: CampusBuildingInfo;
  center: THREE.Vector3;
  size: THREE.Vector3;
}

function label(text: string, cls: string): CSS2DObject {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return new CSS2DObject(el);
}

export class CampusScene {
  readonly root = new THREE.Group();
  readonly surface: THREE.Group;
  readonly targets = new Map<string, CampusTarget>();
  private built: BuiltBuilding[] = [];
  private hits: THREE.Object3D[] = [];
  private hqOutline: THREE.LineSegments;
  private labels: CSS2DObject[] = [];
  /** labels shown only when the camera is closer than this (detail labels); major ones are always on */
  private detailLabels = new Set<CSS2DObject>();
  private near = false;
  private active = false;
  private labelsOn = true;
  private hovered: string | null = null;

  constructor() {
    this.root.name = "campus";
    const m = createCampusMaterials();
    const inst = new Instancer();

    for (const spec of BUILDINGS) {
      const b = buildBuilding(spec, m, inst);
      this.built.push(b);
      this.root.add(b.group);
      this.hits.push(b.hit);
      this.targets.set(spec.id, { info: infoOf(spec), center: b.center, size: b.size });
      const minor = !MAJOR.has(spec.id);
      const l = label(spec.name, `campus-label${minor ? " minor" : ""}`);
      l.position.set(b.center.x, b.size.y + 2, b.center.z);
      this.root.add(l);
      this.labels.push(l);
      if (minor) this.detailLabels.add(l);
    }

    // SAG lettering on the stone gate wall, right of the gate (photo 2).
    const gw = BUILDINGS.find((b) => b.id === "gatewall")!;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.25 * (915 / 298), 2.25), m.sign); // logo proportions
    sign.position.set(gw.x0 + 21.5, 3.4, gw.z1 + 0.04);
    this.root.add(sign);

    // The office model stays the central asset; it only gets a picking volume and an outline here.
    const hqSize = new THREE.Vector3(HQ.x1 - HQ.x0, HQ.h, HQ.z1 - HQ.z0);
    const hqCenter = new THREE.Vector3((HQ.x0 + HQ.x1) / 2, HQ.h / 2, (HQ.z0 + HQ.z1) / 2);
    const hqGeo = new THREE.BoxGeometry(hqSize.x + 1, hqSize.y + 4, hqSize.z + 1);
    const hqHit = new THREE.Mesh(hqGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hqHit.position.copy(hqCenter).setY((hqSize.y + 4) / 2);
    hqHit.userData.buildingId = HQ.id;
    this.root.add(hqHit);
    this.hits.push(hqHit);
    this.hqOutline = new THREE.LineSegments(new THREE.EdgesGeometry(hqGeo), new THREE.LineBasicMaterial({ color: 0x1d4ed8 }));
    this.hqOutline.position.copy(hqHit.position);
    this.hqOutline.visible = false;
    this.root.add(this.hqOutline);
    this.targets.set(HQ.id, { info: { ...HQ }, center: hqCenter, size: hqSize });
    const hqLabel = label(HQ.name, "campus-label hq");
    hqLabel.position.set(hqCenter.x, HQ.h + 9, hqCenter.z);
    this.root.add(hqLabel);
    this.labels.push(hqLabel);

    for (const a of AREAS) {
      const l = label(a.label, "campus-label area");
      l.position.set(a.x, 1.5, a.z);
      this.root.add(l);
      this.labels.push(l);
      this.detailLabels.add(l);
    }

    const site = buildSite(m, inst);
    this.surface = site.surface;
    this.root.add(site.root);
    for (const mesh of inst.build()) {
      // ground-level instancing (cars, markings, lamps) disappears with the surface in basement view
      if (/^(car|mark|lamp)/.test(mesh.name)) site.surface.add(mesh);
      else this.root.add(mesh);
    }
  }

  get pickables(): THREE.Object3D[] {
    return this.hits;
  }

  setLabelsVisible(on: boolean) {
    this.labelsOn = on;
    this.applyLabels();
  }

  /** Detail labels (small structures, outdoor areas) appear only when zoomed in, so the aerial view stays clean. */
  updateLabelDetail(cameraDistance: number) {
    const near = cameraDistance < 380;
    if (near === this.near) return;
    this.near = near;
    this.applyLabels();
  }

  private applyLabels() {
    for (const l of this.labels) l.visible = this.active && this.labelsOn && (this.near || !this.detailLabels.has(l));
  }

  get labelsVisible() {
    return this.labelsOn;
  }

  setHovered(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    for (const b of this.built) b.outline.visible = b.spec.id === id;
    this.hqOutline.visible = id === HQ.id;
    for (const l of this.labels) l.element.classList.toggle("hot", false);
  }

  /** Hide/show labels while the office interior is open (CSS2D ignores parent visibility). */
  setActive(on: boolean) {
    this.active = on;
    this.applyLabels();
    if (!on) this.setHovered(null);
  }

  static readonly bounds = CAMPUS_BOUNDS;
}

const MAJOR = new Set(["factory-a", "factory-c", "warehouse", "endblock"]);

function infoOf(s: BuildingSpec): CampusBuildingInfo {
  return { id: s.id, name: s.name, category: s.category, interaction: s.interaction, info: s.info };
}
