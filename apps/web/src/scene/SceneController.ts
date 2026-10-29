import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { FloorDto } from "@sag/shared";
import { agentsOfFloor, peopleOfFloor, type Office } from "../api/office";
import { ATTIC, FL, PLINTH, PODIUM, X0, X1, Z0, Z1, floorRange, outline } from "./buildingGeometry";
import { CloudBank } from "./clouds";
import { FloorInterior, interiorKey, type Interior } from "./interior";
import { OfficeFloor } from "./office/OfficeFloor";
import { planFor } from "./office/plan";
import { Tweens, ease, lerp } from "./tween";
import { CampusScene, type CampusBuildingInfo } from "./campus/CampusScene";
import { CAMPUS_BOUNDS } from "./campus/layout";

export interface SceneEvents {
  onProgress(p: number): void;
  onLoaded(): void;
  onError(msg: string): void;
  onIntroDone(): void;
  onHover(floorId: string | null, x: number, y: number): void;
  onSelectFloor(floorId: string): void;
  onSelectAgent(agentId: string | null): void;
  /** a human employee was clicked in the 3D office */
  onSelectEmployee(employeeId: string): void;
  onHoverAgent(agentId: string | null, x: number, y: number): void;
  onHoverBuilding(info: CampusBuildingInfo | null, x: number, y: number): void;
  onSelectBuilding(id: string): void;
}

export type SceneMode = "intro" | "campus" | "building" | "overview" | "floor";

interface FloorZone {
  floor: FloorDto;
  group: THREE.Group;
  fill: THREE.MeshBasicMaterial;
  edges: THREE.LineBasicMaterial;
  meshes: THREE.Mesh[];
  hover: number; // 0..1, animated
}

