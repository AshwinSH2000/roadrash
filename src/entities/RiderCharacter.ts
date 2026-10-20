import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

/**
 * A skinned human (the Mixamo mannequin in `public/assets/rider.glb`) driven by
 * the procedural rider's pose.
 *
 * `RiderModel` already works out every pose the rider can take — riding, foot
 * down, reversing, running, getting up, picking up the bike — as joint
 * positions in the bike's frame. This class makes the skinned figure take those
 * same poses: the spine is bent to the torso line, the head is turned, and each
 * arm and leg is solved with its own bone lengths to the same hand and foot
 * targets, then every bone is aimed along its solved segment. So nothing about
 * the poses is written twice.
 *
 * The maths is done in the model's own space (metres, the bike's frame) and
 * written back as local bone rotations; the scene graph is only used to draw.
 */

/** One arm or leg as the procedural rider solved it: where it starts, bends and ends. */
export interface LimbPose {
  root: THREE.Vector3;
  mid: THREE.Vector3;
  tip: THREE.Vector3;
  /** Unit direction of the lower segment, mid -> tip. */
  forward: THREE.Vector3;
}

/** Everything the figure needs from the pose solver, all in the model's space. */
export interface RiderPose {
  hips: THREE.Vector3;
  spineBase: THREE.Vector3;
  spineTop: THREE.Vector3;
  /** Roll of the chest about its own length, radians. */
  twist: number;
  /** How far the head is turned about the vertical, radians (+ to the rider's left). */
  headYaw: number;
  /** Index 0 = rider's left (+X), 1 = right. */
  arms: [LimbPose, LimbPose];
  legs: [LimbPose, LimbPose];
  /** 0 = open hand, 1 = fist, per arm. */
  curl: [number, number];
}

