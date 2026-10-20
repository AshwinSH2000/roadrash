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

/**
 * Does every part of each wheel turn with it? Rides the real bike at a steady
 * speed and follows one far-out vertex of every mesh in each wheel, in the
 * bike's own frame, reporting how fast each one goes round the axle against
 * how fast the wheel should (speed / radius).
 *
 * Run with: node scripts/run-sim.mjs wheelspin
 */
const model = loadGlb(resolve("public/assets/bike.glb"));
const { factory } = makeGltfBikeVisualsFactory(model, { ...DEFAULT_BIKE_FITTING });
const physics = await PhysicsWorld.create();
const surfaces = new SurfaceRegistry();
const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
surfaces.register(
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 1, 2000).setTranslation(0, -1, 0).setFriction(1.0), ground),
  ROAD_SURFACE,
);
const scene = new THREE.Scene();
const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1.2, -1500), new THREE.Quaternion(), 0xd23030, factory);
const rider = new RiderStateMachine(physics, scene, bike, 0xd23030);
const any = bike as any;

const target = Number(process.env.KPH ?? 60) / 3.6;
const tracked: { wheel: number; mesh: THREE.Mesh; vertex: number; last: number; total: number; label: string }[] = [];
const step = (): void => {
  rider.tick(FIXED_DT);
  bike.setInput(bike.forwardSpeed < target ? 1 : 0.15, 0);
  bike.prePhysicsStep(FIXED_DT);
  physics.step();
  bike.postPhysicsStep();
  bike.syncRender(1, FIXED_DT);
  rider.syncRender(1);
};
for (let i = 0; i < 60 * 12 && bike.forwardSpeed < target * 0.98; i++) step();
for (let i = 0; i < 60; i++) step();

/** Angle of a point about the wheel's axle, in the bike's frame (x lateral, so the wheel turns in the y-z plane). */
const angleOf = (mesh: THREE.Mesh, vertex: number, wheelIndex: number): number => {
  const wheel: THREE.Object3D = any.wheelObjects[wheelIndex];
  wheel.updateMatrixWorld(true);
  const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), vertex).applyMatrix4(mesh.matrixWorld);
  const bikeQ = bike.renderGroup.quaternion.clone().invert();
  p.sub(wheel.position).applyQuaternion(bikeQ);
  return Math.atan2(p.y, p.z);
};

for (let w = 0; w < 2; w++) {
  const wheel: THREE.Object3D = any.wheelObjects[w];
  wheel.updateMatrixWorld(true);
  wheel.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    // The vertex farthest from the hub: it moves the most, so it shows the turn best.
    let best = 0;
    let bestD = -1;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const d = v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).sub(wheel.position).length();
      if (d > bestD) { bestD = d; best = i; }
    }
    tracked.push({ wheel: w, mesh, vertex: best, last: angleOf(mesh, best, w), total: 0, label: `${pos.count} verts, reaches ${bestD.toFixed(3)} m` });
  });
}

const frames = 60;
let wheelSpin0 = [any.currWheelSpin[0], any.currWheelSpin[1]];
const speeds: number[] = [];
for (let i = 0; i < frames; i++) {
  step();
  speeds.push(bike.forwardSpeed);
  for (const t of tracked) {
    const a = angleOf(t.mesh, t.vertex, t.wheel);
    let d = a - t.last;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    t.total += d;
    t.last = a;
  }
}
const speed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
const expected = speed / 0.35;
console.log(`speed ${(speed * 3.6).toFixed(0)} km/h: a wheel should turn ${expected.toFixed(1)} rad/s (${(expected / (2 * Math.PI)).toFixed(1)} rev/s)`);
console.log(`the physics reports the wheels have turned ${((any.currWheelSpin[0] - wheelSpin0[0]) / (frames * FIXED_DT)).toFixed(1)} rad/s (front), ${((any.currWheelSpin[1] - wheelSpin0[1]) / (frames * FIXED_DT)).toFixed(1)} rad/s (rear)`);
for (const t of tracked) {
  const rate = t.total / (frames * FIXED_DT);
  console.log(`  ${t.wheel === 0 ? "front" : "rear "} ${t.label.padEnd(34)} turns at ${rate.toFixed(1).padStart(7)} rad/s (${((rate / expected) * 100).toFixed(0)}% of the wheel's)`);
}

// Anything of the frame left standing inside a wheel's disc would sit still in a spinning wheel.
{
  const half = DEFAULT_VEHICLE_CONFIG.chassisHalfExtents;
  const hubs = [new THREE.Vector3(0, -half.y - 0.312, DEFAULT_VEHICLE_CONFIG.wheelBase / 2), new THREE.Vector3(0, -half.y - 0.312, -DEFAULT_VEHICLE_CONFIG.wheelBase / 2)];
  bike.renderGroup.updateMatrixWorld(true);
  const lift = (bike as any).lift as THREE.Object3D;
  const v = new THREE.Vector3();
  const counts = [0, 0];
  lift.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      // Into the bike's own frame (chassis centre), as the hubs are.
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      v.sub(bike.renderGroup.position).applyQuaternion(bike.renderGroup.quaternion.clone().invert());
      for (let w = 0; w < 2; w++) {
        const d = v.clone().sub(hubs[w]);
        if (Math.hypot(d.y, d.z) < 0.3 && Math.abs(d.x) < 0.08) counts[w]++;
      }
    }
  });
  console.log(`vertices of the frame inside the front / rear wheel's disc (they stay still): ${counts[0]} / ${counts[1]}`);
}
