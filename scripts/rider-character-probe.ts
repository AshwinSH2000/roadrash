import * as THREE from "three";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { FIXED_DT } from "../src/core/Clock";
import { makeGltfBikeVisualsFactory, DEFAULT_BIKE_FITTING } from "../src/entities/BikeVisuals";
import { loadRiderForTest } from "./rider-skeleton-probe";
import { setRiderCharacter } from "../src/entities/RiderCharacter";
import { DEFAULT_VEHICLE_CONFIG } from "../src/physics/VehicleController";

const COMPONENT: Record<number, [new (b: ArrayBuffer, o: number, l: number) => ArrayLike<number>, number]> = {
  5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2],
  5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const COMPONENTS_PER: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function loadGlb(path: string): THREE.Group {
  const file = readFileSync(path);
  if (file.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a .glb file`);
  const jsonLength = file.readUInt32LE(12);
  const gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
  const bin = file.subarray(20 + jsonLength + 8);

  const readAccessor = (index: number): Float32Array => {
    const accessor = gltf.accessors[index];
    const view = gltf.bufferViews[accessor.bufferView];
    const [Ctor, bytes] = COMPONENT[accessor.componentType];
    const per = COMPONENTS_PER[accessor.type];
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? bytes * per;
    const out = new Float32Array(accessor.count * per);
    for (let e = 0; e < accessor.count; e++) {
      const src = new Ctor(bin.buffer, bin.byteOffset + start + e * stride, per);
      for (let k = 0; k < per; k++) out[e * per + k] = src[k];
    }
    return out;
  };

  const material = new THREE.MeshStandardMaterial();
  const buildNode = (index: number): THREE.Object3D => {
    const node = gltf.nodes[index];
    let object: THREE.Object3D;

    if (node.mesh !== undefined) {
      const group = new THREE.Group();
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(readAccessor(primitive.attributes.POSITION), 3));
        if (primitive.attributes.NORMAL !== undefined) {
          geometry.setAttribute("normal", new THREE.BufferAttribute(readAccessor(primitive.attributes.NORMAL), 3));
        }
        if (primitive.indices !== undefined) {
          geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(readAccessor(primitive.indices)), 1));
        }
        group.add(new THREE.Mesh(geometry, material));
      }
      // A glTF node holds at most one mesh, so collapse the wrapper when it
      // has a single primitive — the node name must land on the Mesh itself
      // for name-based wheel lookup to see it.
      object = group.children.length === 1 ? group.children[0] : group;
    } else {
      object = new THREE.Group();
    }

    object.name = node.name ?? "";
    if (node.matrix) {
      object.applyMatrix4(new THREE.Matrix4().fromArray(node.matrix));
    } else {
      if (node.translation) object.position.fromArray(node.translation);
      if (node.rotation) object.quaternion.fromArray(node.rotation);
      if (node.scale) object.scale.fromArray(node.scale);
    }
    for (const child of node.children ?? []) object.add(buildNode(child));
    return object;
  };

  const scene = new THREE.Group();
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? gltf.nodes.map((_: unknown, i: number) => i);
  for (const r of roots) scene.add(buildNode(r));
  return scene;
}


/**
 * The skinned rider on the real bike at rest on a flat road: do the hands meet
 * the grips and the feet the pegs, and where does the body end up? Checks the
 * pose maths with numbers, since the shape of the result has to be seen to be
 * judged.
 *
 * Run with: node scripts/run-sim.mjs ridercharacter
 */
const model = loadGlb(resolve("public/assets/bike.glb"));
const { factory } = makeGltfBikeVisualsFactory(model, { ...DEFAULT_BIKE_FITTING });
const rider = await loadRiderForTest();
setRiderCharacter(rider.scene);

const physics = await PhysicsWorld.create();
const surfaces = new SurfaceRegistry();
const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
surfaces.register(
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1.0), ground),
  ROAD_SURFACE,
);
const scene = new THREE.Scene();
const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1.2, 0), new THREE.Quaternion(), 0xd23030, factory);
const state = new RiderStateMachine(physics, scene, bike, 0xd23030);
const any = bike as any;
const m = (x: number): string => (x * 100).toFixed(1) + " cm";

function settle(throttle: number, steps: number): void {
  for (let i = 0; i < steps; i++) {
    state.tick(FIXED_DT);
    bike.setInput(throttle, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
    bike.syncRender(1, FIXED_DT);
    state.syncRender(1);
  }
}

function report(label: string): void {
  const lift: THREE.Object3D = any.lift;
  lift.updateMatrixWorld(true);
  const character = (state as any).model.character;
  if (!character) {
    console.log(label, "-> NO CHARACTER (procedural rider)");
    return;
  }
  const world = (name: string): THREE.Vector3 => lift.localToWorld(character.boneWorld(name, new THREE.Vector3()));
  const grip = new THREE.Vector3();
  console.log(label);
  for (const [side, sign] of [["Left", 1], ["Right", -1]] as const) {
    bike.gripWorld(sign, grip);
    console.log(`  ${side.padEnd(5)} wrist to grip ${m(world(`${side}Hand`).distanceTo(grip))}  (the palm reaches ~5 cm further, so it should be about that)`);
  }
  for (const [side, sign] of [["Left", 1], ["Right", -1]] as const) {
    const peg = lift.localToWorld(new THREE.Vector3(sign * 0.26, -0.67, -0.11));
    console.log(`  ${side.padEnd(5)} ankle to peg ${m(world(`${side}Foot`).distanceTo(peg))}, ankle height above the peg ${m(world(`${side}Foot`).y - peg.y)}`);
  }
  const skinned: THREE.SkinnedMesh[] = [];
  character.holder.traverse((o: THREE.Object3D) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
  character.holder.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const mesh of skinned) {
    mesh.skeleton.update();
    mesh.computeBoundingBox();
    box.union(mesh.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  }
  const hips = world("Hips");
  const head = world("Head");
  console.log(`  hips ${hips.y.toFixed(2)} m above the road, head bone ${head.y.toFixed(2)} m; body spans y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}, z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)}, x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)} (road at y 0, chassis centre ${bike.worldPosition.y.toFixed(2)})`);
}

settle(0, 60 * 3);
report("stationary (left foot down):");
settle(1, 60 * 5);
report("riding:");

{
  const lift: THREE.Object3D = any.lift;
  const model3 = (state as any).model;
  const character = model3.character;
  const v = new THREE.Vector3();
  const f = (p: THREE.Vector3): string => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`;
  console.log("\nmodel-space joint check (riding):");
  console.log("  procedural hips", f(model3.hipCentre), "base", f(model3.base), "top", f(model3.top));
  for (const name of ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightHand", "LeftUpLeg", "LeftLeg", "LeftFoot"]) {
    console.log(`  ${name.padEnd(13)}`, f(character.boneWorld(name, v)));
  }
  console.log("  procedural left arm: root", f(model3.arms[0].pose.root), "mid", f(model3.arms[0].pose.mid), "tip", f(model3.arms[0].pose.tip));
  console.log("  procedural left leg: root", f(model3.legs[0].pose.root), "mid", f(model3.legs[0].pose.mid), "tip", f(model3.legs[0].pose.tip));
  void lift;
}

