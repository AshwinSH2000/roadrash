import * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";
import { OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import type { GraphicsSettings } from "../settings/GraphicsSettings";

/**
 * Roadside scenery — low-poly props scattered past the off-road band, so the
 * world doesn't end in visible nothing a few dozen metres from the racing
 * line. Purely decorative: no colliders (the new invisible boundary wall in
 * `Boundary.ts` is what actually stops a rider, at `OFFROAD_HALF_WIDTH`,
 * *inside* where every band here starts), so scenery costs nothing
 * physics-wise and can't itself become something to crash into.
 *
 * What gets scattered depends on the biome at that point along the course
 * (`TrackDefinition.biomeAt`, authored per course in `tracks.ts`): forest
 * (trees/rocks, the original Phase 9 look and still the default), farm
 * (animals + the odd barn), mountain (bigger rocks + tall pines), and city
 * (a crowd right behind the boundary wall, cars parked in a line behind
 * them, and a couple of rows of buildings further back) — see each
 * `build*Band` function below. Every prop type follows the same recipe: one
 * `THREE.InstancedMesh` per geometry, filled from an over-sized candidate
 * buffer and trimmed to the real count afterward, so hundreds of instances
 * over a 2-3 km course still cost a handful of draw calls rather than one
 * per plant/person/car — the same reasoning Phase 9 used for trees/rocks.
 *
 * There is no terrain mesh out here (see TODO.md's "world edge" note — the
 * modelled ground stops at the off-road band's outer edge), so instances are
 * dropped to roughly the height the off-road terrain visually falls away to,
 * rather than sampled from real ground that doesn't exist at this distance.
 * Good enough for background dressing seen from the road; not a claim that
 * there's solid ground under it.
 */

/** How many track samples to skip between candidate planting spots for the dense, near band (samples are ~3 m apart). */
const SAMPLE_STRIDE = 5;
/** Same, for the sparser background props (barns, buildings) set further back. */
const BACKGROUND_STRIDE = 20;
/** Roughly how far the off-road terrain's outer edge drops, visually — see `TrackBuilder`'s `OFFROAD_OUTER_DROP`. */
const GROUND_DROP = -2.5;

export interface Scenery {
  group: THREE.Group;
  dispose(): void;
}

/** Candidate-slot upper bound for a scatter pass: both sides, at a given sample stride. */
function slotCount(track: TrackDefinition, stride: number): number {
  return Math.ceil(track.samplePoints.length / stride) * 2;
}

/** Builds the scattered scenery for one track, at a density set by the quality preset. */
export function buildScenery(track: TrackDefinition, quality: GraphicsSettings): Scenery {
  const group = new THREE.Group();
  group.name = "scenery";
  const disposers: Array<() => void> = [];

  if (quality.sceneryDensity <= 0 || track.samplePoints.length < 2) {
    return { group, dispose: () => {} };
  }

  group.add(buildForestFarmMountainAndCity(track, quality, disposers));
  group.add(buildBackgroundProps(track, quality, disposers));
  group.add(buildMountainBackdrop(track, quality, disposers));

  return {
    group,
    dispose(): void {
      for (const dispose of disposers) dispose();
    },
  };
}

/** A prop type: one instanced mesh plus the running count of instances actually placed into it. */
interface PropSlot {
  mesh: THREE.InstancedMesh;
  count: number;
}

function makePropSlot(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  name: string,
  disposers: Array<() => void>,
): PropSlot {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  mesh.count = 0;
  disposers.push(() => {
    geometry.dispose();
    material.dispose();
  });
  return { mesh, count: 0 };
}

const finishSlot = (slot: PropSlot): void => {
  slot.mesh.count = slot.count;
  slot.mesh.instanceMatrix.needsUpdate = true;
};

/**
 * The dense, near scatter band: trees/rocks (forest, the default), cows/sheep
 * (farm), pines/big rocks (mountain), or a crowd + parked cars (city, right
 * behind the boundary wall). One roll per track sample per side, so this is
 * the direct descendant of Phase 9's original tree-or-rock loop.
 */
function buildForestFarmMountainAndCity(
  track: TrackDefinition,
  quality: GraphicsSettings,
  disposers: Array<() => void>,
): THREE.Group {
  const group = new THREE.Group();
  const capacity = slotCount(track, SAMPLE_STRIDE);

  const treeGeometry = new THREE.ConeGeometry(1, 1, 7);
  treeGeometry.translate(0, 0.5, 0); // base at local y=0, apex at y=1
  const trees = makePropSlot(
    treeGeometry,
    new THREE.MeshStandardMaterial({ color: 0x2f5c34, roughness: 0.9 }),
    capacity,
    "scenery-trees",
    disposers,
  );

  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  rockGeometry.translate(0, 0.35, 0); // sit partly bedded into the ground rather than floating
  const rocks = makePropSlot(
    rockGeometry,
    new THREE.MeshStandardMaterial({ color: 0x7a7368, roughness: 1.0 }),
    capacity,
    "scenery-rocks",
    disposers,
  );

  const cowGeometry = new THREE.BoxGeometry(1, 1, 1);
  cowGeometry.translate(0, 0.5, 0);
  const cows = makePropSlot(
    cowGeometry,
    new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.85 }),
    capacity,
    "scenery-cows",
    disposers,
  );

  const sheepGeometry = new THREE.IcosahedronGeometry(1, 0);
  sheepGeometry.translate(0, 0.4, 0);
  const sheep = makePropSlot(
    sheepGeometry,
    new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 1.0 }),
    capacity,
    "scenery-sheep",
    disposers,
  );

  const crowdGeometry = new THREE.CapsuleGeometry(0.22, 0.9, 4, 6);
  crowdGeometry.translate(0, 0.22 + 0.45, 0); // base at y=0
  const crowd = makePropSlot(
    crowdGeometry,
    new THREE.MeshStandardMaterial({ color: 0x33475b, roughness: 0.9 }),
    capacity,
    "scenery-crowd",
    disposers,
  );

  const carGeometry = new THREE.BoxGeometry(1, 1, 1);
  carGeometry.translate(0, 0.5, 0);
  const cars = makePropSlot(
    carGeometry,
    new THREE.MeshStandardMaterial({ color: 0x3a4a5c, roughness: 0.55, metalness: 0.3 }),
    capacity,
    "scenery-cars",
    disposers,
  );

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const alignedQuaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3(0, 0, 1);
  const last = track.samplePoints.length - 1;

  for (let i = 0; i < track.samplePoints.length; i += SAMPLE_STRIDE) {
    const center = track.samplePoints[i];
    const right = track.sampleRights[i];
    const next = track.samplePoints[Math.min(i + 1, last)];
    tangent.subVectors(next, center);
    if (tangent.lengthSq() < 1e-6) tangent.set(0, 0, 1);
    tangent.normalize();
    alignedQuaternion.setFromUnitVectors(forward, tangent);

    const biome = track.biomeAt(track.sampleDistances[i]);

    for (const side of [-1, 1] as const) {
      const place = (
        slot: PropSlot,
        depth: number,
        lateralJitter: number,
        alongJitter: number,
        sizeFn: () => void,
        faceRoad: boolean,
      ): void => {
        const lateral = side * depth + (Math.random() - 0.5) * lateralJitter;
        const along = (Math.random() - 0.5) * alongJitter;
        position.copy(center).addScaledVector(right, lateral).addScaledVector(tangent, along);
        position.y = center.y + GROUND_DROP;
        sizeFn();
        matrix.compose(position, faceRoad ? alignedQuaternion : quaternion, scale);
        slot.mesh.setMatrixAt(slot.count++, matrix);
      };

      quaternion.setFromAxisAngle(up, Math.random() * Math.PI * 2);

      switch (biome) {
        case "forest": {
          if (Math.random() > quality.sceneryDensity) break;
          const depth = OFFROAD_HALF_WIDTH + 4 + Math.random() * 18;
          if (Math.random() < 0.7) {
            place(trees, depth, 3, 4, () => {
              const radius = 1.1 + Math.random() * 0.9;
              const height = 3.5 + Math.random() * 3.5;
              scale.set(radius, height, radius);
            }, false);
          } else {
            place(rocks, depth, 3, 4, () => {
              const size = 0.6 + Math.random() * 1.4;
              scale.set(size, size * (0.7 + Math.random() * 0.5), size);
            }, false);
          }
          break;
        }
        case "mountain": {
          if (Math.random() > quality.sceneryDensity) break;
          const depth = OFFROAD_HALF_WIDTH + 3 + Math.random() * 22;
          if (Math.random() < 0.55) {
            // Pines: the same cone as a forest tree, taller and thinner.
            place(trees, depth, 3, 4, () => {
              const radius = 0.7 + Math.random() * 0.5;
              const height = 5 + Math.random() * 5;
              scale.set(radius, height, radius);
            }, false);
          } else {
            place(rocks, depth, 4, 5, () => {
              const size = 1.2 + Math.random() * 2.6;
              scale.set(size, size * (0.8 + Math.random() * 0.5), size);
            }, false);
          }
          break;
        }
        case "farm": {
          if (Math.random() > quality.sceneryDensity) break;
          const depth = OFFROAD_HALF_WIDTH + 2 + Math.random() * 13;
          if (Math.random() < 0.6) {
            place(cows, depth, 4, 5, () => scale.set(0.9, 1.1, 1.9), false);
          } else {
            place(sheep, depth, 4, 5, () => {
              const size = 0.55 + Math.random() * 0.2;
              scale.set(size, size * 0.85, size * 1.1);
            }, false);
          }
          break;
        }
        case "city": {
          // Crowd: dense, right behind the boundary wall.
          if (Math.random() < quality.sceneryDensity) {
            place(crowd, OFFROAD_HALF_WIDTH + 0.6 + Math.random() * 2.2, 1.5, 2, () => {
              const s = 0.85 + Math.random() * 0.3;
              scale.set(s, s, s);
            }, false);
          }
          // Parked cars: a separate, sparser roll just behind the crowd,
          // aligned along the track rather than randomly spun, so they read
          // as lined up watching rather than scattered.
          if (Math.random() < quality.sceneryDensity * 0.5) {
            place(cars, OFFROAD_HALF_WIDTH + 3.5 + Math.random() * 3, 1, 1.5, () => {
              scale.set(1.7, 1.3, 3.8);
            }, true);
          }
          break;
        }
      }
    }
  }

  finishSlot(trees);
  finishSlot(rocks);
  finishSlot(cows);
  finishSlot(sheep);
  finishSlot(crowd);
  finishSlot(cars);

  group.add(trees.mesh, rocks.mesh, cows.mesh, sheep.mesh, crowd.mesh, cars.mesh);
  return group;
}