export function createLimbPose(): LimbPose {
  return { root: new THREE.Vector3(), mid: new THREE.Vector3(), tip: new THREE.Vector3(), forward: new THREE.Vector3(0, -1, 0) };
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** Distance from the wrist bone to the middle of the gripping hand, metres. */
const PALM_OFFSET = 0.08;
/** The figure sits this far forward of the pose's hips, metres: its arms are a little short for the bars. */
const HIPS_FORWARD = 0.045;
/** The ankle bone sits this far above the sole and the foot is placed relative to the solved ankle: sole below the target, as the procedural shoe is. */
const ANKLE_ABOVE_TARGET = 0.023;
/** The head looks a little down from level when upright, radians. */
const HEAD_PITCH = 0.08;
/**
 * Share of the torso's lean taken by the pelvis and each spine bone, bottom to
 * top. Each bone points the next one along, so these set the curve of the back;
 * averaged over the bones' lengths they come to 1, so the neck lands where the
 * torso line puts it. (Thirds would leave the whole chain leaning a third short.)
 */
const PELVIS_SHARE = 0.6;
const SPINE_SHARE = [0.9, 1.1, 1.2] as const;

const FINGER_CHAINS = ["Index", "Middle", "Ring", "Pinky"] as const;

interface BoneData {
  bone: THREE.Bone;
  parent: BoneData | null;
  /** Rest pose: local rotation, local position in model metres, and the same in the model's space. */
  restLocalQuat: THREE.Quaternion;
  restLocalPos: THREE.Vector3;
  restWorldQuat: THREE.Quaternion;
  restWorldPos: THREE.Vector3;
  /** Posed this frame, in the model's space. */
  worldQuat: THREE.Quaternion;
  worldPos: THREE.Vector3;
  children: BoneData[];
}

/** What the figure wears; each piece is cut from the body mesh and given its own material per rider. */
type Garment = "jacket" | "trim" | "trousers" | "gloves" | "boots" | "soles";

/**
 * The mannequin is bare, so its clothes are made from it: each garment is the
 * part of the body mesh in some region of the T-pose (coordinates in the model's
 * own centimetres), reshaped so it hangs the way cloth does rather than hugging
 * the skin, then smoothed. They share the body's skeleton and skin weights, so
 * they bend with it, and their geometry is built once and shared by every rider;
 * only the materials (the jacket's colour) are per rider.
 *
 * Regions, from the Mixamo T-pose (hips 99.8 cm, neck base 148, wrists at
 * |x| = 67): jacket from just under the hips to the collar and out to the
 * wrists; gloves from the wrists; trousers from the jacket's hem to the ankles;
 * boots from the ankle down.
 */
const GARMENTS: { garment: Garment; test: (x: number, y: number) => boolean }[] = [
  // Trim first: a triangle goes to the first garment that claims it.
  { garment: "soles", test: (_x, y) => y < 2.5 },
  { garment: "trim", test: (x, y) => Math.abs(x) <= 20 && y >= 128 && y <= 134 },
  { garment: "trim", test: (x, y) => Math.abs(x) > 56 && Math.abs(x) <= 66 && y >= 125 },
  { garment: "trim", test: (x, y) => Math.abs(x) <= 14 && y >= 142.5 && y <= 146.5 },
  { garment: "gloves", test: (x) => Math.abs(x) > 66 },
  { garment: "boots", test: (_x, y) => y < 16 },
  // A stand-up collar covers the neck (|x| < 9) to just under the helmet; out from it the jacket carries on up over the shoulders.
  { garment: "jacket", test: (x, y) => (Math.abs(x) <= 20 ? y >= 88 && y <= (Math.abs(x) < 9 ? 152 : 156) : Math.abs(x) <= 66 && y >= 124 && y <= 156) },
  { garment: "trousers", test: (x, y) => Math.abs(x) <= 30 && y >= 16 && y < 100 },
];

/**
 * Cell sizes, cm, for thinning each garment by vertex clustering: close up
 * (hands go from every finger to a rounded glove, cloth is thinned lightly)
 * and far away (a few thousand triangles for the whole rider).
 */
const DETAIL_CELL: Record<"near" | "far", Record<Garment, number>> = {
  near: { jacket: 1.5, trim: 1.5, trousers: 1.5, gloves: 1.3, boots: 1.4, soles: 1.6 },
  far: { jacket: 4.5, trim: 4.5, trousers: 4.5, gloves: 3.5, boots: 3.5, soles: 4 },
};

/**
 * Thins a mesh by clustering: vertices that fall in the same grid cell become
 * one, at their average, standing for the skin weights of whichever member is
 * nearest that average; triangles that collapse are dropped. Vertices on an
 * open edge keep their place, so neighbouring garments still meet exactly.
 */
function thin(
  points: THREE.Vector3[],
  indices: number[],
  pinned: Uint8Array,
  cell: number,
  skin: { index: Uint16Array; weight: Float32Array },
): { points: THREE.Vector3[]; indices: number[]; skinIndex: Uint16Array; skinWeight: Float32Array } {
  const cluster = new Int32Array(points.length);
  const members: number[][] = [];
  const byCell = new Map<string, number>();
  points.forEach((p, n) => {
    if (pinned[n] || cell <= 0) {
      cluster[n] = members.length;
      members.push([n]);
      return;
    }
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;
    let id = byCell.get(key);
    if (id === undefined) {
      id = members.length;
      byCell.set(key, id);
      members.push([]);
    }
    cluster[n] = id;
    members[id].push(n);
  });

  const outPoints: THREE.Vector3[] = [];
  const skinIndex = new Uint16Array(members.length * 4);
  const skinWeight = new Float32Array(members.length * 4);
  members.forEach((group, g) => {
    const centre = new THREE.Vector3();
    group.forEach((n) => centre.add(points[n]));
    centre.multiplyScalar(1 / group.length);
    outPoints.push(group.length === 1 ? points[group[0]].clone() : centre);
    // The merged vertex moves with all of its members: their weights per bone, averaged, the four strongest kept.
    const blend = new Map<number, number>();
    for (const n of group) {
      for (let k = 0; k < 4; k++) {
        const w = skin.weight[n * 4 + k];
        if (w > 0) blend.set(skin.index[n * 4 + k], (blend.get(skin.index[n * 4 + k]) ?? 0) + w / group.length);
      }
    }
    const top = [...blend.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((total, [, w]) => total + w, 0) || 1;
    top.forEach(([bone, w], k) => {
      skinIndex[g * 4 + k] = bone;
      skinWeight[g * 4 + k] = w / sum;
    });
  });
  const outIndices: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < indices.length; t += 3) {
    const a = cluster[indices[t]];
    const b = cluster[indices[t + 1]];
    const c = cluster[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    outIndices.push(a, b, c);
  }
  return { points: outPoints, indices: outIndices, skinIndex, skinWeight };
}

/** How far (cm) gloves, boots and soles stand off the skin: they are fitted, not loose. */
const FITTED_OFFSET: Partial<Record<Garment, number>> = { gloves: 1.5, boots: 2.3, soles: 2.6 };
/** Smoothing passes over a loose garment, to lose the muscle and tendon detail it was cut from. */
const SMOOTHING_PASSES = 6;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** A chain of joints, cm. */
class Axis {
  constructor(private readonly points: THREE.Vector3[]) {}

  /** Closest point on the chain to `p`, and how far along it (0..1 over its whole length). */
  nearest(p: THREE.Vector3, out: THREE.Vector3): number {
    let best = Infinity;
    let along = 0;
    let travelled = 0;
    const total = this.points.slice(1).reduce((sum, q, i) => sum + q.distanceTo(this.points[i]), 0);
    const ab = new THREE.Vector3();
    const ap = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1];
      ab.subVectors(this.points[i], a);
      const length = ab.length();
      const t = THREE.MathUtils.clamp(ap.subVectors(p, a).dot(ab) / Math.max(length * length, 1e-9), 0, 1);
      q.copy(a).addScaledVector(ab, t);
      const d = q.distanceToSquared(p);
      if (d < best) {
        best = d;
        out.copy(q);
        along = (travelled + t * length) / total;
      }
      travelled += length;
    }
    return along;
  }
}

/**
 * Makes the cut-out cloth hang loose: each point is pushed away from the
 * bone line it sits round, by a factor that grows where the garment flares
 * (the jacket's hem, the trousers' ankles, the cuffs).
 */
