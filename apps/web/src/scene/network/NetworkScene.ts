// Stand-alone 3D view of the store district, for store accounts (they never see the HQ campus data).
// HQ sees the same district on the campus (SceneController); both use StoreDistrict.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { NetworkDto, UnitCardDto } from "@sag/shared";
import { Tweens, ease } from "../tween";
import { StoreDistrict, type StoreOccupant } from "./district";
import { landMaterial } from "../campus/materials";

export type { StoreOccupant } from "./district";

/** store labels appear only closer than this (region labels are always on), so the overview stays readable */
const STORE_LABEL_DISTANCE = 420;
const FLY_MS = 1100;
/** same sun as the campus (SceneController): front-left of the default camera, so shadows fall on the visible side */
const SUN_DIR = new THREE.Vector3(-52, 64, 40).normalize();

export interface NetworkSceneEvents {
  onSelect(unitId: string): void;
  onHover(unit: UnitCardDto | null, x: number, y: number): void;
}

export class NetworkScene {
  private renderer: THREE.WebGLRenderer;
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private district = new StoreDistrict();
  private ground: THREE.Mesh | null = null;
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private frame = 0;
  private hovered: string | null = null;
  private resize: ResizeObserver;
  private down = { x: 0, y: 0 };
  private tweens = new Tweens();
  private sun: THREE.DirectionalLight;
  private shadowKey = "";
  private shadowStore: string | null = null;
  private clock = new THREE.Clock();
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

    this.scene.add(new THREE.HemisphereLight(0xd6e6fb, 0xa8a68a, 0.8));
    const sun = new THREE.DirectionalLight(0xffeed6, 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.05;
    this.sun = sun;
    this.scene.add(sun, sun.target, this.district.root);

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

  setNetwork(net: NetworkDto) {
    this.overview = null;
    this.district.setNetwork(net);
    const size = this.district.bounds.getSize(new THREE.Vector3());
    const center = this.district.bounds.getCenter(new THREE.Vector3());
    if (this.ground) this.ground.removeFromParent();
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(size.x + 600, size.z + 600), landMaterial(Math.max(size.x, size.z) + 600));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(center.x, -0.05, center.z);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.shadowKey = "";
    this.controls.target.copy(center);
    const span = Math.max(size.x, size.z, 160);
    this.camera.position.set(center.x + span * 0.1, span * 0.55, center.z + span * 0.7);
  }

  /** Fly into the store and open it as a cut-away; `null` leaves it and flies back out. */
  select(unitId: string | null) {
    if (unitId === this.district.openStore) return;
    const view = unitId ? this.district.open(unitId) : null;
    if (!view) {
      this.district.close();
      if (this.overview) {
        const o = this.overview;
        this.overview = null;
        this.controls.minDistance = 40;
        void this.fly(o.pos, o.target);
      }
      return;
    }
    if (!this.overview) this.overview = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    this.controls.minDistance = 6;
    void this.fly(view.pos, view.target);
  }

  setOccupants(unitId: string, people: StoreOccupant[]) {
    this.district.setOccupants(unitId, people);
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

  private pick(e: PointerEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    return this.district.unitAt(this.ray.intersectObjects(this.district.pickables, false)[0]);
  }

  private onMove = (e: PointerEvent) => {
    const id = this.pick(e);
    if (id !== this.hovered) {
      this.hovered = id;
      this.district.setHovered(id);
      this.renderer.domElement.style.cursor = id ? "pointer" : "";
    }
    this.ev.onHover(id ? this.district.card(id) ?? null : null, e.clientX, e.clientY);
  };
  private onDown = (e: PointerEvent) => (this.down = { x: e.clientX, y: e.clientY });
  private onUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) return; // a drag, not a click
    const id = this.pick(e);
    if (id) this.ev.onSelect(id);
  };
  private onLeave = () => {
    this.hovered = null;
    this.district.setHovered(null);
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
    this.district.update(dt, this.clock.elapsedTime);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.district.setLabelDetail(dist < STORE_LABEL_DISTANCE);
    this.district.setDetail(dist);
    this.followShadows(dist);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  /**
   * The shadow box follows the view (crisp up close, the whole district from far away); the shadow map is redrawn
   * only after a refit or when a store is opened / closed, not on every frame.
   */
  private followShadows(dist: number) {
    const sm = this.renderer.shadowMap;
    sm.autoUpdate = this.district.openStore !== null;
    if (this.district.openStore !== this.shadowStore) {
      this.shadowStore = this.district.openStore;
      sm.needsUpdate = true;
    }
    const half = Math.pow(1.25, Math.round(Math.log(THREE.MathUtils.clamp(dist * 0.75, 45, 700)) / Math.log(1.25)));
    const step = half / 6;
    const t = this.controls.target;
    const cx = Math.round(t.x / step) * step, cz = Math.round(t.z / step) * step;
    const key = `${half.toFixed(1)}:${cx.toFixed(1)}:${cz.toFixed(1)}`;
    if (key === this.shadowKey) return;
    this.shadowKey = key;
    const far = half * 2.2 + 120;
    this.sun.position.set(cx, 0, cz).addScaledVector(SUN_DIR, far);
    this.sun.target.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = Math.max(1, far - half * 2); sc.far = far + half * 2;
    sc.updateProjectionMatrix();
    sm.needsUpdate = true;
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
    this.district.clear();
    this.controls.dispose();
    this.renderer.dispose();
    el.remove();
    this.labels.domElement.remove();
  }
}
