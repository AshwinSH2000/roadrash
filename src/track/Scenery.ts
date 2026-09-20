import * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";
import { OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import type { GraphicsSettings } from "../settings/GraphicsSettings";

/**
 * Phase 9: roadside scenery — low-poly trees and rocks scattered past the
 * off-road band, so the world doesn't end in visible nothing a few dozen
 * metres from the racing line. Purely decorative: no colliders, so it costs
 * nothing physics-wise and can't itself become something to crash into.
 *
 * Two `InstancedMesh` objects (one geometry each for trees and rocks) rather
 * than one draw call per plant — with hundreds of instances over a 2-3 km
 * course, that's the difference between a handful of draw calls and enough
 * to matter on the "low" preset's hardware.
 *
 * There is no terrain mesh out here (see TODO.md's "world edge" note — the
 * modelled ground stops at the off-road band's outer edge), so instances are
 * dropped to roughly the height the off-road terrain visually falls away to,
 * rather than sampled from real ground that doesn't exist at this distance.
 * Good enough for background dressing seen from the road; not a claim that
 * there's solid ground under it.
 */

/** How many track samples to skip between candidate planting spots (samples are ~3 m apart). */
const SAMPLE_STRIDE = 5;
/** Clear space kept between the off-road band's outer edge and the nearest scenery. */
const INNER_MARGIN = 4;
/** Depth of the band, beyond that margin, that scenery is scattered across. */
const OUTER_SPREAD = 18;
/** Random lateral wobble on top of the chosen depth, so instances don't line up in rows. */
const LATERAL_JITTER = 3;
/** Random along-track wobble, for the same reason. */
const ALONG_JITTER = 4;
/** Roughly how far the off-road terrain's outer edge drops, visually — see `TrackBuilder`'s `OFFROAD_OUTER_DROP`. */
const GROUND_DROP = -2.5;
/** Share of placed instances that are trees rather than rocks. */
const TREE_SHARE = 0.7;

export interface Scenery {
  group: THREE.Group;
  dispose(): void;
}

/** Builds the scattered scenery for one track, at a density set by the quality preset. */
export function buildScenery(track: TrackDefinition, quality: GraphicsSettings): Scenery {
  const group = new THREE.Group();
  group.name = "scenery";

  if (quality.sceneryDensity <= 0 || track.samplePoints.length < 2) {
    return { group, dispose: () => {} };
  }

  // Upper bound on instances for *either* mesh: every candidate slot on both
  // sides, in the (impossible) case they were all the same type.
  const candidateSlots = Math.ceil(track.samplePoints.length / SAMPLE_STRIDE) * 2;

  const treeGeometry = new THREE.ConeGeometry(1, 1, 7);
  treeGeometry.translate(0, 0.5, 0); // base at local y=0, apex at y=1
  const treeMaterial = new THREE.MeshStandardMaterial({ color: 0x2f5c34, roughness: 0.9 });
  const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, candidateSlots);
  trees.castShadow = true;
  trees.receiveShadow = true;
  trees.name = "scenery-trees";

  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  rockGeometry.translate(0, 0.35, 0); // sit partly bedded into the ground rather than floating
  const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x7a7368, roughness: 1.0 });
  const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, candidateSlots);
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  rocks.name = "scenery-rocks";

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  let treeCount = 0;
  let rockCount = 0;
  const last = track.samplePoints.length - 1;

  for (let i = 0; i < track.samplePoints.length; i += SAMPLE_STRIDE) {
    const center = track.samplePoints[i];
    const right = track.sampleRights[i];
    const next = track.samplePoints[Math.min(i + 1, last)];
    tangent.subVectors(next, center);
    if (tangent.lengthSq() < 1e-6) tangent.set(0, 0, 1);
    tangent.normalize();

    for (const side of [-1, 1] as const) {
      if (Math.random() > quality.sceneryDensity) continue;

      const depth = OFFROAD_HALF_WIDTH + INNER_MARGIN + Math.random() * OUTER_SPREAD;
      const lateral = side * depth + (Math.random() - 0.5) * LATERAL_JITTER;
      const along = (Math.random() - 0.5) * ALONG_JITTER;

      position
        .copy(center)
        .addScaledVector(right, lateral)
        .addScaledVector(tangent, along);
      position.y = center.y + GROUND_DROP;

      quaternion.setFromAxisAngle(up, Math.random() * Math.PI * 2);

      const isTree = Math.random() < TREE_SHARE;
      if (isTree) {
        const radius = 1.1 + Math.random() * 0.9;
        const height = 3.5 + Math.random() * 3.5;
        scale.set(radius, height, radius);
      } else {
        const size = 0.6 + Math.random() * 1.4;
        scale.set(size, size * (0.7 + Math.random() * 0.5), size);
      }

      matrix.compose(position, quaternion, scale);
      if (isTree) trees.setMatrixAt(treeCount++, matrix);
      else rocks.setMatrixAt(rockCount++, matrix);
    }
  }

  trees.count = treeCount;
  rocks.count = rockCount;
  trees.instanceMatrix.needsUpdate = true;
  rocks.instanceMatrix.needsUpdate = true;

  group.add(trees, rocks);

  return {
    group,
    dispose(): void {
      treeGeometry.dispose();
      treeMaterial.dispose();
      rockGeometry.dispose();
      rockMaterial.dispose();
    },
  };
}
