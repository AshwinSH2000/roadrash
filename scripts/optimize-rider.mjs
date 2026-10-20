/**
 * Shrinks the rider model for the web: re-encodes its textures and drops the
 * empty animation take.
 *
 *   node scripts/optimize-rider.mjs [input.glb] [output.glb] [maxPixels]
 *
 * Defaults: source-assets/rider.original.glb -> public/assets/rider.glb at
 * 1024 px. The original (a Mixamo character exported with two 4096x4096 PNGs,
 * 43 MB) stays in source-assets/, which git ignores.
 *
 * Textures go through macOS `sips` to JPEG at quality 80. The mesh, which the
 * export leaves as 86,640 unshared vertices, is welded into an indexed mesh and
 * its attributes packed (joints as bytes, weights and normals normalised).
 * The skeleton, the weights' values and the animation are as exported.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const input = process.argv[2] ?? "source-assets/rider.original.glb";
const output = process.argv[3] ?? "public/assets/rider.glb";
const maxPixels = Number(process.argv[4] ?? 1024);

const file = readFileSync(input);
if (file.readUInt32LE(0) !== 0x46546c67) throw new Error("not a .glb file");
const jsonLength = file.readUInt32LE(12);
const gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
const binStart = 20 + jsonLength + 8;
const bin = file.subarray(binStart, binStart + file.readUInt32LE(20 + jsonLength));

const work = mkdtempSync(join(tmpdir(), "rider-"));
const imageViews = new Set();
const encoded = new Map();
gltf.images.forEach((image, index) => {
  const view = gltf.bufferViews[image.bufferView];
  imageViews.add(image.bufferView);
  const src = join(work, `in${index}.png`);
  const dst = join(work, `out${index}.jpg`);
  writeFileSync(src, bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
  execFileSync("sips", ["-Z", String(maxPixels), "-s", "format", "jpeg", "-s", "formatOptions", "80", src, "--out", dst], { stdio: "ignore" });
  encoded.set(image.bufferView, readFileSync(dst));
});


// --- Geometry: weld duplicate vertices and pack the attributes. -----------------------------
const primitive = gltf.meshes[0].primitives[0];
const sizes = { VEC2: 2, VEC3: 3, VEC4: 4 };
const read = (accessorIndex) => {
  const accessor = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[accessor.bufferView];
  const per = sizes[accessor.type];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? per * (accessor.componentType === 5126 ? 4 : 2);
  const out = new Float32Array(accessor.count * per);
  for (let i = 0; i < accessor.count; i++) {
    for (let k = 0; k < per; k++) {
      const at = start + i * stride + k * (accessor.componentType === 5126 ? 4 : 2);
      out[i * per + k] = accessor.componentType === 5126 ? bin.readFloatLE(at) : bin.readUInt16LE(at);
    }
  }
  return out;
};
const position = read(primitive.attributes.POSITION);
const joints = read(primitive.attributes.JOINTS_0);
const weights = read(primitive.attributes.WEIGHTS_0);
const normal = read(primitive.attributes.NORMAL);
const uv = read(primitive.attributes.TEXCOORD_0);
const count = position.length / 3;

const q8 = (x) => Math.max(-127, Math.min(127, Math.round(x * 127)));
const q16 = (x) => Math.max(0, Math.min(65535, Math.round(x * 65535)));
const remap = new Int32Array(count);
const seen = new Map();
const kept = [];
for (let i = 0; i < count; i++) {
  const key = [
    position[i * 3], position[i * 3 + 1], position[i * 3 + 2],
    q8(normal[i * 3]), q8(normal[i * 3 + 1]), q8(normal[i * 3 + 2]),
    uv[i * 2], uv[i * 2 + 1],
    joints[i * 4], joints[i * 4 + 1], joints[i * 4 + 2], joints[i * 4 + 3],
    q16(weights[i * 4]), q16(weights[i * 4 + 1]), q16(weights[i * 4 + 2]), q16(weights[i * 4 + 3]),
  ].join(",");
  let target = seen.get(key);
  if (target === undefined) {
    target = kept.length;
    seen.set(key, target);
    kept.push(i);
  }
  remap[i] = target;
}
const vertexCount = kept.length;
const positions = Buffer.alloc(vertexCount * 12);
const normals = Buffer.alloc(vertexCount * 4);
const uvs = Buffer.alloc(vertexCount * 8);
const jointBytes = Buffer.alloc(vertexCount * 4);
const weightWords = Buffer.alloc(vertexCount * 8);
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
kept.forEach((i, n) => {
  for (let k = 0; k < 3; k++) {
    positions.writeFloatLE(position[i * 3 + k], n * 12 + k * 4);
    normals.writeInt8(q8(normal[i * 3 + k]), n * 4 + k);
    min[k] = Math.min(min[k], position[i * 3 + k]);
    max[k] = Math.max(max[k], position[i * 3 + k]);
  }
  uvs.writeFloatLE(uv[i * 2], n * 8);
  uvs.writeFloatLE(uv[i * 2 + 1], n * 8 + 4);
  for (let k = 0; k < 4; k++) {
    jointBytes.writeUInt8(joints[i * 4 + k], n * 4 + k);
    weightWords.writeUInt16LE(q16(weights[i * 4 + k]), n * 8 + k * 2);
  }
});
// Triangles in the original order, through the weld.
const indexBuffer = Buffer.alloc(count * 4);
const wide = vertexCount > 65535;
for (let i = 0; i < count; i++) {
  if (wide) indexBuffer.writeUInt32LE(remap[i], i * 4);
  else indexBuffer.writeUInt16LE(remap[i], i * 2);
}
const indices = indexBuffer.subarray(0, count * (wide ? 4 : 2));

// New buffer views: the geometry first, then every old view that is not geometry.
const oldGeometryViews = new Set([0, 1, 2, 3, 4].map((a) => gltf.accessors[Object.values(primitive.attributes)[a]].bufferView));
const geometryData = [
  { name: "POSITION", data: positions, stride: 12, accessor: { componentType: 5126, type: "VEC3", min, max } },
  { name: "NORMAL", data: normals, stride: 4, accessor: { componentType: 5120, type: "VEC3", normalized: true } },
  { name: "TEXCOORD_0", data: uvs, stride: 8, accessor: { componentType: 5126, type: "VEC2" } },
  { name: "JOINTS_0", data: jointBytes, stride: 4, accessor: { componentType: 5121, type: "VEC4" } },
  { name: "WEIGHTS_0", data: weightWords, stride: 8, accessor: { componentType: 5123, type: "VEC4", normalized: true } },
];
const oldViews = gltf.bufferViews;
const rebuiltViews = [];
const newData = [];
const viewMap = new Map();
geometryData.forEach((g) => {
  rebuiltViews.push({ buffer: 0, byteLength: g.data.length, byteStride: g.stride, target: 34962 });
  newData.push(g.data);
});
rebuiltViews.push({ buffer: 0, byteLength: indices.length, target: 34963 });
newData.push(indices);
oldViews.forEach((view, index) => {
  if (oldGeometryViews.has(index)) return;
  viewMap.set(index, rebuiltViews.length);
  rebuiltViews.push(view);
  newData.push(imageViews.has(index) ? encoded.get(index) : bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
});
const geometryAccessorIds = Object.values(primitive.attributes);
geometryData.forEach((g, n) => {
  const id = primitive.attributes[g.name];
  gltf.accessors[id] = { bufferView: n, byteOffset: 0, count: vertexCount, ...g.accessor };
});
const indexAccessor = gltf.accessors.length;
gltf.accessors.push({ bufferView: geometryData.length, byteOffset: 0, componentType: wide ? 5125 : 5123, count, type: "SCALAR" });
primitive.indices = indexAccessor;
for (const accessor of gltf.accessors) {
  if (accessor.bufferView !== undefined && viewMap.has(accessor.bufferView) && !geometryAccessorIds.includes(gltf.accessors.indexOf(accessor)) && gltf.accessors.indexOf(accessor) !== indexAccessor) {
    accessor.bufferView = viewMap.get(accessor.bufferView);
  }
}
gltf.images.forEach((image) => (image.bufferView = viewMap.get(image.bufferView)));
gltf.bufferViews = rebuiltViews;
console.log(`mesh: ${count} vertices -> ${vertexCount} (${count / 3} triangles)`);

// Rebuild the binary chunk from the new views.
const chunks = [];
let offset = 0;
gltf.bufferViews.forEach((view, index) => {
  const data = newData[index];
  const pad = (4 - (offset % 4)) % 4;
  if (pad) chunks.push(Buffer.alloc(pad));
  offset += pad;
  view.byteOffset = offset;
  view.byteLength = data.length;
  chunks.push(data);
  offset += data.length;
});
gltf.images.forEach((image) => (image.mimeType = "image/jpeg"));
gltf.buffers[0].byteLength = offset;
// An animation with no channels is an export leftover.
gltf.animations = (gltf.animations ?? []).filter((a) => a.channels.length > 0);
if (gltf.animations.length === 0) delete gltf.animations;

const newBin = Buffer.concat(chunks);
const binPadded = Buffer.concat([newBin, Buffer.alloc((4 - (newBin.length % 4)) % 4)]);
const json = Buffer.from(JSON.stringify(gltf), "utf8");
const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);
const jsonHead = Buffer.alloc(8);
jsonHead.writeUInt32LE(jsonPadded.length, 0);
jsonHead.writeUInt32LE(0x4e4f534a, 4);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(binPadded.length, 0);
binHead.writeUInt32LE(0x004e4942, 4);
writeFileSync(output, Buffer.concat([header, jsonHead, jsonPadded, binHead, binPadded]));
rmSync(work, { recursive: true, force: true });
console.log(`${input} (${(file.length / 1e6).toFixed(1)} MB) -> ${output} (${((12 + 8 + jsonPadded.length + 8 + binPadded.length) / 1e6).toFixed(2)} MB), textures at ${maxPixels} px`);