const OVERVIEW_TARGET = new THREE.Vector3(-1, 11, 2);
const CAMPUS_TARGET = new THREE.Vector3((CAMPUS_BOUNDS.x0 + CAMPUS_BOUNDS.x1) / 2, 0, (CAMPUS_BOUNDS.z0 + CAMPUS_BOUNDS.z1) / 2 - 8);
const NO_CLIP = 1e4;
/** The model's own demo paving/street; replaced by the campus site (its centre dashes stay as the drive-aisle line). */
const GLB_GROUND = new Set(["paving", "asphalt"]);
const INTRO_KEY = "sag.introSeen";
const SUN_DIR = new THREE.Vector3(45, 80, 55).normalize();

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Owns the Three.js scene. React talks to it only through these methods and SceneEvents. */
export class SceneController {
  private renderer: THREE.WebGLRenderer;
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 6000);
  private controls: OrbitControls;
  private tweens = new Tweens();
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerClient = { x: 0, y: 0 };
  private pointerDirty = false;
  private downAt: { x: number; y: number } | null = null;
  private sun!: THREE.DirectionalLight;
  private fog = new THREE.Fog(0xdbe7f3, 400, 3000);

  private building: THREE.Object3D | null = null;
  private ghost: THREE.Object3D | null = null;
  private buildingMaterials: THREE.Material[] = [];
  private clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), NO_CLIP);
  private ghostClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), -NO_CLIP);
  private basementGround!: THREE.Mesh;
  private outerGround!: THREE.Mesh;
  private campus: CampusScene;
  private zones: FloorZone[] = [];
  private interiors = new Map<string, Interior>();
  private clouds: CloudBank | null = null;
  private introPath: THREE.CatmullRomCurve3 | null = null;

  private mode: SceneMode = "intro";
  private currentFloor: string | null = null;
  private focusedBuilding: string | null = null;
  private office: Office | null = null;
  private hovered: string | null = null;
  private hoveredBuilding: string | null = null;
  private hoveredAgent: string | null = null;
  private selectedAgent: string | null = null;
  /** recent agent→agent handoffs (from backend agent.message events), drawn as arcs on the open floor */
  private linkPairs: [string, string][] = [];
  private needsRender = 2;
  private raf = 0;
  private disposed = false;
  private loaded = false;
  private introStarted = false;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** realistic furnished floors; `?simple` in the URL falls back to the lightweight zone view */
  private realistic = !new URLSearchParams(location.search).has("simple");

  constructor(private host: HTMLElement, private ev: SceneEvents) {
    // Log depth keeps ground layers (paving, asphalt, markings) stable from 20 m to 1.5 km away.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.labels.domElement.className = "label-layer";
    host.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enabled = false;
    this.controls.maxPolarAngle = 1.42;
    this.controls.screenSpacePanning = false; // pan along the ground
    this.controls.addEventListener("change", () => {
      this.clampTarget();
      this.invalidate();
    });

    this.setupEnvironment();
    this.campus = new CampusScene();
    this.scene.add(this.campus.root);
    this.campus.setActive(false);
    this.setupIntro();
    this.resize();
    this.bindEvents();
    this.loadModel();
    this.loop();
  }

  // ---- setup ---------------------------------------------------------------
  private setupEnvironment() {
    const s = this.scene;
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 256;
    const g = c.getContext("2d")!;
    // Deep blue Samarkand sky from the photos, paling toward the horizon.
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#2f6cc9");
    grad.addColorStop(0.5, "#6fa3e3");
    grad.addColorStop(1, "#d9e7f5");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const bg = new THREE.CanvasTexture(c);
    bg.colorSpace = THREE.SRGBColorSpace;
    s.background = bg;
    s.fog = this.fog;

    // Sky environment: blue zenith, bright horizon, warm ground — gives the curtain glass its blue reflection.
    const envScene = new THREE.Scene();
    const sky = new THREE.SphereGeometry(100, 32, 16);
    const col: number[] = [];
    const pos = sky.attributes.position;
    const zen = new THREE.Color(0x3a74d0), hor = new THREE.Color(0xe4eef8), gnd = new THREE.Color(0x8d857a);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 100;
      const c3 = y >= 0 ? hor.clone().lerp(zen, Math.pow(y, 0.55)) : hor.clone().lerp(gnd, Math.min(1, -y * 4));
      col.push(c3.r, c3.g, c3.b);
    }
    sky.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    envScene.add(new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.6, 5) }));
    sunDisc.position.copy(SUN_DIR).multiplyScalar(80);
    envScene.add(sunDisc);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    s.environment = pmrem.fromScene(envScene, 0.02).texture;
    s.environmentIntensity = 0.75;
    pmrem.dispose();

    s.add(new THREE.HemisphereLight(0xdce9fa, 0xb9ab95, 1.0));
    const sun = new THREE.DirectionalLight(0xfff2df, 2.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.05;
    s.add(sun, sun.target);
    this.sun = sun;
    this.frameShadows("campus");

    const outerMat = new THREE.MeshStandardMaterial({ color: 0xc2baa8, roughness: 1 });
    this.outerGround = new THREE.Mesh(new THREE.CircleGeometry(4000, 64), outerMat);
    this.outerGround.rotation.x = -Math.PI / 2;
    this.outerGround.position.y = -0.14;
    this.outerGround.receiveShadow = true;
    s.add(this.outerGround);

    // Ground with a hole over the basement, shown only when the basement is open.
    const sq = new THREE.Shape([new THREE.Vector2(-70, -60), new THREE.Vector2(70, -60), new THREE.Vector2(70, 70), new THREE.Vector2(-70, 70)]);
    const hole = new THREE.Path([
      new THREE.Vector2(X0 - 0.5, -(Z0 - 0.5)), new THREE.Vector2(X0 - 0.5, -(Z1 + 0.5)),
      new THREE.Vector2(X1 + 0.5, -(Z1 + 0.5)), new THREE.Vector2(X1 + 0.5, -(Z0 - 0.5)),
    ]);
    sq.holes.push(hole);
    this.basementGround = new THREE.Mesh(new THREE.ShapeGeometry(sq), new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 1 }));
    this.basementGround.rotation.x = -Math.PI / 2;
    this.basementGround.position.y = 0.0;
    this.basementGround.receiveShadow = true;
    this.basementGround.visible = false;
    s.add(this.basementGround);
  }

  /** Fit the sun's shadow frustum to what is on screen: the whole campus, or the office up close. */
  private frameShadows(kind: "campus" | "office") {
    const center = kind === "campus" ? CAMPUS_TARGET.clone() : new THREE.Vector3(0, 8, 0);
    const half = kind === "campus" ? 290 : 50;
    const dist = kind === "campus" ? 700 : 160;
    this.sun.position.copy(center).addScaledVector(SUN_DIR, dist);
    this.sun.target.position.copy(center);
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = dist - half * 1.6; sc.far = dist + half * 1.6;
    sc.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  private setupIntro() {
    const end = this.campusCamera().pos;
    const dir = end.clone().sub(CAMPUS_TARGET).normalize();
    this.introPath = new THREE.CatmullRomCurve3([
      CAMPUS_TARGET.clone().addScaledVector(dir, 2600).add(new THREE.Vector3(0, 900, 0)),
      CAMPUS_TARGET.clone().addScaledVector(dir, 1900).add(new THREE.Vector3(0, 520, 0)),
      CAMPUS_TARGET.clone().addScaledVector(dir, 1300).add(new THREE.Vector3(0, 200, 0)),
      end.clone().addScaledVector(dir, 120),
      end,
    ]);
    this.camera.position.copy(this.introPath.getPointAt(0));
    this.camera.lookAt(CAMPUS_TARGET.clone().add(new THREE.Vector3(0, 160, 0)));
    if (this.reducedMotion) return;
    this.clouds = new CloudBank(this.introPath, 18, 11, 9);
    this.scene.add(this.clouds.root);
  }

  private loadModel() {
    new GLTFLoader().load(
      "/models/sag-bino.glb",
      (gltf) => {
        if (this.disposed) return;
        this.building = gltf.scene;
        this.building.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const mat = m.material as THREE.MeshStandardMaterial;
          if (GLB_GROUND.has(mat.name)) {
            m.visible = false;
            return;
          }
          m.castShadow = true;
          m.receiveShadow = true;
          if (!this.buildingMaterials.includes(mat)) {
            mat.side = THREE.DoubleSide;
            mat.clippingPlanes = [this.clip];
            mat.clipShadows = true;
            // Curtain glass: crisper, bluer reflection of the sky (photos 2–3).
            if (mat.name === "glass") {
              mat.roughness = 0.04;
              mat.envMapIntensity = 1.5;
            }
            this.buildingMaterials.push(mat);
          }
        });
        this.scene.add(this.building);
        this.buildGhost();
        this.loaded = true;
        this.buildZones();
        this.ev.onProgress(1);
        this.ev.onLoaded();
        this.invalidate();
        this.maybeStartIntro();
      },
      (e) => {
        if (e.total) this.ev.onProgress(e.loaded / e.total);
      },
      (err) => this.ev.onError(err instanceof Error ? err.message : "3D modelni yuklab bo'lmadi"),
    );
  }

  /**
   * Wireframe of the building above the cut (floor lines + facade verticals), so the opened floor keeps
   * its context. A translucent mesh copy was tried first: its stacked roof/cornice caps washed the floor out.
   */
  private buildGhost() {
    const mat = new THREE.LineBasicMaterial({ color: 0x5b7aa3, transparent: true, opacity: 0.45, clippingPlanes: [this.ghostClip] });
    const ring = outline(0.05);
    const ghost = new THREE.Group();
    const levels = [PLINTH, ...FL, ATTIC];
    for (const y of levels) {
      const pts = ring.map(([x, z]) => new THREE.Vector3(x, y, z));
      ghost.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    const verts: THREE.Vector3[] = [];
    ring.forEach(([x, z], i) => {
      if (i % 3 === 0) verts.push(new THREE.Vector3(x, PLINTH, z), new THREE.Vector3(x, ATTIC, z));
    });
    ghost.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(verts), mat));
    ghost.visible = false;
    this.ghost = ghost;
    this.scene.add(ghost);
  }

  /** Hover/click volumes per floor, extruded from the facade outline at that floor's height. */
  private buildZones() {
    if (!this.office || !this.loaded || this.zones.length) return;
    const shape = new THREE.Shape(outline(0.45).map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const floor of this.office.floors) {
      if (floor.level < 1) continue;
      const { y0, y1 } = floorRange(floor.level);
      const color = this.office.departments[floor.departments[0]]?.color ?? "#1d4ed8";
      const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const edges = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0 });
      const group = new THREE.Group();
      const meshes: THREE.Mesh[] = [];
      const add = (geo: THREE.BufferGeometry) => {
        const mesh = new THREE.Mesh(geo, fill);
        mesh.userData.floorId = floor.id;
        mesh.renderOrder = 10;
        meshes.push(mesh);
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edges);
        line.renderOrder = 11;
        group.add(mesh, line);
      };
      const h = y1 - y0 - 0.1;
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 4 });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, y0 + 0.05, 0);
      add(geo);
      if (floor.level === 1) {
        const p = new THREE.BoxGeometry(PODIUM.x1 - PODIUM.x0 + 0.8, PODIUM.top + 0.4, PODIUM.z1 - PODIUM.z0 + 0.4);
        p.translate((PODIUM.x0 + PODIUM.x1) / 2, (PODIUM.top + 0.4) / 2, (PODIUM.z0 + PODIUM.z1) / 2 + 0.2);
        add(p);
      }
      group.visible = this.mode === "overview";
      this.scene.add(group);
      this.zones.push({ floor, group, fill, edges, meshes, hover: 0 });
    }
  }

  // ---- intro ---------------------------------------------------------------
  private maybeStartIntro() {
    if (this.introStarted || !this.loaded) return;
    this.introStarted = true;
    let seen = false;
    try {
      seen = localStorage.getItem(INTRO_KEY) === "1";
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* storage unavailable: play the full intro */
    }
    const dur = this.reducedMotion ? 0 : seen ? 2200 : 5200;
    const path = this.introPath!;
    const lookFrom = CAMPUS_TARGET.clone().add(new THREE.Vector3(0, 160, 0));
    this.tweens
      .run(dur, (k) => {
        this.camera.position.copy(path.getPointAt(k));
        this.camera.lookAt(lookFrom.clone().lerp(CAMPUS_TARGET, ease.outCubic(k)));
        this.clouds?.update(k, performance.now());
      }, ease.inOutSine)
      .then(() => this.finishIntro());
  }

  skipIntro() {
    if (this.mode !== "intro") return;
    if (!this.loaded) return;
    this.tweens.finishAll();
  }

  private finishIntro() {
    if (this.mode !== "intro") return;
    this.clouds?.dispose();
    this.clouds = null;
    this.mode = "campus";
    this.campus.setActive(true);
    const { pos } = this.campusCamera();
    void this.tweens.run(this.reducedMotion ? 0 : 700, (k) => {
      // Ease the projection centre toward the free area as the panels slide in.
      const ins = this.insets();
      this.camera.setViewOffset(ins.w, ins.h, ((ins.right - ins.left) / 2) * k, ((ins.bottom - ins.top) / 2) * k, ins.w, ins.h);
      this.camera.updateProjectionMatrix();
    }, ease.inOutCubic);
    this.camera.position.copy(pos);
    this.controls.target.copy(CAMPUS_TARGET);
    this.applyLimits("campus");
    this.controls.enabled = true;
    this.controls.update();
    this.invalidate();
    this.ev.onIntroDone();
  }

  // ---- camera framing ------------------------------------------------------
  /** Screen area covered by UI panels; the camera frames the subject in what is left. */
  private insets() {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    const top = 56;
    if (w <= 860) return { w, h, left: 0, right: 0, top, bottom: Math.round(h * 0.38) };
    return { w, h, left: 268, right: 392, top, bottom: 0 };
  }

  /** Distance that fits a w×h box into the free (uncovered) part of the view. */
  private fitDistance(w: number, h: number): number {
    const ins = this.insets();
    const freeW = Math.max(200, ins.w - ins.left - ins.right);
    const freeH = Math.max(200, ins.h - ins.top - ins.bottom);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    // Fraction of the full frustum the free area spans.
    const tanV = Math.tan(vfov / 2) * (freeH / ins.h);
    const tanH = Math.tan(vfov / 2) * this.camera.aspect * (freeW / ins.w);
    return Math.max(h / 2 / tanV, w / 2 / tanH) * 1.08;
  }

  /** Shift the projection so the look-at point lands in the centre of the free area. */
  private applyViewOffset() {
    const ins = this.insets();
    const dx = (ins.right - ins.left) / 2;
    const dy = (ins.bottom - ins.top) / 2;
    this.camera.setViewOffset(ins.w, ins.h, dx, dy, ins.w, ins.h);
  }

  private campusCamera() {
    const w = CAMPUS_BOUNDS.x1 - CAMPUS_BOUNDS.x0;
    const d = CAMPUS_BOUNDS.z1 - CAMPUS_BOUNDS.z0;
    // Screen-space extent of the footprint rotated by the view azimuth; depth foreshortened by the tilt.
    const az = THREE.MathUtils.degToRad(24), po = THREE.MathUtils.degToRad(54);
    const projW = w * Math.cos(az) + d * Math.sin(az);
    const projH = (w * Math.sin(az) + d * Math.cos(az)) * Math.cos(po) + 20 * Math.sin(po);
    const dist = this.fitDistance(projW * 0.9, projH * 0.9);
    return { pos: this.spherical(CAMPUS_TARGET, dist, 24, 54), target: CAMPUS_TARGET.clone() };
  }

  private buildingCamera(id: string) {
    const t = this.campus.targets.get(id)!;
    const span = Math.max(t.size.x, t.size.z);
    const target = t.center.clone().setY(t.size.y * 0.35);
    const dist = Math.max(45, this.fitDistance(Math.min(span, 220) * 1.05, t.size.y * 2.2 + 20));
    return { pos: this.spherical(target, dist, 28, 64), target };
  }

  private overviewCamera() {
    const d = this.fitDistance(52, 38);
    return { pos: this.spherical(OVERVIEW_TARGET, d, 28, 76), target: OVERVIEW_TARGET.clone() };
  }

  private floorCamera(level: number) {
    const { y0 } = floorRange(level);
    const target = new THREE.Vector3(0, y0 + 0.8, -1.5);
    // Interior is ~36×20 m; seen at 52° from vertical its on-screen height shrinks, so fit a flatter box.
    const d = this.fitDistance(37, 19);
    return { pos: this.spherical(target, d, 14, 52), target };
  }

  private spherical(target: THREE.Vector3, dist: number, azDeg: number, polarDeg: number) {
    const az = THREE.MathUtils.degToRad(azDeg), po = THREE.MathUtils.degToRad(polarDeg);
    return new THREE.Vector3(Math.sin(po) * Math.sin(az), Math.cos(po), Math.sin(po) * Math.cos(az)).multiplyScalar(dist).add(target);
  }

  private applyLimits(kind: "campus" | "building" | "overview" | "floor", basement = false) {
    const c = this.controls;
    switch (kind) {
      case "campus":
        c.minDistance = 40; c.maxDistance = 1500; c.maxPolarAngle = 1.38; c.enablePan = true;
        break;
      case "building":
        c.minDistance = 20; c.maxDistance = 700; c.maxPolarAngle = 1.45; c.enablePan = true;
        break;
      case "overview":
        c.minDistance = 30; c.maxDistance = 220; c.maxPolarAngle = 1.42; c.enablePan = false;
        break;
      case "floor":
        c.minDistance = 14; c.maxDistance = 120; c.maxPolarAngle = basement ? 1.25 : 1.42; c.enablePan = false;
        break;
    }
  }

  /** Keep the orbit target on the campus so panning never drifts into empty land. */
  private clampTarget() {
    if (this.mode !== "campus" && this.mode !== "building") return;
    const t = this.controls.target;
    t.x = THREE.MathUtils.clamp(t.x, CAMPUS_BOUNDS.x0, CAMPUS_BOUNDS.x1);
    t.z = THREE.MathUtils.clamp(t.z, CAMPUS_BOUNDS.z0, CAMPUS_BOUNDS.z1);
    t.y = THREE.MathUtils.clamp(t.y, 0, 30);
  }

  private async flyTo(pos: THREE.Vector3, target: THREE.Vector3, ms: number) {
    this.controls.enabled = false;
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    // Long hops (campus ↔ office) arc upward a little instead of skimming the roofs.
    const lift = Math.min(120, p0.distanceTo(pos) * 0.15);
    await this.tweens.run(this.reducedMotion ? 0 : ms, (k) => {
      this.camera.position.lerpVectors(p0, pos, k);
      this.camera.position.y += Math.sin(Math.PI * k) * lift;
      this.controls.target.lerpVectors(t0, target, k);
      this.camera.lookAt(this.controls.target);
    });
    this.controls.enabled = true;
    this.controls.update();
  }

  // ---- campus / building / office modes ------------------------------------
  private leaveFloor() {
    if (this.mode !== "floor" || !this.currentFloor) return;
    const interior = this.interiors.get(this.currentFloor);
    if (interior) {
      interior.root.visible = false;
      for (const z of interior.zones) z.label.visible = false;
    }
    this.currentFloor = null;
    this.setClip(NO_CLIP);
    this.setBasementMode(false);
    if (this.ghost) this.ghost.visible = false;
    this.selectedAgent = null;
    this.setAgentHighlight(null);
  }

  private setZonesVisible(on: boolean) {
    for (const z of this.zones) z.group.visible = on;
  }

  async showCampus() {
    if (this.mode === "intro") return;
    this.leaveFloor();
    this.mode = "campus";
    this.focusedBuilding = null;
    this.setHovered(null);
    this.setZonesVisible(false);
    this.campus.setActive(true);
    this.frameShadows("campus");
    this.applyLimits("campus");
    const { pos, target } = this.campusCamera();
    await this.flyTo(pos, target, 1400);
  }

  async focusBuilding(id: string) {
    if (this.mode === "intro" || !this.campus.targets.has(id)) return;
    this.leaveFloor();
    this.mode = "building";
    this.focusedBuilding = id;
    this.setZonesVisible(false);
    this.campus.setActive(true);
    this.campus.setHovered(id);
    this.frameShadows("campus");
    this.applyLimits("building");
    const { pos, target } = this.buildingCamera(id);
    await this.flyTo(pos, target, 1300);
  }

  /** The office building with hoverable floors (the Phase 1 experience). */
  async showOffice() {
    if (this.mode === "intro") this.tweens.finishAll();
    if (this.mode === "floor") return this.closeFloor();
    this.mode = "overview";
    this.focusedBuilding = null;
    this.campus.setActive(false);
    this.setZonesVisible(true);
    this.frameShadows("office");
    this.applyLimits("overview");
    const { pos, target } = this.overviewCamera();
    await this.flyTo(pos, target, 1400);
  }

  setLabelsVisible(on: boolean) {
    this.campus.setLabelsVisible(on);
    if (this.mode !== "campus" && this.mode !== "building") this.campus.setActive(false);
    this.invalidate();
  }

  // ---- floor selection -----------------------------------------------------
  private floorById(id: string): FloorDto | undefined {
    return this.office?.floors.find((f) => f.id === id);
  }

  private buildInterior(floor: FloorDto): Interior {
    const o = this.office!;
    const deps = Object.values(o.departments);
    const agents = agentsOfFloor(o, floor.id);
    const people = peopleOfFloor(o, floor.id);
    const own = floor.departments.map((id) => o.departments[id]).filter((d) => !!d);
    // Realistic office (furniture + walking people) when the floor has a plan; simple zones otherwise.
    const plan = this.realistic ? planFor(floor.id, own.map((d) => ({ id: d.id, name: d.name, color: d.color, weight: d.weight }))) : undefined;
    // (the lightweight zone view has no desks for people; they appear on realistic floors)
    const it: Interior = plan ? new OfficeFloor(floor, plan, deps, agents, people) : new FloorInterior(floor, deps, agents);
    it.root.visible = false;
    this.scene.add(it.root);
    this.interiors.set(floor.id, it);
    return it;
  }

  private interiorFor(floorId: string): Interior {
    return this.interiors.get(floorId) ?? this.buildInterior(this.floorById(floorId)!);
  }

  /**
   * New backend snapshot. Agent status changes update figures in place; a changed roster
   * (hire, archive, transfer) rebuilds that floor's interior.
   */
  setOffice(office: Office) {
    this.office = office;
    this.buildZones();
    for (const [id, it] of [...this.interiors]) {
      const floor = this.floorById(id);
      if (!floor) continue;
      const agents = agentsOfFloor(office, id);
      const people = it instanceof OfficeFloor ? peopleOfFloor(office, id) : [];
      if (it.key !== interiorKey(floor, Object.values(office.departments), agents, people)) {
        const wasOpen = this.currentFloor === id;
        it.dispose();
        this.interiors.delete(id);
        if (wasOpen) {
          const fresh = this.buildInterior(floor);
          fresh.root.visible = true;
          this.setAgentHighlight(this.selectedAgent);
        }
      } else {
        it.applyAgents(agents);
        it.applyPeople?.(people);
      }
    }
    this.invalidate();
  }

  private setClip(h: number) {
    this.clip.constant = h;
    this.ghostClip.constant = -h;
  }

  private setBasementMode(on: boolean) {
    this.campus.surface.visible = !on;
    this.outerGround.visible = !on;
    this.basementGround.visible = on;
  }

  async openFloor(floorId: string) {
    const floor = this.floorById(floorId);
    if (!floor || !this.loaded) return;
    if (this.mode === "intro") this.tweens.finishAll();
    const prev = this.currentFloor;
    this.mode = "floor";
    this.currentFloor = floorId;
    this.focusedBuilding = null;
    this.campus.setActive(false);
    this.frameShadows("office");
    this.setHovered(null);
    this.setAgentHighlight(null);
    this.selectedAgent = null;
    this.setZonesVisible(false);
    // CSS2D labels ignore parent visibility, so hide them explicitly.
    for (const [id, it] of this.interiors) {
      if (id === floorId) continue;
      it.root.visible = false;
      for (const z of it.zones) z.label.visible = false;
    }
    const interior = this.interiorFor(floorId);
    interior.root.visible = true;
    interior.setLinks(this.linkPairs);
    for (const z of interior.zones) z.label.visible = true;
    this.setBasementMode(floor.level === -1);
    if (this.ghost) this.ghost.visible = true;

    // Section cut just above desk height, so the facade never hides the room behind it.
    const { y0 } = floorRange(floor.level);
    // Basement: cut just below ground so the plinth's bottom cap (y = 0) does not lid the room.
    const cut = floor.level === -1 ? -0.05 : y0 + 1.5;
    const from = prev ? this.clip.constant : ATTIC + 12;
    const cam = this.floorCamera(floor.level);
    this.applyLimits("floor", floor.level === -1);
    await Promise.all([
      this.tweens.run(this.reducedMotion ? 0 : 900, (k) => this.setClip(lerp(from, cut, k)), ease.outCubic),
      this.flyTo(cam.pos, cam.target, 1200),
    ]);
  }

  async closeFloor() {
    if (this.mode !== "floor" || !this.currentFloor) return;
    const interior = this.interiors.get(this.currentFloor)!;
    for (const z of interior.zones) z.label.visible = false;
    this.mode = "overview";
    this.currentFloor = null;
    this.setAgentHighlight(null);
    this.selectedAgent = null;
    const from = this.clip.constant;
    const { pos, target } = this.overviewCamera();
    this.applyLimits("overview");
    await Promise.all([
      this.tweens.run(this.reducedMotion ? 0 : 900, (k) => this.setClip(lerp(from, ATTIC + 14, k)), ease.inOutCubic),
      this.flyTo(pos, target, 1200),
    ]);
    if (this.mode !== "overview") return; // another floor was opened mid-flight
    this.setClip(NO_CLIP);
    interior.root.visible = false;
    this.setBasementMode(false);
    if (this.ghost) this.ghost.visible = false;
    this.setZonesVisible(true);
    this.invalidate();
  }

  /** Handoffs between agents; pairs whose sender is not on the open floor are ignored by the interior. */
  showLinks(pairs: [string, string][]) {
    this.linkPairs = pairs;
    if (this.currentFloor) this.interiors.get(this.currentFloor)?.setLinks(pairs);
    this.invalidate();
  }

  selectAgent(agentId: string | null) {
    this.selectedAgent = agentId;
    this.setAgentHighlight(agentId);
  }

  // ---- hover / pick --------------------------------------------------------
  private setHovered(id: string | null) {
    if (this.hovered === id) return;
    this.hovered = id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "";
    this.invalidate();
  }

  private setAgentHighlight(id: string | null) {
    for (const it of this.interiors.values())
      for (const f of it.figures) f.setHighlighted(f.agentId === id || f.agentId === this.selectedAgent);
  }

  private pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.mode === "campus" || this.mode === "building") {
      const hit = this.raycaster.intersectObjects(this.campus.pickables, false)[0];
      const id = (hit?.object.userData.buildingId as string) ?? null;
      if (id !== this.hoveredBuilding) {
        this.hoveredBuilding = id;
        this.campus.setHovered(id ?? this.focusedBuilding);
        this.renderer.domElement.style.cursor = id ? "pointer" : "";
        this.invalidate();
      }
      this.ev.onHoverBuilding(id ? this.campus.targets.get(id)!.info : null, this.pointerClient.x, this.pointerClient.y);
    } else if (this.mode === "overview") {
      const hit = this.raycaster.intersectObjects(this.zones.flatMap((z) => z.meshes), false)[0];
      const id = (hit?.object.userData.floorId as string) ?? null;
      this.setHovered(id);
      this.ev.onHover(id, this.pointerClient.x, this.pointerClient.y);
    } else if (this.mode === "floor" && this.currentFloor) {
      const it = this.interiors.get(this.currentFloor)!;
      const hit = this.raycaster.intersectObjects(it.pickables, false)[0];
      const id = (hit?.object.userData.agentId as string) ?? null;
      if (id !== this.hoveredAgent) {
        this.hoveredAgent = id;
        this.setAgentHighlight(id);
        this.renderer.domElement.style.cursor = id ? "pointer" : "";
      }
      // the agent tooltip is for AI agents; a person's name plate already shows who they are
      this.ev.onHoverAgent(id?.startsWith("emp:") ? null : id, this.pointerClient.x, this.pointerClient.y);
    }
  }

  private bindEvents() {
    const el = this.renderer.domElement;
    const setPointer = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerClient = { x: e.clientX, y: e.clientY };
    };
    el.addEventListener("pointermove", (e) => {
      setPointer(e);
      this.pointerDirty = true;
    });
    el.addEventListener("pointerleave", () => {
      this.setHovered(null);
      this.hoveredBuilding = null;
      this.campus.setHovered(this.focusedBuilding);
      this.ev.onHover(null, 0, 0);
      this.ev.onHoverAgent(null, 0, 0);
      this.ev.onHoverBuilding(null, 0, 0);
    });
    el.addEventListener("pointerdown", (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (!this.downAt || Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 6) return;
      this.downAt = null;
      setPointer(e);
      this.pick();
      if ((this.mode === "campus" || this.mode === "building") && this.hoveredBuilding) this.ev.onSelectBuilding(this.hoveredBuilding);
      else if (this.mode === "overview" && this.hovered) this.ev.onSelectFloor(this.hovered);
      else if (this.mode === "floor" && this.hoveredAgent?.startsWith("emp:")) this.ev.onSelectEmployee(this.hoveredAgent.slice(4));
      else if (this.mode === "floor" && this.hoveredAgent) this.ev.onSelectAgent(this.hoveredAgent);
    });
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
  }
  private onResize = () => {};

  private resize() {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    if (this.mode === "intro") this.camera.clearViewOffset();
    else this.applyViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.invalidate();
  }

  // ---- render loop (renders only when something changes) ------------------
  invalidate(frames = 2) {
    this.needsRender = Math.max(this.needsRender, frames);
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const t = this.clock.getElapsedTime();
    if (this.pointerDirty && !this.tweens.active) {
      this.pointerDirty = false;
      this.pick();
    }
    let animating = this.tweens.active;
    this.tweens.tick(now);
    if (this.mode === "intro" && this.clouds) {
      // Gentle drift while the model is still downloading.
      if (!this.introStarted) this.clouds.update(0, now);
      animating = true;
    }
    for (const z of this.zones) {
      const target = z.floor.id === this.hovered ? 1 : 0;
      if (Math.abs(z.hover - target) > 0.001) {
        z.hover += (target - z.hover) * 0.18;
        animating = true;
      } else z.hover = target;
      const pulse = target ? 0.04 * Math.sin(t * 4) : 0;
      z.fill.opacity = z.hover * 0.3 + pulse * z.hover;
      z.edges.opacity = z.hover * 0.95;
      if (target) animating = true;
    }
    if (this.mode === "floor" && this.currentFloor) {
      this.interiors.get(this.currentFloor)?.update(t);
      animating = true;
    }
    if (this.controls.enabled) this.controls.update();
    if (animating) this.needsRender = Math.max(this.needsRender, 1);
    if (this.needsRender > 0) {
      this.needsRender--;
      // Haze scales with viewing distance: clear up close, soft over the campus horizon.
      const dist = this.camera.position.distanceTo(this.controls.target);
      this.fog.near = dist * 1.3 + 80;
      this.fog.far = dist * 5 + 900;
      this.campus.updateLabelDetail(dist);
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    }
  };

  /** Debug hook for automated checks. */
  debugState() {
    return {
      mode: this.mode, floor: this.currentFloor, building: this.focusedBuilding, clip: this.clip.constant, loaded: this.loaded,
      camera: this.camera.position.toArray().map((v) => Math.round(v * 10) / 10),
      target: this.controls.target.toArray().map((v) => Math.round(v * 10) / 10),
      renderCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.clouds?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