/**
 * The sparse, further-back band: farm barns and a city skyline (houses
 * nearer, apartments further, for a bit of depth). Sampled much coarser than
 * the near band since these are big, infrequent props, not a scatter.
 */
function buildBackgroundProps(
  track: TrackDefinition,
  quality: GraphicsSettings,
  disposers: Array<() => void>,
): THREE.Group {
  const group = new THREE.Group();
  const capacity = slotCount(track, BACKGROUND_STRIDE);

  const barnGeometry = new THREE.BoxGeometry(1, 1, 1);
  barnGeometry.translate(0, 0.5, 0);
  const barns = makePropSlot(
    barnGeometry,
    new THREE.MeshStandardMaterial({ color: 0xa13a2e, roughness: 0.8 }),
    capacity,
    "scenery-barns",
    disposers,
  );

  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  buildingGeometry.translate(0, 0.5, 0);
  const buildings = makePropSlot(
    buildingGeometry,
    new THREE.MeshStandardMaterial({ color: 0xb8ada0, roughness: 0.9 }),
    capacity,
    "scenery-buildings",
    disposers,
  );

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < track.samplePoints.length; i += BACKGROUND_STRIDE) {
    const center = track.samplePoints[i];
    const right = track.sampleRights[i];
    const biome = track.biomeAt(track.sampleDistances[i]);
    if (biome !== "farm" && biome !== "city") continue;

    for (const side of [-1, 1] as const) {
      if (Math.random() > quality.sceneryDensity) continue;
      quaternion.setFromAxisAngle(up, Math.random() * Math.PI * 2);

      if (biome === "farm") {
        if (Math.random() > 0.35) continue; // barns are sparse
        const depth = OFFROAD_HALF_WIDTH + 18 + Math.random() * 20;
        position.copy(center).addScaledVector(right, side * depth);
        position.y = center.y + GROUND_DROP;
        const width = 3.5 + Math.random() * 1.5;
        const height = 4 + Math.random() * 2;
        scale.set(width, height, width * 1.4);
        matrix.compose(position, quaternion, scale);
        barns.mesh.setMatrixAt(barns.count++, matrix);
      } else {
        const nearRow = Math.random() < 0.5;
        const depth = nearRow ? OFFROAD_HALF_WIDTH + 10 + Math.random() * 10 : OFFROAD_HALF_WIDTH + 28 + Math.random() * 14;
        position.copy(center).addScaledVector(right, side * depth);
        position.y = center.y + GROUND_DROP;
        const width = (nearRow ? 4 : 6) + Math.random() * 3;
        const height = (nearRow ? 4 : 12) + Math.random() * (nearRow ? 4 : 14);
        scale.set(width, height, width);
        matrix.compose(position, quaternion, scale);
        buildings.mesh.setMatrixAt(buildings.count++, matrix);
      }
    }
  }

  finishSlot(barns);
  finishSlot(buildings);
  group.add(barns.mesh, buildings.mesh);
  return group;
}