{
  const character = (state as any).model.character;
  const v = new THREE.Vector3();
  const f = (p: THREE.Vector3): string => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`;
  console.log("\nleft hand in the riding pose (model space), fingers should curl DOWN and round the bar:");
  for (const n of ["LeftHand", "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3", "LeftHandMiddle3", "LeftHandThumb3"]) console.log(`  ${n.padEnd(16)}`, f(character.boneWorld(n, v)));
  console.log("grip (model space): (0.420, 0.080, 0.240)");
}

{
  // Every pose the rider can take must give a finite, human-sized figure.
  const runner = (state as any).runner;
  const seated = (state as any).model;
  const ground = new THREE.Vector3(0, -0.96, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const check = (label: string, model: any): void => {
    const character = model.character;
    const holder: THREE.Object3D = character.holder;
    holder.updateMatrixWorld(true);
    let bad = 0;
    const v = new THREE.Vector3();
    const box = new THREE.Box3();
    const meshes: THREE.SkinnedMesh[] = [];
    holder.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
    for (const mesh of meshes) {
      mesh.skeleton.update();
      const pos = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.getIndex();
      for (let k = 0; k < (index ? index.count : pos.count); k += 7) {
        mesh.getVertexPosition(index ? index.getX(k) : k, v);
        v.applyMatrix4(mesh.matrixWorld);
        if (![v.x, v.y, v.z].every(Number.isFinite)) bad++;
        else box.expandByPoint(v);
      }
    }
    const s = box.getSize(new THREE.Vector3());
    console.log(`  ${label.padEnd(24)} ${bad ? "NON-FINITE x" + bad : "finite"}   size ${s.x.toFixed(2)} x ${s.y.toFixed(2)} x ${s.z.toFixed(2)} m   head y ${box.max.y.toFixed(2)}`);
  };
  console.log("\nevery pose:");
  seated.setStance(1, 1, 0, 0, ground, up); check("foot down", seated);
  seated.setStance(0, 1, 1, 1.0, ground, up); check("reversing", seated);
  seated.setStance(0, 1, 0, 0, ground, up); check("riding", seated);
  seated.setAttack("punch", 1, 0.2, { windup: 0.3, active: 0.1, recovery: 0.3 }); check("punching", seated);
  seated.setAttack("kick", -1, 0.3, { windup: 0.3, active: 0.1, recovery: 0.3 }); check("kicking", seated);
  seated.setAttack(null, 0, 0, { windup: 0.3, active: 0.1, recovery: 0.3 });
  for (const [label, run] of [
    ["running", () => runner.setRun(1.2, 1)],
    ["standing", () => runner.setRun(0, 0)],
    ["getting up (start)", () => runner.setGetUp(0)],
    ["getting up (end)", () => runner.setGetUp(1)],
    ["picking up bike", () => runner.setPickUp(0.5, new THREE.Vector3(0.3, 0.6, 0.5), new THREE.Vector3(-0.3, 0.6, 0.5))],
    ["hopping on", () => runner.setHop(0.5)],
  ] as const) { run(); check(label, runner); }
}

{
  const character = (state as any).model.character;
  const holder: THREE.Object3D = character.holder;
  holder.updateMatrixWorld(true);
  console.log("\nclothes (riding pose):");
  const v = new THREE.Vector3();
  holder.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.skeleton.update();
    const pos = mesh.geometry.getAttribute("position");
    const box = new THREE.Box3();
    let bad = 0;
    for (let i = 0; i < pos.count; i++) {
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      if (![v.x, v.y, v.z].every(Number.isFinite)) bad++;
      else box.expandByPoint(v);
    }
    const material = mesh.material as THREE.MeshStandardMaterial;
    console.log(`  ${(mesh.name || "body").padEnd(18)} ${String((mesh.geometry.getIndex()?.count ?? 0) / 3).padStart(6)} triangles  colour #${material.color.getHexString()}  y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}  ${bad ? "NON-FINITE" : "finite"}`);
  });
}