function makeShaper(source: THREE.SkinnedMesh, garment: Garment): ((p: THREE.Vector3) => void) | null {
  if (garment !== "jacket" && garment !== "trim" && garment !== "trousers") return null;
  const bone = (name: string): THREE.Vector3 => {
    const b = source.skeleton.bones.find((x) => x.name.replace(/^mixamorig\d*:?/, "") === name);
    if (!b) throw new Error(`missing bone ${name}`);
    return b.getWorldPosition(new THREE.Vector3()).multiplyScalar(100);
  };
  const spine = new Axis([bone("Hips"), bone("Spine"), bone("Spine1"), bone("Spine2"), bone("Neck")]);
  const arms = [1, -1].map((sign) => {
    const side = sign > 0 ? "Left" : "Right";
    return new Axis([bone(`${side}Arm`), bone(`${side}ForeArm`), bone(`${side}Hand`)]);
  });
  const legs = [1, -1].map((sign) => {
    const side = sign > 0 ? "Left" : "Right";
    return new Axis([bone(`${side}UpLeg`), bone(`${side}Leg`), bone(`${side}Foot`)]);
  });
  const c = new THREE.Vector3();
  const torso = new THREE.Vector3();
  const sleeve = new THREE.Vector3();

  return (p) => {
    if (garment === "trousers") {
      const axis = legs[p.x >= 0 ? 0 : 1];
      const t = axis.nearest(p, c);
      // Thigh, knee, calf, then flaring over the boot top.
      const k = 1.15 + 0.03 * smoothstep(0.35, 0.55, t) + 0.17 * smoothstep(0.7, 1, t);
      const r = p.clone().sub(c);
      p.copy(c).addScaledVector(r, k);
      return;
    }
    // Jacket and trim: the body of the jacket round the spine, the sleeves round the arms, blended across the shoulder.
    const armSide = p.x >= 0 ? 0 : 1;
    spine.nearest(p, c);
    torso.copy(p);
    const rt = torso.clone().sub(c);
    // Chest, waist and a flared hem.
    const kt = 1.15 + 0.05 * smoothstep(125, 108, p.y) + 0.07 * smoothstep(104, 90, p.y);
    torso.copy(c).addScaledVector(rt, kt);

    const t = arms[armSide].nearest(p, c);
    const rs = p.clone().sub(c);
    const ks = 1.3 + 0.06 * smoothstep(0.7, 1, t);
    sleeve.copy(c).addScaledVector(rs, ks);

    const blend = smoothstep(14, 26, Math.abs(p.x));
    p.lerpVectors(torso, sleeve, blend);
  };
}

