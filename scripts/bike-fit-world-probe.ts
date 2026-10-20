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
 * The real model on a real bike at rest on a flat road, with its rider: does
 * everything line up in the world? Wheels on the road, hands on the grips,
 * feet on the pegs, the rider seated where a thrown ragdoll would start, and
 * the mudguard clear of the tyre.
 *
 * Run with: node scripts/run-sim.mjs bikefit
 */
const model = loadGlb(resolve("public/assets/bike.glb"));
const { factory } = makeGltfBikeVisualsFactory(model, { ...DEFAULT_BIKE_FITTING });
const physics = await PhysicsWorld.create();
const surfaces = new SurfaceRegistry();
const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
surfaces.register(
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1.0), ground),
  ROAD_SURFACE,
);
const scene = new THREE.Scene();
const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1.2, 0), new THREE.Quaternion(), 0xd23030, factory);
const rider = new RiderStateMachine(physics, scene, bike, 0xd23030);
for (let i = 0; i < 60 * 4; i++) {
  rider.tick(FIXED_DT);
  bike.setInput(0, 0);
  bike.prePhysicsStep(FIXED_DT);
  physics.step();
  bike.postPhysicsStep();
  bike.syncRender(1, FIXED_DT);
  rider.syncRender(1);
}
const any = bike as any;
const lift: THREE.Object3D = any.lift;
const model3: any = (rider as any).model;
lift.updateMatrixWorld(true);
const world = (v: THREE.Vector3): THREE.Vector3 => lift.localToWorld(v.clone());
const joints = model3.jointPositions() as Record<string, THREE.Vector3>;
const m = (x: number): string => (x * 100).toFixed(1) + " cm";

console.log(`body lift ${bike.rideLift.toFixed(3)} m; chassis centre ${bike.worldPosition.y.toFixed(3)} m above the road (y = 0)`);
for (let w = 0; w < 2; w++) {
  const wheel: THREE.Object3D = any.wheelObjects[w];
  const box = new THREE.Box3().setFromObject(wheel, true);
  console.log(`${w === 0 ? "front" : "rear "} wheel: lowest point ${m(box.min.y)} above the road, hub ${m(wheel.position.y)}, diameter ${m(box.max.y - box.min.y)}`);
}
const grip = new THREE.Vector3();
for (const [sign, name] of [[1, "left "], [-1, "right"]] as const) {
  bike.gripWorld(sign, grip);
  const hand = world(joints[sign > 0 ? "armL.end" : "armR.end"]);
  console.log(`${name} hand to its grip: ${m(hand.distanceTo(grip))}`);
}
for (const [sign, name] of [[1, "left "], [-1, "right"]] as const) {
  const foot = world(joints[sign > 0 ? "legL.end" : "legR.end"]);
  const peg = world(new THREE.Vector3(sign * 0.26, -0.67, -0.11));
  console.log(`${name} foot to its peg: ${m(foot.distanceTo(peg))}`);
}
const seat = (rider as any).seatPosition() as THREE.Vector3;
const hips = world(joints.hips);
console.log(`ragdoll spawn point (seat) to the drawn hips: ${m(seat.distanceTo(hips))}`);

// Mudguard against the front tyre, in the world.
const wheelFront: THREE.Object3D = any.wheelObjects[0];
const tyreTop = new THREE.Box3().setFromObject(wheelFront, true).max.y;
const assembly = bike.renderGroup;
let guardTop = -Infinity;
const guardBox = new THREE.Box3();
const frontZ = wheelFront.position.z;
assembly.updateMatrixWorld(true);
assembly.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh) return;
  guardBox.setFromObject(mesh, true);
  const c = guardBox.getCenter(new THREE.Vector3());
  const s = guardBox.getSize(new THREE.Vector3());
  if (Math.abs(c.z - frontZ) < 0.3 && Math.abs(c.x) < 0.1 && s.z > 0.4 && s.x < 0.2 && guardBox.max.y > tyreTop - 0.1) guardTop = Math.max(guardTop, guardBox.max.y);
});
console.log(`front tyre top ${m(tyreTop)}, mudguard top ${m(guardTop)}: the guard clears the tyre by ${m(guardTop - tyreTop)}`);