{
  // Stretch: how much longer each triangle's longest edge is in the riding pose than in the bind pose.
  const character = (state as any).model.character;
  const holder: THREE.Object3D = character.holder;
  holder.updateMatrixWorld(true);
  const skinned: THREE.SkinnedMesh[] = [];
  holder.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
  console.log("\ntriangle stretch, riding pose vs bind pose:");
  for (const mesh of skinned) {
    mesh.skeleton.update();
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex()!;
    const posed = Array.from({ length: pos.count }, (_, i) => mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
    const rest = Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    let worst = 0, worstAt = "", count2 = 0, count3 = 0;
    for (let t = 0; t < index.count; t += 3) {
      let e1 = 0, e0 = 0;
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const ia = index.getX(t + a), ib = index.getX(t + b);
        e1 = Math.max(e1, posed[ia].distanceTo(posed[ib]));
        e0 = Math.max(e0, rest[ia].distanceTo(rest[ib]) * 0.01);
      }
      const ratio = e1 / Math.max(e0, 1e-4);
      if (ratio > 2) count2++;
      if (ratio > 3) count3++;
      if (ratio > worst) { worst = ratio; const c = rest[index.getX(t)]; worstAt = `rest (${c.x.toFixed(0)}, ${c.y.toFixed(0)}, ${c.z.toFixed(0)}) cm, edge ${(e0 * 100).toFixed(1)} -> ${(e1 * 100).toFixed(1)} cm`; }
    }
    console.log(`  ${(mesh.name || "body").padEnd(18)} worst x${worst.toFixed(1)} at ${worstAt}; over x2: ${count2}, over x3: ${count3}`);
  }
}

{
  // Normals must be unit length and agree with the body's (the garments copy them, and shade by them).
  const character = (state as any).model.character;
  const holder: THREE.Object3D = character.holder;
  console.log("\ngarment normals:");
  holder.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.userData.garment) return;
    const n = mesh.geometry.getAttribute("normal");
    let min = 9, max = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) { const l = v.fromBufferAttribute(n, i).length(); min = Math.min(min, l); max = Math.max(max, l); }
    console.log(`  ${mesh.name.padEnd(18)} normal length ${min.toFixed(2)}..${max.toFixed(2)}`);
  });
}