function cutGarments(root: THREE.Object3D): void {
  let body: THREE.SkinnedMesh | null = null;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !body) body = o as THREE.SkinnedMesh;
  });
  const source = body as THREE.SkinnedMesh | null;
  if (!source || !source.geometry.getIndex()) return;
  const geometry = source.geometry;
  const index = geometry.getIndex()!;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");

  const triangles = new Map<Garment, number[]>();
  /** Triangles no garment covers (the head and neck): all the bare body that is left to draw. */
  const bare: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(position, index.getX(t));
    b.fromBufferAttribute(position, index.getX(t + 1));
    c.fromBufferAttribute(position, index.getX(t + 2));
    const x = (a.x + b.x + c.x) / 3;
    const y = (a.y + b.y + c.y) / 3;
    const rule = GARMENTS.find((r) => r.test(x, y));
    if (!rule) {
      bare.push(index.getX(t), index.getX(t + 1), index.getX(t + 2));
      continue;
    }
    const list = triangles.get(rule.garment) ?? [];
    list.push(index.getX(t), index.getX(t + 1), index.getX(t + 2));
    triangles.set(rule.garment, list);
  }

  for (const [garment, list] of triangles) {
    // Weld by position: the file splits vertices along texture and normal seams, but cloth is smooth across them
    // (and the pieces of a seam share their skin weights, so nothing is lost).
    const ids = new Map<string, number>();
    const originals: number[] = [];
    const indices: number[] = [];
    for (const v of list) {
      const key = `${Math.round(position.getX(v) * 100)},${Math.round(position.getY(v) * 100)},${Math.round(position.getZ(v) * 100)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = originals.length;
        ids.set(key, id);
        originals.push(v);
      }
      indices.push(id);
    }
    const count = originals.length;
    const points = originals.map((v) => new THREE.Vector3(position.getX(v), position.getY(v), position.getZ(v)));

    // Fitted pieces (gloves, boots) stand a little off the skin along the surface; loose ones are reshaped round the bones.
    const fitted = FITTED_OFFSET[garment];
    if (fitted !== undefined) {
      originals.forEach((v, n) => {
        points[n].x += normal.getX(v) * fitted;
        points[n].y += normal.getY(v) * fitted;
        points[n].z += normal.getZ(v) * fitted;
      });
    } else {
      const shape = makeShaper(source, garment);
      if (shape) points.forEach((p) => shape(p));
    }

    // Smooth the cloth, keeping its open edges (the hem, cuffs, collar) where they are so neighbouring pieces still meet.
    const edgeUses = new Map<string, number>();
    for (let t = 0; t < indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const u = indices[t + k];
        const w = indices[t + ((k + 1) % 3)];
        const key = u < w ? `${u}-${w}` : `${w}-${u}`;
        edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
      }
    }
    const pinned = new Uint8Array(count);
    const neighbours: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
    for (const [key, uses] of edgeUses) {
      const [u, w] = key.split("-").map(Number);
      neighbours[u].add(w);
      neighbours[w].add(u);
      if (uses === 1) pinned[u] = pinned[w] = 1;
    }
    if (fitted === undefined) {
      const next = points.map((p) => p.clone());
      for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
        for (let n = 0; n < count; n++) {
          if (pinned[n] || neighbours[n].size === 0) continue;
          const mean = new THREE.Vector3();
          neighbours[n].forEach((m) => mean.add(points[m]));
          mean.multiplyScalar(1 / neighbours[n].size);
          next[n].lerpVectors(points[n], mean, 0.6);
        }
        for (let n = 0; n < count; n++) points[n].copy(next[n]);
      }
    }

    // Each welded vertex's own skin weights, read once.
    const ownSkinIndex = new Uint16Array(count * 4);
    const ownSkinWeight = new Float32Array(count * 4);
    originals.forEach((v, n) => {
      ownSkinIndex.set([skinIndex.getX(v), skinIndex.getY(v), skinIndex.getZ(v), skinIndex.getW(v)], n * 4);
      ownSkinWeight.set([skinWeight.getX(v), skinWeight.getY(v), skinWeight.getZ(v), skinWeight.getW(v)], n * 4);
    });

    // Two levels of detail from the same cloth: the full mesh, thinned a little, for close up, and a coarse one for riders far away.
    for (const lod of ["near", "far"] as const) {
      const cell = DETAIL_CELL[lod][garment];
      const thinned = thin(points, indices, pinned, cell, { index: ownSkinIndex, weight: ownSkinWeight });
      const total = thinned.points.length;
      const out = new THREE.BufferGeometry();
      const outPosition = new Float32Array(total * 3);
      thinned.points.forEach((p, n) => outPosition.set([p.x, p.y, p.z], n * 3));
      out.setAttribute("position", new THREE.BufferAttribute(outPosition, 3));
      out.setAttribute("skinIndex", new THREE.BufferAttribute(thinned.skinIndex, 4));
      out.setAttribute("skinWeight", new THREE.BufferAttribute(thinned.skinWeight, 4));
      out.setIndex(thinned.indices);
      // Smooth cloth shading from the reshaped surface itself, not the body's.
      out.computeVertexNormals();

      const mesh = new THREE.SkinnedMesh(out, source.material);
      mesh.name = `garment:${garment}:${lod}`;
      mesh.userData.garment = garment;
      mesh.userData.lod = lod;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.visible = lod === "near";
      mesh.bind(source.skeleton, source.bindMatrix);
      source.parent?.add(mesh);
    }
  }
  // Skin under a garment is never seen, and drawing it would double the cost of every rider.
  geometry.setIndex(bare);
}

/** The loaded model, ready to be cloned once per rider. */
export class RiderCharacterTemplate {
  constructor(readonly scene: THREE.Object3D) {
    cutGarments(scene);
  }

  instantiate(color: number): RiderCharacter {
    return new RiderCharacter(cloneSkinned(this.scene), color);
  }
}

let template: RiderCharacterTemplate | null = null;

/** Registers the loaded model for every rider made from here on. Pass null to go back to the procedural rider. */
export function setRiderCharacter(scene: THREE.Object3D | null): void {
  template = scene ? new RiderCharacterTemplate(scene) : null;
}

export function createRiderCharacter(color: number): RiderCharacter | null {
  if (!template) return null;
  try {
    return template.instantiate(color);
  } catch (error) {
    // A model that cannot be used must not stop the race: fall back to the procedural rider.
    console.error(`[assets] rider model could not be used, keeping the procedural rider.\n${String(error)}`);
    template = null;
    return null;
  }
}

export class RiderCharacter {
  /** Add this to the rider's object; the figure's own origin is the model's origin. */
  readonly holder = new THREE.Group();

  private readonly bones = new Map<string, BoneData>();
  private readonly order: BoneData[] = [];
  private readonly hips: BoneData;
  private readonly hipsParentInverse = new THREE.Matrix4();
  /** Rest world axis fingers curl about, per side: toward the palm. */
  private readonly curlAxis: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)];
  /** Where the head bone's origin should have a helmet and an eye. */
  readonly head: THREE.Bone;
  /** Metres per local unit under the figure's root (0.01 for a model in centimetres). */
  private readonly unit: number;

  // Scratch.
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly tip = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly line = new THREE.Vector3();
  private readonly bendAxis = new THREE.Vector3(1, 0, 0);
  private bendAngle = 0;

  /** This rider's clothes. */
  private readonly materials: THREE.Material[] = [];
  /** The clothes at full detail and at long-range detail; exactly one set is drawn. */
  private readonly nearMeshes: THREE.SkinnedMesh[] = [];
  private readonly farMeshes: THREE.SkinnedMesh[] = [];
  private far = false;

  constructor(scene: THREE.Object3D, color: number, scale = 1) {
    scene.scale.multiplyScalar(scale);
    this.holder.add(scene);
    this.holder.updateMatrixWorld(true);

    const make = (c: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial => {
      const material = new THREE.MeshStandardMaterial({ color: c, roughness, metalness });
      this.materials.push(material);
      return material;
    };
    const palette: Record<string, THREE.Material> = {
      jacket: make(new THREE.Color(color).multiplyScalar(0.8).getHex(), 0.7),
      trim: make(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.78).getHex(), 0.5),
      trousers: make(0x23262e, 0.85),
      gloves: make(0x15161a, 0.6),
      boots: make(0x15161a, 0.55),
      soles: make(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.78).getHex(), 0.6),
    };
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      const garment = mesh.userData?.garment as string | undefined;
      if (mesh.isSkinnedMesh && garment && palette[garment]) mesh.material = palette[garment];
      if (mesh.isSkinnedMesh && mesh.userData?.lod) (mesh.userData.lod === "far" ? this.farMeshes : this.nearMeshes).push(mesh);
    });

    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        mesh.castShadow = true;
        mesh.frustumCulled = false;
      }
    });

    const bones: THREE.Bone[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });
    const byBone = new Map<THREE.Bone, BoneData>();
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    const ws = new THREE.Vector3();
    for (const bone of bones) {
      bone.matrixWorld.decompose(wp, wq, ws);
      const data: BoneData = {
        bone,
        parent: null,
        restLocalQuat: bone.quaternion.clone(),
        restLocalPos: new THREE.Vector3(),
        restWorldQuat: wq.clone(),
        restWorldPos: wp.clone(),
        worldQuat: wq.clone(),
        worldPos: wp.clone(),
        children: [],
      };
      byBone.set(bone, data);
      this.bones.set(RiderCharacter.shortName(bone.name), data);
    }
    for (const data of byBone.values()) {
      const parent = data.bone.parent as THREE.Bone | null;
      if (parent && (parent as THREE.Bone).isBone) {
        data.parent = byBone.get(parent) ?? null;
        data.parent?.children.push(data);
      }
    }
    const hips = this.bones.get("Hips");
    const head = this.bones.get("Head");
    if (!hips || !head) throw new Error("rider model has no Hips/Head bone: not a Mixamo skeleton");
    this.hips = hips;
    this.head = head.bone;

    // Local rest offsets in model metres: the offset between rest world positions, undone through the parent's rest rotation.
    for (const data of byBone.values()) {
      if (!data.parent) continue;
      data.restLocalPos.copy(data.restWorldPos).sub(data.parent.restWorldPos).applyQuaternion(this.q.copy(data.parent.restWorldQuat).invert());
    }
    this.unit = hips.bone.parent ? hips.bone.parent.matrixWorld.getMaxScaleOnAxis() : 1;
    if (hips.bone.parent) this.hipsParentInverse.copy(hips.bone.parent.matrixWorld).invert();

    // Top-down order so a parent is always posed before its children.
    const visit = (d: BoneData): void => {
      this.order.push(d);
      d.children.forEach(visit);
    };
    visit(this.hips);

    this.curlAxis[0].set(0, 0, -1);
    this.curlAxis[1].set(0, 0, 1);
    this.pose(DEFAULT_POSE());
  }

  /** `mixamorig1:Hips`, `mixamorig1Hips` and `Hips` are all `Hips`. */
  private static shortName(name: string): string {
    return name.replace(/^mixamorig\d*:?/, "");
  }

  /** The bone's rotation in the model's space, so far this frame. */
  private get(name: string): BoneData {
    const d = this.bones.get(name);
    if (!d) throw new Error(`rider model is missing bone ${name}`);
    return d;
  }

  /** Where `d` would be with no rotation of its own: its parent's pose times its rest local rotation. */
  private unaimed(d: BoneData, out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(d.parent ? d.parent.worldQuat : this.q2.identity()).multiply(d.restLocalQuat);
  }

  private place(d: BoneData): void {
    if (d.parent) d.worldPos.copy(d.restLocalPos).applyQuaternion(d.parent.worldQuat).add(d.parent.worldPos);
  }

  /** Aims `d` so the line to `child` points along `target` (a unit vector in the model's space), keeping its roll from the parent. */
  private aim(d: BoneData, child: BoneData, target: THREE.Vector3): void {
    const u = this.unaimed(d, this.q);
    const along = this.v.copy(child.restLocalPos).normalize().applyQuaternion(u);
    this.q2.setFromUnitVectors(along, target);
    d.worldQuat.copy(this.q2).multiply(u);
  }

  /**
   * Poses the figure from a physics ragdoll: every body's orientation goes to the matching bone (the arms are
   * first swung down from the T-pose to hang as the ragdoll's do), the pelvis carries the hips, and the rest
   * follows from the figure's own proportions. `bodyPose` is the ragdoll's drawn pose by body name, in the
   * world, which is also this figure's space.
   */
  poseFromBodies(bodyPose: (name: string) => { position: THREE.Vector3; quaternion: THREE.Quaternion } | undefined): void {
    const pelvis = bodyPose("pelvis");
    const torso = bodyPose("torso");
    const head = bodyPose("head");
    if (!pelvis || !torso || !head) return;

    this.hips.worldPos.copy(pelvis.position).add(this.v.set(0, -0.03, 0).applyQuaternion(pelvis.quaternion));
    this.hips.worldQuat.copy(pelvis.quaternion).multiply(this.hips.restWorldQuat);
    for (const d of this.order) {
      if (d === this.hips) continue;
      d.worldQuat.copy(d.parent!.worldQuat).multiply(d.restLocalQuat);
      this.place(d);
    }

    const set = (name: string, body: { quaternion: THREE.Quaternion }, hangs?: string): void => {
      const d = this.get(name);
      d.worldQuat.copy(body.quaternion);
      // A bone that rests along the arm's T-pose line is swung down to hang first.
      if (hangs) d.worldQuat.multiply(this.hangQuat(d, this.get(hangs)));
      else d.worldQuat.multiply(d.restWorldQuat);
      this.place(d);
    };
    const blend = (name: string, from: THREE.Quaternion, to: THREE.Quaternion, t: number): void => {
      const d = this.get(name);
      d.worldQuat.copy(from).slerp(to, t).multiply(d.restWorldQuat);
      this.place(d);
    };

    blend("Spine", pelvis.quaternion, torso.quaternion, 0.4);
    blend("Spine1", pelvis.quaternion, torso.quaternion, 0.75);
    blend("Spine2", pelvis.quaternion, torso.quaternion, 1);
    for (const name of ["Neck", "LeftShoulder", "RightShoulder"]) {
      const d = this.get(name);
      d.worldQuat.copy(d.parent!.worldQuat).multiply(d.restLocalQuat);
      this.place(d);
    }
    blend("Neck", torso.quaternion, head.quaternion, 0.5);
    set("Head", head);
    for (const side of ["Left", "Right"] as const) {
      const upperArm = bodyPose(`upperArm${side}`);
      const foreArm = bodyPose(`foreArm${side}`);
      const upperLeg = bodyPose(`upperLeg${side}`);
      const lowerLeg = bodyPose(`lowerLeg${side}`);
      this.place(this.get(`${side}Arm`));
      if (upperArm) set(`${side}Arm`, upperArm, `${side}ForeArm`);
      if (foreArm) set(`${side}ForeArm`, foreArm, `${side}Hand`);
      if (upperLeg) set(`${side}UpLeg`, upperLeg);
      if (lowerLeg) set(`${side}Leg`, lowerLeg);
      // Hands, feet and fingers follow their parents; place everything below the posed bones.
      for (const name of [`${side}Hand`, `${side}Foot`, `${side}ToeBase`]) {
        const d = this.get(name);
        d.worldQuat.copy(d.parent!.worldQuat).multiply(d.restLocalQuat);
        this.place(d);
      }
    }
    // Fingers and anything else not set above: follow.
    for (const d of this.order) {
      if (!/Hand(Thumb|Index|Middle|Ring|Pinky)\d$/.test(d.bone.name)) continue;
      d.worldQuat.copy(d.parent!.worldQuat).multiply(d.restLocalQuat);
      this.place(d);
    }
    this.write();
  }

  /** The rest orientation of a limb bone, swung so its line to `child` points straight down (arms hanging). */
  private hangQuat(d: BoneData, child: BoneData): THREE.Quaternion {
    const rest = this.v2.copy(child.restWorldPos).sub(d.restWorldPos).normalize();
    return new THREE.Quaternion().setFromUnitVectors(rest, DOWN).multiply(d.restWorldQuat);
  }

  /** Moves the whole figure into this pose. */
  pose(p: RiderPose): void {
    // Rest chest line is straight up; the torso line leans it forward, and the pelvis and spine share that.
    const lineDir = this.line.subVectors(p.spineTop, p.spineBase).normalize();
    this.bendAxisAngle(UP, lineDir);
    this.hips.worldPos.copy(p.hips);
    this.hips.worldPos.z += HIPS_FORWARD;
    this.hips.worldQuat.setFromAxisAngle(this.bendAxis, this.bendAngle * PELVIS_SHARE).multiply(this.hips.restWorldQuat);

    // Everything starts following its parent; the explicit bones below override.
    for (const d of this.order) {
      if (d === this.hips) continue;
      d.worldQuat.copy(d.parent!.worldQuat).multiply(d.restLocalQuat);
      this.place(d);
    }

    this.poseSpine(p);
    this.poseHead(p);
    for (const side of [0, 1] as const) {
      this.poseArm(side, p);
      this.poseLeg(side, p);
    }
    this.write();
  }

  /** Axis and angle of the rotation taking `from` to `to`, kept so a share of it can be applied. */
  private bendAxisAngle(from: THREE.Vector3, to: THREE.Vector3): void {
    const q = this.q2.setFromUnitVectors(from, to);
    this.bendAngle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
    const s = Math.sqrt(Math.max(1 - q.w * q.w, 0));
    if (s < 1e-6) this.bendAxis.set(1, 0, 0);
    else this.bendAxis.set(q.x / s, q.y / s, q.z / s);
  }

  private poseSpine(p: RiderPose): void {
    const lineDir = this.line;
    const names = ["Spine", "Spine1", "Spine2"] as const;
    names.forEach((name, i) => {
      const d = this.get(name);
      const share = this.q.setFromAxisAngle(this.bendAxis, this.bendAngle * SPINE_SHARE[i]);
      // Twist about the chest line, mostly in the upper spine.
      const twist = this.q2.setFromAxisAngle(lineDir, p.twist * (i / 2));
      d.worldQuat.copy(twist).multiply(share).multiply(d.restWorldQuat);
      this.place(d);
    });
    for (const name of ["Neck", "LeftShoulder", "RightShoulder"]) {
      const d = this.get(name);
      d.worldQuat.copy(d.parent!.worldQuat).multiply(d.restLocalQuat);
      this.place(d);
    }
  }

  private poseHead(p: RiderPose): void {
    const neck = this.get("Neck");
    const head = this.get("Head");
    // Neck follows the chest; the head is set absolutely so it looks ahead whatever the lean.
    head.worldQuat.setFromEuler(new THREE.Euler(HEAD_PITCH, p.headYaw, 0, "YXZ")).multiply(head.restWorldQuat);
    this.place(neck);
    this.place(head);
  }

  private poseArm(side: 0 | 1, p: RiderPose): void {
    const prefix = side === 0 ? "Left" : "Right";
    const shoulder = this.get(`${prefix}Shoulder`);
    const upper = this.get(`${prefix}Arm`);
    const fore = this.get(`${prefix}ForeArm`);
    const hand = this.get(`${prefix}Hand`);
    const limb = p.arms[side];

    this.place(shoulder);
    this.place(upper);
    // The hand bone is at the wrist; the pose's tip is the middle of the fist, a palm's width further on.
    const target = this.v2.copy(limb.tip).addScaledVector(limb.forward, -PALM_OFFSET);
    this.solveTwoBone(upper.worldPos, target, limb, this.lengthOf(fore, upper), this.lengthOf(hand, fore), this.mid, this.tip);

    this.aim(upper, fore, this.dir.copy(this.mid).sub(upper.worldPos).normalize());
    this.place(fore);
    this.aim(fore, hand, this.dir.copy(this.tip).sub(fore.worldPos).normalize());
    this.place(hand);
    // The hand carries on from the forearm.
    this.unaimed(hand, hand.worldQuat);
    this.curlFingers(prefix, side, p.curl[side]);
  }

  private lengthOf(d: BoneData, from: BoneData): number {
    return d.restWorldPos.distanceTo(from.restWorldPos);
  }

  /**
   * Two-bone solve from `root` to `target`, bending toward the side the pose's own joint bends to.
   * Writes the knee/elbow into `outMid` and the point actually reached into `outTip`.
   */
  private solveTwoBone(root: THREE.Vector3, target: THREE.Vector3, limb: LimbPose, lenA: number, lenB: number, outMid: THREE.Vector3, outTip: THREE.Vector3): void {
    const toTarget = this.dir.subVectors(target, root);
    const reach = THREE.MathUtils.clamp(toTarget.length(), 0.05, lenA + lenB - 1e-3);
    toTarget.normalize();
    const along = (lenA * lenA - lenB * lenB + reach * reach) / (2 * reach);
    const height = Math.sqrt(Math.max(lenA * lenA - along * along, 0));
    // Which way the joint bends: where the pose's own elbow/knee sits off the root-to-tip line.
    const axis = this.axis.subVectors(limb.tip, limb.root).normalize();
    const bend = this.bend.subVectors(limb.mid, limb.root);
    bend.addScaledVector(axis, -bend.dot(axis));
    if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1);
    bend.addScaledVector(toTarget, -bend.dot(toTarget)).normalize();
    outMid.copy(root).addScaledVector(toTarget, along).addScaledVector(bend, height);
    outTip.copy(root).addScaledVector(toTarget, reach);
  }

  private poseLeg(side: 0 | 1, p: RiderPose): void {
    const prefix = side === 0 ? "Left" : "Right";
    const upper = this.get(`${prefix}UpLeg`);
    const lower = this.get(`${prefix}Leg`);
    const foot = this.get(`${prefix}Foot`);
    const toe = this.get(`${prefix}ToeBase`);
    const limb = p.legs[side];

    this.place(upper);
    // The procedural shoe hangs below and ahead of the pose's ankle; the figure's ankle bone is a little above its sole.
    const target = this.v2.copy(limb.tip);
    target.y += ANKLE_ABOVE_TARGET;
    this.solveTwoBone(upper.worldPos, target, limb, this.lengthOf(lower, upper), this.lengthOf(foot, lower), this.mid, this.tip);

    this.aim(upper, lower, this.dir.copy(this.mid).sub(upper.worldPos).normalize());
    this.place(lower);
    this.aim(lower, foot, this.dir.copy(this.tip).sub(lower.worldPos).normalize());
    this.place(foot);
    // The foot hangs at a right angle to the shin, so it tilts with it.
    this.q.setFromUnitVectors(DOWN, this.dir.copy(this.tip).sub(lower.worldPos).normalize());
    foot.worldQuat.copy(this.q).multiply(foot.restWorldQuat);
    this.place(toe);
    toe.worldQuat.copy(foot.worldQuat).multiply(toe.restLocalQuat);
  }

  /** Curls the four fingers toward the palm (and the thumb a little). `amount` is 0..1. */
  private curlFingers(prefix: "Left" | "Right", side: 0 | 1, amount: number): void {
    const axisWorld = this.curlAxis[side];
    for (const finger of FINGER_CHAINS) {
      for (let i = 1; i <= 3; i++) {
        const d = this.bones.get(`${prefix}Hand${finger}${i}`);
        if (!d || !d.parent) continue;
        // Follow the parent, then curl about the palm-side axis, in the bone's own frame.
        const base = this.q.copy(d.parent.worldQuat).multiply(d.restLocalQuat);
        const local = this.v.copy(axisWorld).applyQuaternion(this.q2.copy(d.restWorldQuat).invert());
        const angle = amount * (i === 1 ? 1.25 : 1.45);
        d.worldQuat.copy(base).multiply(this.q2.setFromAxisAngle(local, angle));
        this.place(d);
      }
    }
    const thumb = this.bones.get(`${prefix}HandThumb1`);
    if (thumb?.parent) {
      thumb.worldQuat.copy(thumb.parent.worldQuat).multiply(thumb.restLocalQuat);
      this.place(thumb);
      for (const n of [2, 3]) {
        const t = this.bones.get(`${prefix}HandThumb${n}`);
        if (!t?.parent) continue;
        const local = this.v.copy(axisWorld).applyQuaternion(this.q2.copy(t.restWorldQuat).invert());
        t.worldQuat.copy(t.parent.worldQuat).multiply(t.restLocalQuat).multiply(this.q2.setFromAxisAngle(local, amount * 0.7));
        this.place(t);
      }
    }
  }

  /** Copies the solved world rotations into the bones' local transforms. */
  private write(): void {
    for (const d of this.order) {
      if (d === this.hips) {
        d.bone.quaternion.copy(d.worldQuat);
        // The hips bone sits in the scaled root; undo that to put it at the pose's position.
        d.bone.position.copy(d.worldPos).applyMatrix4(this.hipsParentInverse);
      } else {
        d.bone.quaternion.copy(this.q.copy(d.parent!.worldQuat).invert()).multiply(d.worldQuat);
      }
    }
  }

  /** Current position of a bone in the model's space after the last `pose`, for placing things on it and for checks. */
  boneWorld(name: string, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.get(name).worldPos);
  }

  /** Metres per local unit; exposed for mounting objects on bones (a helmet on the head). */
  get localUnit(): number {
    return this.unit;
  }

  setVisible(visible: boolean): void {
    this.holder.visible = visible;
  }

  /** Draws the long-range clothes (a few thousand triangles for the whole rider) instead of the full ones. */
  setFar(far: boolean): void {
    if (far === this.far) return;
    this.far = far;
    for (const mesh of this.nearMeshes) mesh.visible = !far;
    for (const mesh of this.farMeshes) mesh.visible = far;
  }

  dispose(): void {
    this.holder.removeFromParent();
    this.materials.forEach((m) => m.dispose());
  }
}

function DEFAULT_POSE(): RiderPose {
  const pose: RiderPose = {
    hips: new THREE.Vector3(0, 0.998, 0.03),
    spineBase: new THREE.Vector3(0, 1.058, 0.03),
    spineTop: new THREE.Vector3(0, 1.558, 0.03),
    twist: 0,
    headYaw: 0,
    arms: [createLimbPose(), createLimbPose()],
    legs: [createLimbPose(), createLimbPose()],
    curl: [0.2, 0.2],
  };
  // Hang the arms and legs straight down.
  for (const side of [0, 1] as const) {
    const sign = side === 0 ? 1 : -1;
    pose.arms[side].root.set(sign * 0.19, 1.43, 0);
    pose.arms[side].mid.set(sign * 0.2, 1.17, 0.02);
    pose.arms[side].tip.set(sign * 0.2, 0.93, 0.03);
    pose.arms[side].forward.set(0, -1, 0);
    pose.legs[side].root.set(sign * 0.08, 0.944, 0.03);
    pose.legs[side].mid.set(sign * 0.09, 0.52, 0.04);
    pose.legs[side].tip.set(sign * 0.09, 0.1, 0.03);
    pose.legs[side].forward.set(0, -1, 0);
  }
  return pose;
}