/**
 * A distant, always-on ring of low-poly peaks around the whole course, so the
 * horizon has something other than flat sky past the ground fill — separate
 * from the per-biome bands above, since a mountain skyline reads as ambient
 * backdrop rather than something tied to a specific stretch of road.
 * Visual only, no collider, far outside anywhere the wall or ground fill
 * reach — cheap enough to keep even on the "low" preset.
 */
function buildMountainBackdrop(
  track: TrackDefinition,
  quality: GraphicsSettings,
  disposers: Array<() => void>,
): THREE.Group {
  const group = new THREE.Group();

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let lowestY = Infinity;
  for (const p of track.samplePoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    if (p.y < lowestY) lowestY = p.y;
  }
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const radius = Math.max(maxX - minX, maxZ - minZ) / 2 + 700;

  const peakGeometry = new THREE.ConeGeometry(1, 1, 4);
  peakGeometry.translate(0, 0.5, 0);
  const peakMaterial = new THREE.MeshStandardMaterial({
    color: 0x6b7a8f,
    roughness: 1.0,
    fog: true,
  });
  disposers.push(() => {
    peakGeometry.dispose();
    peakMaterial.dispose();
  });

  const peakCount = Math.max(24, Math.round(48 * Math.max(0.3, quality.sceneryDensity)));
  const peaks = new THREE.InstancedMesh(peakGeometry, peakMaterial, peakCount);
  peaks.name = "scenery-mountain-backdrop";
  peaks.receiveShadow = false;
  peaks.castShadow = false;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let i = 0; i < peakCount; i++) {
    const angle = (i / peakCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
    const r = radius * (0.9 + Math.random() * 0.3);
    position.set(centerX + Math.cos(angle) * r, lowestY - 20, centerZ + Math.sin(angle) * r);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    const width = 250 + Math.random() * 300;
    const height = 180 + Math.random() * 260;
    scale.set(width, height, width);
    matrix.compose(position, quaternion, scale);
    peaks.setMatrixAt(i, matrix);
  }
  peaks.instanceMatrix.needsUpdate = true;
  group.add(peaks);

  return group;
}
