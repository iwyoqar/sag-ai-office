// Reusable campus building modules: industrial halls, stone annex/gate wall, passage wall, guard booth.
// Dimensions come from layout.ts; repeated details (windows, doors, AC units, vents, solar) are instanced.
import * as THREE from "three";
import type { BuildingSpec, Side, WindowKind } from "./layout";
import { boxGeometryM, type CampusMaterials } from "./materials";
import { Instancer, UNIT } from "./instancer";
import { truckModel } from "./site";

let TRUCK: ReturnType<typeof truckModel> | null = null;
const hashN = (n: number) => {
  const x = Math.sin(n * 57.3 + 19.1) * 43758.5453;
  return x - Math.floor(x);
};

/** A delivery truck backed up to a door: rear at `out` metres from the facade, pointing away from it. */
export function addTruck(inst: Instancer, m: CampusMaterials, pos: THREE.Vector3, rotY: number) {
  const t = (TRUCK ??= truckModel());
  inst.add("truck-box", t.box, m.white, pos, undefined, { y: rotY });
  inst.add("truck-cab", t.cab, m.blueTrim, pos, undefined, { y: rotY });
  inst.add("truck-glass", t.glass, m.carGlass, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
  inst.add("truck-tyre", t.tyres, m.tyre, pos, undefined, { y: rotY }, null, { cast: false, receive: false });
}

export interface BuiltBuilding {
  spec: BuildingSpec;
  group: THREE.Group;
  hit: THREE.Mesh;
  outline: THREE.LineSegments;
  center: THREE.Vector3;
  size: THREE.Vector3;
}

const WINDOW_SIZE: Record<WindowKind, { w: number; h: number }> = {
  small: { w: 1.6, h: 1.4 },
  ribbon: { w: 1.25, h: 1.5 },
  office: { w: 3.0, h: 1.9 },
  tall: { w: 2.2, h: 3.0 },
};

/** Facade frame for one side of a building: origin at the facade's low end, along-axis, outward normal. */
function facade(s: BuildingSpec, side: Side) {
  const along = side === "+z" || side === "-z" ? "x" : "z";
  const length = along === "x" ? s.x1 - s.x0 : s.z1 - s.z0;
  const at = (t: number, y: number, out: number) => {
    switch (side) {
      case "+z": return new THREE.Vector3(s.x0 + t, y, s.z1 + out);
      case "-z": return new THREE.Vector3(s.x0 + t, y, s.z0 - out);
      case "+x": return new THREE.Vector3(s.x1 + out, y, s.z0 + t);
      case "-x": return new THREE.Vector3(s.x0 - out, y, s.z0 + t);
    }
  };
  const rotY = along === "x" ? 0 : Math.PI / 2;
  return { length, at, rotY, along };
}

/** Scale vector for a facade-aligned element of width w, height h, thickness t. */
const fScale = (w: number, h: number, t: number) => ({ x: w, y: h, z: t });

function winMaterial(m: CampusMaterials, kind: WindowKind, stone: boolean) {
  if (stone) return m.winBlue;
  return { small: m.winSmall, ribbon: m.winRibbon, office: m.winOffice, tall: m.winTall }[kind];
}

export function buildBuilding(spec: BuildingSpec, m: CampusMaterials, inst: Instancer): BuiltBuilding {
  const g = new THREE.Group();
  g.name = `building-${spec.id}`;
  const w = spec.x1 - spec.x0, d = spec.z1 - spec.z0, h = spec.h;
  const cx = (spec.x0 + spec.x1) / 2, cz = (spec.z0 + spec.z1) / 2;
  const stone = spec.cladding === "stone";
  const clad = stone ? m.stone : m.ribbed;

  if (spec.id === "booth") {
    buildBooth(g, spec, m);
  } else {
    const opening = spec.doors?.find((x) => x.kind === "gate" && spec.id === "passage");
    if (opening) {
      // Wall with a drive-through opening (photo 6).
      const f = facade(spec, opening.side);
      const a = opening.at - opening.w / 2, b = opening.at + opening.w / 2;
      const pieces: [number, number, number, number][] = [
        [0, a, 0, h], [b, f.length, 0, h], [a, b, opening.h, h],
      ];
      for (const [t0, t1, y0, y1] of pieces) {
        const box = new THREE.Mesh(boxGeometryM(w, y1 - y0, t1 - t0), clad);
        box.position.set(cx, (y0 + y1) / 2, spec.z0 + (t0 + t1) / 2);
        box.castShadow = box.receiveShadow = true;
        g.add(box);
      }
    } else {
      const body = new THREE.Mesh(boxGeometryM(w, h, d), [clad, clad, m.roof, clad, clad, clad]);
      body.position.set(cx, h / 2, cz);
      body.castShadow = body.receiveShadow = true;
      g.add(body);
    }

    if (!stone) {
      // stone / brick plinth band along the base (photos 4, 6, 7)
      const plinth = new THREE.Mesh(boxGeometryM(w + 0.12, 0.6, d + 0.12), m.stoneDark);
      plinth.position.set(cx, 0.3, cz);
      plinth.receiveShadow = true;
      if (!opening) g.add(plinth);
    } else {
      const cornice = new THREE.Mesh(boxGeometryM(w + 0.5, 0.45, d + 0.5), m.stone);
      cornice.position.set(cx, h - 0.2, cz);
      cornice.castShadow = true;
      g.add(cornice);
    }

    if (spec.blueTrim) {
      const t = 0.22, th = 0.7, y = h - th / 2 + 0.05;
      inst.add("trim", UNIT.box, m.blueTrim, { x: cx, y, z: spec.z1 + t / 2 }, { x: w + 2 * t, y: th, z: t });
      inst.add("trim", UNIT.box, m.blueTrim, { x: cx, y, z: spec.z0 - t / 2 }, { x: w + 2 * t, y: th, z: t });
      inst.add("trim", UNIT.box, m.blueTrim, { x: spec.x1 + t / 2, y, z: cz }, { x: t, y: th, z: d });
      inst.add("trim", UNIT.box, m.blueTrim, { x: spec.x0 - t / 2, y, z: cz }, { x: t, y: th, z: d });
    }
    if (spec.blueTiles) {
      // blue roof-tile coping (photos 2, 6)
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.45, 0.3, d + 0.45), m.blueTiles);
      cap.position.set(cx, h + 0.12, cz);
      cap.castShadow = true;
      g.add(cap);
    }
    if (spec.parapetStep) {
      const p = spec.parapetStep;
      const doorZ = spec.z0 + (spec.doors?.[0]?.at ?? d / 2);
      const par = new THREE.Mesh(boxGeometryM(w, p.h, p.w), [clad, clad, m.roof, clad, clad, clad]);
      par.position.set(cx, h + p.h / 2, doorZ);
      par.castShadow = par.receiveShadow = true;
      g.add(par);
    }
  }

  // ---- windows
  for (const run of spec.windows ?? []) {
    const f = facade(spec, run.side);
    const size = WINDOW_SIZE[run.kind];
    const mat = winMaterial(m, run.kind, stone);
    const step = run.every ?? size.w;
    for (let t = run.from + size.w / 2; t <= run.to - size.w / 2 + 1e-6; t += step) {
      const p = f.at(t, run.y + size.h / 2, 0.05);
      inst.add(`win-${mat.uuid}`, UNIT.box, mat, p, fScale(size.w, size.h, 0.14), { y: f.rotY }, null, { cast: false, receive: true });
      if (!stone) inst.add("sill", UNIT.box, m.white, f.at(t, run.y - 0.06, 0.12), fScale(size.w + 0.15, 0.1, 0.28), { y: f.rotY });
    }
  }

  // ---- doors
  for (const door of spec.doors ?? []) {
    if (spec.id === "passage") continue;
    const f = facade(spec, door.side);
    if (door.kind === "roller") {
      inst.add("roller", UNIT.box, m.roller, f.at(door.at, door.h / 2, 0.06), fScale(door.w, door.h, 0.14), { y: f.rotY });
      inst.add("roller-box", UNIT.box, m.white, f.at(door.at, door.h + 0.3, 0.25), fScale(door.w + 0.4, 0.6, 0.5), { y: f.rotY });
      // blue sign plate above loading doors (photo 4)
      inst.add("door-sign", UNIT.box, m.blueTrim, f.at(door.at, door.h + 1.2, 0.08), fScale(1.8, 0.7, 0.06), { y: f.rotY });
      // loading bay: yellow box markings, dock bumpers, and (on most doors) a truck backed up to it
      const bayLen = 9, bw = door.w + 1.2;
      for (const sx of [-1, 1])
        inst.add("mark-bay", UNIT.box, m.markingYellow, f.at(door.at + (sx * bw) / 2, 0.06, bayLen / 2 + 0.3), fScale(0.15, 0.01, bayLen), { y: f.rotY }, null, { cast: false, receive: true });
      inst.add("mark-bay", UNIT.box, m.markingYellow, f.at(door.at, 0.06, bayLen + 0.3), fScale(bw, 0.01, 0.15), { y: f.rotY }, null, { cast: false, receive: true });
      for (const sx of [-1, 1]) inst.add("bumper", UNIT.box, m.tyre, f.at(door.at + sx * (door.w / 2 + 0.25), 0.9, 0.15), fScale(0.3, 0.5, 0.3), { y: f.rotY });
      if (hashN(door.at + spec.x0) < 0.7) {
        // truck length runs out along the facade normal, rear doors 0.6 m from the wall
        const p = f.at(door.at, 0.03, 0.6);
        const out = new THREE.Vector3().subVectors(f.at(door.at, 0, 1), f.at(door.at, 0, 0));
        addTruck(inst, m, p, Math.atan2(-out.z, out.x));
      }
    } else if (door.kind === "gate") {
      const gate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m.gate);
      gate.scale.set(door.w, door.h, 0.3);
      gate.position.copy(f.at(door.at, door.h / 2, 0.1));
      gate.rotation.y = f.rotY;
      gate.castShadow = true;
      g.add(gate);
    } else if (stone) {
      // glazed entrance with a dark canopy (photos 2–3)
      inst.add("glass-door", UNIT.box, m.glassDoor, f.at(door.at, door.h / 2, 0.06), fScale(door.w, door.h, 0.14), { y: f.rotY });
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(door.w + 3, 0.22, 3.2), m.darkCanopy);
      canopy.position.copy(f.at(door.at, door.h + 0.55, 1.6));
      canopy.rotation.y = f.rotY;
      canopy.rotation.x = -0.12;
      canopy.castShadow = true;
      g.add(canopy);
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, door.h + 0.5, 8), m.darkCanopy);
        post.position.copy(f.at(door.at + s * (door.w / 2 + 1.2), (door.h + 0.5) / 2, 3.0));
        g.add(post);
      }
    } else {
      inst.add("door", UNIT.box, m.door, f.at(door.at, door.h / 2, 0.06), fScale(door.w, door.h, 0.12), { y: f.rotY });
      inst.add("fire-box", UNIT.box, m.red, f.at(door.at + door.w / 2 + 0.9, 0.9, 0.2), fScale(0.45, 1.1, 0.35), { y: f.rotY });
    }
  }

  // ---- canopy along a side (photo 4 left, photo 7)
  if (spec.canopy) {
    const f = facade(spec, spec.canopy.side);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(f.length, 0.35, spec.canopy.depth), m.canopy);
    slab.position.copy(f.at(f.length / 2, spec.canopy.y, spec.canopy.depth / 2));
    slab.rotation.y = f.rotY;
    slab.castShadow = slab.receiveShadow = true;
    g.add(slab);
  }

  // ---- AC units on the wall
  if (spec.acUnits) {
    const a = spec.acUnits;
    const f = facade(spec, a.side);
    for (let t = a.from; t <= a.to; t += a.every)
      inst.add("ac", UNIT.box, m.ac, f.at(t, a.y, 0.25), fScale(0.95, 0.7, 0.38), { y: f.rotY });
  }

  // ---- roof vents (photo 1)
  if (spec.roofVents) {
    const n = spec.roofVents;
    for (let i = 0; i < n; i++) {
      const x = spec.x0 + ((i + 0.5) / n) * w;
      inst.add("vent", UNIT.box, m.vent, { x, y: h + 0.7, z: spec.z0 + 1.6 }, { x: 0.9, y: 1.4, z: 0.9 });
      inst.add("vent-cap", UNIT.box, m.vent, { x, y: h + 1.5, z: spec.z0 + 1.6 }, { x: 1.4, y: 0.18, z: 1.4 });
    }
  }

  // ---- solar arrays (satellite: almost every factory roof)
  if (spec.solar) addSolar(spec, m, inst);

  // ---- picking volume + hover outline
  const top = h + (spec.parapetStep?.h ?? 0) + (spec.blueTiles ? 0.5 : 0);
  const hitGeo = new THREE.BoxGeometry(w + 0.6, top + 0.4, d + 0.6);
  const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  hit.visible = false; // picking only: the raycaster ignores visibility, the renderer skips the draw call
  hit.position.set(cx, (top + 0.4) / 2, cz);
  hit.userData.buildingId = spec.id;
  g.add(hit);
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(hitGeo), new THREE.LineBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.9 }));
  outline.position.copy(hit.position);
  outline.visible = false;
  g.add(outline);

  return { spec, group: g, hit, outline, center: new THREE.Vector3(cx, top / 2, cz), size: new THREE.Vector3(w, top, d) };
}

