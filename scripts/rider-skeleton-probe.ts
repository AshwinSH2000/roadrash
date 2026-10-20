import * as THREE from "three";
import { readFileSync } from "node:fs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Loads rider.glb in Node, with its (browser-only) textures stripped out: geometry, skin and animation are what matter here. */
export async function loadRiderForTest(path = "public/assets/rider.glb"): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const file = readFileSync(path);
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const material of json.materials ?? []) {
    delete material.normalTexture;
    if (material.pbrMetallicRoughness) delete material.pbrMetallicRoughness.baseColorTexture;
  }
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = file.subarray(20 + jsonLength + 8);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonPadded.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  const all = Buffer.concat([head, jh, jsonPadded, bh, bin]);
  const buffer = all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  return { scene: gltf.scene, animations: gltf.animations };
}

if (process.argv[2] === "skeleton" || process.env.RUN_SKELETON) {
  const { scene, animations } = await loadRiderForTest();
  scene.updateMatrixWorld(true);
  let skinned: THREE.SkinnedMesh | null = null;
  scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = o as THREE.SkinnedMesh; });
  const mesh = skinned as unknown as THREE.SkinnedMesh;
  console.log("skinned mesh:", mesh.name, mesh.geometry.getAttribute("position").count, "vertices,", (mesh.geometry.getIndex()?.count ?? 0) / 3, "triangles, bones", mesh.skeleton.bones.length);
  console.log("animations:", animations.map((a) => `${a.name} ${a.duration.toFixed(2)}s ${a.tracks.length} tracks`).join(", "));
  const v = new THREE.Vector3();
  for (const bone of mesh.skeleton.bones) {
    bone.getWorldPosition(v);
    const parent = bone.parent as THREE.Bone;
    const len = parent?.isBone ? parent.getWorldPosition(new THREE.Vector3()).distanceTo(v) : 0;
    console.log(`  ${bone.name.replace("mixamorig1", "").padEnd(22)} world (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})  length from parent ${len.toFixed(3)}`);
  }
}