{
  const helmet: THREE.Object3D = (state as any).model.characterHelmet;
  helmet.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(helmet, true);
  const size = box.getSize(new THREE.Vector3());
  console.log(`\nhelmet: ${(size.x * 100).toFixed(1)} wide x ${(size.y * 100).toFixed(1)} tall x ${(size.z * 100).toFixed(1)} deep cm (head ~18 x 24 x 21)`);
  helmet.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !Array.isArray(mesh.material)) return;
    console.log("  shell regions (triangles): " + mesh.geometry.groups.map((g, i) => `${["shell", "visor", "trim", "vent"][i]} ${g.count / 3}`).join(", "));
  });
}

{
  // A fall: the skinned figure should follow the ragdoll's bodies.
  const kph = 90;
  const bikeLocal = bike;
  void bikeLocal;
  const forward = new THREE.Vector3(0, 0, 1);
  (state as any).tmpVelocity?.copy?.(forward.clone().multiplyScalar(kph / 3.6));
  state.knockOff(new THREE.Vector3(0.5, 0.2, 0));
  const figure = (state as any).ragdollFigure;
  console.log(`\nfall (knocked off, ragdoll live): skinned figure ${figure ? "present" : "ABSENT"}`);
  const ragdoll = (state as any).ragdoll;
  const world = new THREE.Vector3();
  for (const seconds of [0.3, 1.2, 3]) {
    for (let i = 0; i < Math.round(seconds * 60) - (seconds === 0.3 ? 0 : 0); i++) {
      state.tick(FIXED_DT);
      bike.setInput(0, 0);
      bike.prePhysicsStep(FIXED_DT);
      physics.step();
      bike.postPhysicsStep();
      bike.syncRender(1, FIXED_DT);
      state.syncRender(1);
      if (seconds > 0.3 && i > 4) break;
    }
    for (let i = 0; i < 40; i++) { state.tick(FIXED_DT); physics.step(); bike.postPhysicsStep(); state.syncRender(1); }
    const near = (bone: string, body: string, local: [number, number, number]): string => {
      const pose = ragdoll.bodyPose(body);
      if (!pose) return `${body} -`;
      const target = new THREE.Vector3(...local).applyQuaternion(pose.quaternion).add(pose.position);
      figure.holder.updateMatrixWorld(true);
      const b = figure.boneWorld(bone, world);
      return `${bone.padEnd(10)} ${(b.distanceTo(target) * 100).toFixed(0).padStart(3)} cm from ${body}`;
    };
    console.log(`  t+${seconds}s  ` + [near("Hips", "pelvis", [0, 0, 0]), near("Head", "head", [0, -0.1, 0]), near("LeftHand", "foreArmLeft", [0, -0.2, 0]), near("LeftFoot", "lowerLegLeft", [0, -0.2, 0])].join("  |  "));
  }
  const holder: THREE.Object3D = figure.holder;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  holder.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.skeleton.update();
    const pos = mesh.geometry.getAttribute("position");
    const ix = mesh.geometry.getIndex();
    for (let k = 0; k < (ix ? ix.count : pos.count); k += 5) box.expandByPoint(mesh.getVertexPosition(ix ? ix.getX(k) : k, v).applyMatrix4(mesh.matrixWorld));
  });
  console.log(`  figure spans y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)} (road at y 0), ${box.getSize(new THREE.Vector3()).length().toFixed(2)} m across`);
}

{
  // What bare skin is left: only the head and neck should be.
  const character = (state as any).model.character;
  const holder: THREE.Object3D = character.holder;
  holder.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || mesh.userData.garment) return;
    const pos = mesh.geometry.getAttribute("position");
    const ix = mesh.geometry.getIndex()!;
    const bands: [number, number][] = [[140, 146], [146, 150], [150, 156], [156, 200]];
    console.log("\nbare skin left (rest pose, cm), by height:");
    for (const [lo, hi] of bands) {
      let min = 999, max = -999, n = 0;
      for (let k = 0; k < ix.count; k++) { const y = pos.getY(ix.getX(k)); if (y >= lo && y < hi) { n++; const x = Math.abs(pos.getX(ix.getX(k))); min = Math.min(min, x); max = Math.max(max, x); } }
      console.log(`  y ${lo}-${hi}: ${n ? `${n / 3} triangles, |x| up to ${max.toFixed(1)}` : "none"}`);
    }
  });
}