function addSolar(spec: BuildingSpec, m: CampusMaterials, inst: Instancer) {
  const margin = 3, seg = 10, gap = 0.8, pitch = 2.7;
  const y = spec.h + 0.55;
  for (let z = spec.z0 + margin; z <= spec.z1 - margin; z += pitch) {
    for (let x = spec.x0 + margin + seg / 2; x <= spec.x1 - margin - seg / 2; x += seg + gap) {
      inst.add("solar", UNIT.box, m.solar, { x, y, z }, { x: seg, y: 0.06, z: 1.7 }, { x: -0.28 }, null, { cast: true, receive: false });
      inst.add("solar-rail", UNIT.box, m.solarFrame, { x, y: y - 0.3, z: z - 0.4 }, { x: seg, y: 0.5, z: 0.08 }, {}, null, { cast: false, receive: false });
    }
  }
}

function buildBooth(g: THREE.Group, s: BuildingSpec, m: CampusMaterials) {
  const w = s.x1 - s.x0, d = s.z1 - s.z0;
  const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, 1.0, d), m.white);
  base.position.set(cx, 0.5, cz);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 1.4, d - 0.1), m.winOffice);
  glass.position.set(cx, 1.7, cz);
  const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.25, d + 0.1), m.white);
  band.position.set(cx, 2.5, cz);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.85, 1.2, 4), m.brownRoof);
  roof.position.set(cx, 3.2, cz);
  roof.rotation.y = Math.PI / 4;
  for (const o of [base, glass, band, roof]) {
    o.castShadow = o.receiveShadow = true;
    g.add(o);
  }
}
