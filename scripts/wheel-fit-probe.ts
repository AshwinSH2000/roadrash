import * as THREE from "three";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { makeGltfBikeVisualsFactory, DEFAULT_BIKE_FITTING, REST_HUB_Y, STANDING_SUSPENSION_LENGTH } from "../src/entities/BikeVisuals";
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
 * Where do the drawn wheels sit relative to the drawn frame, front mudguard
 * and the wheels' own axes? Builds the bike visuals from the bundled model and
 * measures, in the bike's frame (+Z forward, +Y up, origin at the chassis
 * centre), with the wheels at the hubs the physics gives them.
 *
 * Run with: node scripts/run-sim.mjs wheelfit
 */
const model = loadGlb(resolve("public/assets/bike.glb"));
const { factory, report } = makeGltfBikeVisualsFactory(model, { ...DEFAULT_BIKE_FITTING });
const visuals = factory(0xd23030);
const half = DEFAULT_VEHICLE_CONFIG.chassisHalfExtents;
const wheelBase = DEFAULT_VEHICLE_CONFIG.wheelBase;
const radius = DEFAULT_VEHICLE_CONFIG.wheelRadius; // the wheels are scaled to this
const f = (v: number): string => (v >= 0 ? " " : "") + v.toFixed(3);

console.log(`body lifted ${visuals.bodyLift.toFixed(3)} m; wheels scaled x${report.wheelScale.toFixed(3)}`);
console.log(`fitted wheel radius ${radius.toFixed(3)} m (physics ${DEFAULT_VEHICLE_CONFIG.wheelRadius}), wheelbase ${wheelBase} m`);
console.log(`model fitted so its hubs sit at y = ${REST_HUB_Y.toFixed(3)} (mount ${(-half.y).toFixed(2)} minus rest length ${DEFAULT_VEHICLE_CONFIG.suspensionRestLength}); the bike's actual standing hub is at ${(-half.y - 0.31).toFixed(3)}`);

// --- 1. Is each wheel's geometry centred on its own origin (the hub it spins about)? ---------
console.log("\n1. wheel geometry against its own origin (the point it spins and steers about), wheel-local metres");
for (const [name, wheel] of [["front", visuals.wheels[0]], ["rear", visuals.wheels[1]]] as const) {
  wheel.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(wheel.matrixWorld).invert();
  const whole = new THREE.Box3();
  const rows: string[] = [];
  const v = new THREE.Vector3();
  wheel.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Vertex by vertex into the wheel's own frame: a box of a box would inflate a turned part.
    const to = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const box = new THREE.Box3();
    const pos = mesh.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(to));
    whole.union(box);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    rows.push(`     part: centre x ${f(c.x)} y ${f(c.y)} z ${f(c.z)}   size ${s.x.toFixed(3)} x ${s.y.toFixed(3)} x ${s.z.toFixed(3)}   (${pos.count} verts)`);
  });
  const c = whole.getCenter(new THREE.Vector3());
  const s = whole.getSize(new THREE.Vector3());
  console.log(`  ${name}: whole wheel centre x ${f(c.x)} y ${f(c.y)} z ${f(c.z)}   size ${s.x.toFixed(3)} (width) x ${s.y.toFixed(3)} x ${s.z.toFixed(3)}`);
  rows.forEach((r) => console.log(r));
}

// --- 2. Mudguard against the front wheel, at the two ride heights ---------------------------
visuals.body.position.y = visuals.bodyLift; // what Bike does with it
visuals.body.updateMatrixWorld(true);
const bodyPieces: { mesh: THREE.Mesh; box: THREE.Box3; steers: boolean }[] = [];
visuals.body.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh) return;
  bodyPieces.push({ mesh, box: new THREE.Box3().setFromObject(mesh), steers: !!visuals.frontAssembly?.object && isInside(mesh, visuals.frontAssembly.object) });
});
function isInside(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

for (const [label, hubY] of [["at the bike's standing hub (suspension sagged)", -half.y - STANDING_SUSPENSION_LENGTH]] as const) {
  const hubZ = wheelBase / 2;
  console.log(`\n2. front mudguard against the front wheel, ${label}: hub y ${hubY.toFixed(3)} z ${hubZ.toFixed(2)}, tyre top y ${(hubY + radius).toFixed(3)}`);
  const over = bodyPieces.filter(({ box }) => {
    const c = box.getCenter(new THREE.Vector3());
    return Math.abs(c.x) < 0.15 && Math.abs(c.z - hubZ) < 0.35 && box.max.y > hubY + radius * 0.5 && box.min.y < hubY + radius + 0.35 && box.getSize(new THREE.Vector3()).x < 0.4;
  });
  for (const { mesh, box, steers } of over) {
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    console.log(
      `   ${steers ? "turns with bars" : "fixed frame   "} centre x ${f(c.x)} z ${f(c.z - hubZ)} (from hub)  y range ${f(box.min.y)}..${f(box.max.y)}  gap to tyre top ${f(box.min.y - (hubY + radius))}  size ${s.x.toFixed(2)}x${s.y.toFixed(2)}x${s.z.toFixed(2)}  ${mesh.name}`,
    );
  }
}

// --- 3. Steering: do the wheel and the mudguard / forks turn about the same line? -----------
if (visuals.frontAssembly) {
  const assembly = visuals.frontAssembly.object;
  const axis = visuals.steeringAxis.clone().normalize();
  const hub = new THREE.Vector3(0, -half.y - STANDING_SUSPENSION_LENGTH, wheelBase / 2);
  assembly.updateMatrixWorld(true);
  const pivot = new THREE.Vector3().setFromMatrixPosition(assembly.matrixWorld);
  const toPivot = pivot.clone().sub(hub);
  const along = toPivot.dot(axis);
  const perpendicular = toPivot.clone().addScaledVector(axis, -along);
  console.log(`\\n3. steering. wheel turns about the fork axis through its hub: axis (${axis.x.toFixed(2)}, ${axis.y.toFixed(2)}, ${axis.z.toFixed(2)}) = ${(Math.acos(Math.abs(axis.y)) * 180 / Math.PI).toFixed(1)} deg off vertical`);
  console.log(`   the forks / mudguard / bars turn about the assembly origin, ${perpendicular.length().toFixed(3)} m away from that line (pivot at x ${f(pivot.x)} y ${f(pivot.y)} z ${f(pivot.z)}, hub at y ${f(hub.y)} z ${f(hub.z)})`);
  for (const deg of [10, 20, 35]) {
    const turn = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg));
    // A point on the mudguard, carried by each: about the assembly pivot, and about the hub.
    const guard = bodyPieces.find((p) => p.steers && p.box.min.y < hub.y && p.box.max.y > hub.y + 0.2 && p.box.getSize(new THREE.Vector3()).z > 0.4)!;
    const point = guard.box.getCenter(new THREE.Vector3());
    const byAssembly = pivot.clone().add(point.clone().sub(pivot).applyQuaternion(turn));
    const byWheel = hub.clone().add(point.clone().sub(hub).applyQuaternion(turn));
    const gap = byAssembly.clone().sub(byWheel);
    console.log(`   steered ${deg} deg: the mudguard ends up ${gap.length().toFixed(3)} m from where it would be if it turned with the wheel (sideways ${f(gap.x)}, fore/aft ${f(gap.z)})`);
  }
}
