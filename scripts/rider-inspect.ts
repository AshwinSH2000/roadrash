/**
 * Headless look inside a rider download, before the game tries to use it.
 *
 *   npm run check:rider                 # everything under public/assets/rider/
 *   npm run check:rider path/to/file.fbx
 *
 * Reports the skeleton (bone names, whether they are Mixamo's), the skinned
 * meshes, the model's height and the animation clips with their durations —
 * everything the rider code needs to know to wire a character up. Mixamo
 * files are FBX; .glb is accepted too.
 */
import * as THREE from "three";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, extname, basename } from "node:path";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// FBXLoader hands embedded textures to the DOM image pipeline, which Node
// lacks. The geometry, skeleton and clips are all we need here, so image
// loading is turned into a no-op rather than a crash.
const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => url);
THREE.ImageLoader.prototype.load = function (_url, onLoad) {
  onLoad?.(undefined as unknown as HTMLImageElement);
  return undefined as unknown as HTMLImageElement;
} as typeof THREE.ImageLoader.prototype.load;

async function load(path: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (extname(path).toLowerCase() === ".fbx") {
    const group = new FBXLoader(manager).parse(buffer, "");
    return { scene: group, animations: group.animations };
  }
  const gltf = await new GLTFLoader(manager).parseAsync(buffer, "");
  return { scene: gltf.scene, animations: gltf.animations };
}

function describe(path: string, asset: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }): void {
  const bones: THREE.Bone[] = [];
  const skinned: THREE.SkinnedMesh[] = [];
  let triangles = 0;
  asset.scene.traverse((node) => {
    if ((node as THREE.Bone).isBone) bones.push(node as THREE.Bone);
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(node as THREE.SkinnedMesh);
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      const index = mesh.geometry.getIndex();
      triangles += (index ? index.count : mesh.geometry.getAttribute("position").count) / 3;
    }
  });

  asset.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(asset.scene, true);
  const size = box.getSize(new THREE.Vector3());

  console.log(`\n${basename(path)}`);
  console.log(`  size          ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} units (height ${size.y.toFixed(1)} — Mixamo exports in cm, so ~180 is a 1.8 m person)`);
  console.log(`  triangles     ${Math.round(triangles).toLocaleString()} in ${skinned.length} skinned mesh(es)`);

  const mixamo = bones.filter((b) => b.name.startsWith("mixamorig")).length;
  console.log(`  bones         ${bones.length}${bones.length ? ` (${mixamo} Mixamo-named)` : ""}`);
  const wanted = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm", "LeftUpLeg", "LeftLeg", "RightUpLeg", "RightLeg"];
  const missing = wanted.filter((w) => !bones.some((b) => b.name === `mixamorig${w}` || b.name === w));
  if (bones.length) console.log(`  key bones     ${missing.length === 0 ? "all present" : `MISSING: ${missing.join(", ")}`}`);

  if (asset.animations.length === 0) {
    console.log(`  animations    none`);
  }
  for (const clip of asset.animations) {
    const tracks = clip.tracks.length;
    console.log(`  clip          "${clip.name}"  ${clip.duration.toFixed(2)} s, ${tracks} tracks`);
  }
}

const target = process.argv[3];
const files: string[] = [];
if (target) {
  files.push(resolve(target));
} else {
  const dir = resolve("public/assets/rider");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if ([".fbx", ".glb"].includes(extname(name).toLowerCase())) files.push(join(dir, name));
    }
  }
}

if (files.length === 0) {
  console.log(`No rider files under public/assets/rider/ yet. To get them (free, from Mixamo):

  1. Sign in at https://www.mixamo.com/
  2. Characters tab -> pick one -> Download: FBX Binary, T-pose, With Skin
       save as  public/assets/rider/rider.fbx
  3. Animations tab -> search "Driving" -> apply -> Download: FBX Binary, Without Skin, 30 fps
       save as  public/assets/rider/ride.fbx
  4. Same for: idle.fbx (Idle), getup.fbx (Getting Up), run.fbx (Running),
               punch.fbx (Punching), kick.fbx (Kicking)
  5. Run this command again.

  rider.fbx + ride.fbx are enough to start. Full checklist: TODO.md`);
  process.exit(0);
}

let failures = 0;
for (const file of files) {
  try {
    describe(file, await load(file));
  } catch (error) {
    failures++;
    console.log(`\n${basename(file)}\n  FAILED to parse: ${String(error)}`);
  }
}
console.log(failures ? `\nWARN  ${failures} file(s) could not be read.` : `\nOK  ${files.length} file(s) readable.`);
process.exit(failures ? 1 : 0);
