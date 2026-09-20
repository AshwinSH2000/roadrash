/**
 * Headless check of a bike model against the physics bike, without a browser.
 *
 *   npm run check:bike            # public/assets/bike.glb
 *   npm run check:bike path.glb
 *
 * Reports how the wheels were found, what the model measures, and how far the
 * fitted result sits from what the vehicle physics expects — so a candidate
 * model can be rejected or accepted before it is ever loaded in the game.
 *
 * The GLB is decoded here rather than with GLTFLoader because that loader
 * pulls in textures through DOM image APIs that don't exist in Node. Only
 * geometry and the node hierarchy are needed to test the fit, and those are
 * plain buffer reads.
 */
import * as THREE from "three";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  makeGltfBikeVisualsFactory,
  DEFAULT_BIKE_FITTING,
  REST_HUB_Y,
} from "../src/entities/BikeVisuals";
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

// argv[2] is the selector consumed by run-sim.mjs ("fit"), so the optional
// model path is the one after it.
const path = resolve(process.argv[3] ?? "public/assets/bike.glb");
if (!existsSync(path)) {
  console.log(`No model at ${path} — the game will use the placeholder boxes.`);
  process.exit(0);
}

const model = loadGlb(path);
const { factory, report } = makeGltfBikeVisualsFactory(model, { ...DEFAULT_BIKE_FITTING });

const triangleCount = (root: THREE.Object3D): number => {
  let n = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const index = mesh.geometry.getIndex();
    n += (index ? index.count : mesh.geometry.getAttribute("position").count) / 3;
  });
  return n;
};

console.log(`model            ${path}`);
console.log(`total triangles  ${Math.round(triangleCount(model)).toLocaleString()}`);
console.log(`wheels found by  ${report.strategy}`);
if (report.strategy === "auto-split") {
  console.log(`  split meshes   ${report.splitMeshes?.join(", ")}`);
  console.log(`  wheel tris     ${report.splitTriangles?.toLocaleString()}`);
  if (report.spinRejected?.length) {
    console.log(`  kept on body   ${report.spinRejected.join(", ")} (inside the wheel disc, but not wrapped around the hub)`);
  }
  const pose = (deg?: number): string => (deg ?? 0) < 0.5 ? "straight" : `posed ${deg!.toFixed(1)} deg off-axis, straightened`;
  console.log(`  front wheel    ${pose(report.frontPoseDeg)}`);
  console.log(`  rear wheel     ${pose(report.rearPoseDeg)}`);
  if (report.steering) {
    const st = report.steering;
    console.log(
      `  steering       fork axis raked ${st.rakeDeg.toFixed(1)} deg; front end was posed ` +
        `${Math.abs(st.posedTurnDeg).toFixed(1)} deg turned, straightened and re-centred by ` +
        `${(st.lateralCorrection * 1000).toFixed(0)} mm; ` +
        `${st.parts} parts / ${st.triangles.toLocaleString()} tris turn with the bars`,
    );
    if (process.env.BIKE_FIT_VERBOSE) {
      const row = (d: (typeof st.detail)[number]): string => {
        const f = (n: number): string => n.toFixed(2).padStart(6);
        return `${d.steers ? "steer" : "frame"}  ${d.name.padEnd(10)} ${String(d.triangles).padStart(5)}  ` +
          `x ${f(d.min.x)}..${f(d.max.x)}  y ${f(d.min.y)}..${f(d.max.y)}  z ${f(d.min.z)}..${f(d.max.z)}  ` +
          `size ${(d.max.x - d.min.x).toFixed(2)}x${(d.max.y - d.min.y).toFixed(2)}x${(d.max.z - d.min.z).toFixed(2)}`;
      };
      console.log(`\n  --- parts left on the frame (un-posed root space) ---`);
      for (const d of st.detail.filter((d) => !d.steers).sort((a, b) => b.triangles - a.triangles)) console.log("  " + row(d));
      console.log(`\n  --- steering parts, widest first ---`);
      for (const d of st.detail.filter((d) => d.steers).sort((a, b) => (b.max.x - b.min.x) - (a.max.x - a.min.x)).slice(0, 25)) console.log("  " + row(d));
      console.log(`\n  --- steering parts, most +x (left) first ---`);
      for (const d of st.detail.filter((d) => d.steers).sort((a, b) => b.max.x - a.max.x).slice(0, 8)) console.log("  " + row(d));
      console.log(`\n  --- steering parts, most -x (right) first ---`);
      for (const d of st.detail.filter((d) => d.steers).sort((a, b) => a.min.x - b.min.x).slice(0, 8)) console.log("  " + row(d));
    }
    if (st.frameParts > 0) {
      console.log(`                 ${st.frameParts} nearby part(s) left on the frame — symmetric before un-posing, so not part of the turned front end`);
    }
  } else {
    console.log(`  steering       fork tubes not found — bars and forks stay fixed to the frame`);
  }
}
console.log(`wheelbase        ${report.measuredWheelBase.toFixed(3)} model units -> scaled x${report.autoScale.toFixed(4)}`);
console.log(`heading          ${report.headingDeg.toFixed(1)} deg, corrected to +Z`);

const radiusError = Math.abs(report.fittedWheelRadius - report.expectedWheelRadius) / report.expectedWheelRadius;
console.log(
  `wheel radius     ${report.fittedWheelRadius.toFixed(3)} m fitted vs ` +
    `${report.expectedWheelRadius.toFixed(3)} m in physics (${(radiusError * 100).toFixed(1)}% off)`,
);

// Build one instance and measure it, which is what the game will actually draw.
const visuals = factory(0x2266dd);
// `precise` walks the vertices; the default transforms child bounding boxes,
// which balloons for a group carrying a rotation — the straightened front
// assembly reported the body 50% wider than it is before this was set.
const bodyBox = new THREE.Box3().setFromObject(visuals.body, true);
const size = bodyBox.getSize(new THREE.Vector3());
console.log(
  `\nfitted body      ${size.x.toFixed(2)} wide x ${size.y.toFixed(2)} tall x ${size.z.toFixed(2)} long (metres)`,
);

// The wheels are placed in world space by Bike; at rest they sit at REST_HUB_Y
// under the chassis origin, one wheelbase apart.
// `precise` walks the vertices; the default transforms a bounding box, which
// balloons the moment a straightened wheel carries a rotation.
const wheelBox = new THREE.Box3().setFromObject(visuals.wheels[0], true);
const wheelSize = wheelBox.getSize(new THREE.Vector3());
console.log(`front wheel      ${wheelSize.x.toFixed(2)} wide x ${wheelSize.y.toFixed(2)} tall x ${wheelSize.z.toFixed(2)} long about its hub`);

if (visuals.frontAssembly) {
  const box = new THREE.Box3().setFromObject(visuals.frontAssembly.object, true);
  const c = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  console.log(`front assembly   ${sz.x.toFixed(2)} wide, centred ${(c.x * 100).toFixed(1)} cm off the midplane (+ is the bike's left)`);
}

const problems: string[] = [];
if (visuals.frontAssembly) {
  const c = new THREE.Box3().setFromObject(visuals.frontAssembly.object, true).getCenter(new THREE.Vector3());
  if (Math.abs(c.x) > 0.05) {
    problems.push(`Steering assembly is ${(Math.abs(c.x) * 100).toFixed(0)} cm off the bike's midplane.`);
  }
}
if (radiusError > 0.25) {
  problems.push(
    `Wheel radius is ${(radiusError * 100).toFixed(0)}% off the physics value. The bike will look ` +
      `like it is floating or sunk; adjust wheelRadius in DEFAULT_VEHICLE_CONFIG or pick another model.`,
  );
}
if (size.y > 3 || size.y < 0.6) {
  problems.push(`Fitted height ${size.y.toFixed(2)} m is not bike-shaped — check the model's proportions.`);
}
// A wheel is a disc: thin along its axle, round in the other two. If it is not,
// it was not straightened or the axle fit picked the wrong axis.
const diameter = Math.max(wheelSize.y, wheelSize.z);
if (wheelSize.x > diameter * 0.5) {
  problems.push(
    `Front wheel is ${wheelSize.x.toFixed(2)} m wide against a ${diameter.toFixed(2)} m diameter — ` +
      `it is still turned or tilted, not sitting flat on its axle.`,
  );
}
if (Math.min(wheelSize.y, wheelSize.z) / diameter < 0.9) {
  problems.push(`Front wheel is ${wheelSize.y.toFixed(2)} tall by ${wheelSize.z.toFixed(2)} long — not round.`);
}
if (report.steering) {
  const share = report.steering.triangles / triangleCount(model);
  if (share > 0.6) {
    problems.push(`${(share * 100).toFixed(0)}% of the model would turn with the bars — the steering assembly has swallowed the frame.`);
  }
  if (report.steering.rakeDeg > 45) {
    problems.push(`Fork rake of ${report.steering.rakeDeg.toFixed(0)} deg is not a motorcycle's — the wrong parts were taken for fork tubes.`);
  }
}
if (report.strategy === "auto-split" && (report.splitTriangles ?? 0) < 200) {
  problems.push(`Only ${report.splitTriangles} triangles were identified as wheels; they may render as slivers.`);
}

// Bodywork must not hang below the tyres, or the bike will appear to plough
// through the road surface.
const lowestBody = bodyBox.min.y;
const tyreBottom = REST_HUB_Y - DEFAULT_VEHICLE_CONFIG.wheelRadius;
console.log(
  `\nground clearance ${(lowestBody - tyreBottom).toFixed(3)} m ` +
    `(lowest bodywork at ${lowestBody.toFixed(3)}, tyre contact at ${tyreBottom.toFixed(3)})`,
);
if (lowestBody < tyreBottom - 0.02) {
  problems.push(`Bodywork hangs ${(tyreBottom - lowestBody).toFixed(3)} m below the tyres — nudge "shift up/down".`);
}

if (problems.length) {
  console.log(`\nWARN  the model loads, but:`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`\nPASS  model fits the physics bike.`);
