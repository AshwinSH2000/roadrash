import * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";
import { CITY_HALF_WIDTH, OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import type { GraphicsSettings } from "../settings/GraphicsSettings";
import { buildCity } from "./City";
import type { LampRegistry } from "./LampRegistry";

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
/** The foot of a backdrop mountain stays at least this far from any road, in metres. */
const PEAK_ROAD_CLEARANCE = 200;

export interface Scenery {
  group: THREE.Group;
  dispose(): void;
}

/** Candidate-slot upper bound for a scatter pass: both sides, at a given sample stride. */
function slotCount(track: TrackDefinition, stride: number): number {
  return Math.ceil(track.samplePoints.length / stride) * 2;
}

/** Builds the scattered scenery for one track, at a density set by the quality preset. */
export function buildScenery(track: TrackDefinition, quality: GraphicsSettings, ground?: GroundHeight, lamps?: LampRegistry): Scenery {
  const group = new THREE.Group();
  group.name = "scenery";
  const disposers: Array<() => void> = [];

  if (quality.sceneryDensity <= 0 || track.samplePoints.length < 2) {
    return { group, dispose: () => {} };
  }

  group.add(buildForestFarmMountainAndCity(track, quality, disposers, ground));
  group.add(buildBackgroundProps(track, quality, disposers, ground));
  group.add(buildCity(track, quality, disposers, lamps));
  group.add(buildMountainBackdrop(track, quality, disposers));

  return {
    group,
    dispose(): void {
      for (const dispose of disposers) dispose();
    },
  };
}

/** Height of the terrain at a world position, when there are hills for props to stand on. */
export type GroundHeight = (x: number, z: number) => number;

/** Where a prop at `position` (beside the road sample `center`) stands: on the hills if there are any, else at the off-road band's drop. */
function standingHeight(center: THREE.Vector3, position: THREE.Vector3, ground?: GroundHeight): number {
  return ground ? ground(position.x, position.z) : center.y + GROUND_DROP;
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
  ground?: GroundHeight,
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

  // Round-crowned trees: a short trunk and a lumpy ball of leaves, each ball its own green.
  const trunkGeometry = new THREE.CylinderGeometry(0.5, 0.65, 1, 6);
  trunkGeometry.translate(0, 0.5, 0);
  const trunks = makePropSlot(
    trunkGeometry,
    new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 }),
    capacity,
    "scenery-trunks",
    disposers,
  );
  const crowns = makePropSlot(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }),
    capacity,
    "scenery-crowns",
    disposers,
  );
  const crownColour = new THREE.Color();

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
  const identityQuaternion = new THREE.Quaternion();
  const last = track.samplePoints.length - 1;

  for (let i = 0; i < track.samplePoints.length; i += SAMPLE_STRIDE) {
    if (track.segmentInFeature(i, "loop", true)) continue;
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
        position.y = standingHeight(center, position, ground);
        sizeFn();
        matrix.compose(position, faceRoad ? alignedQuaternion : quaternion, scale);
        slot.mesh.setMatrixAt(slot.count++, matrix);
      };

      quaternion.setFromAxisAngle(up, Math.random() * Math.PI * 2);

      /** A round tree at this depth: trunk and crown placed together. */
      const placeRound = (depth: number): void => {
        const lateral = side * depth + (Math.random() - 0.5) * 3;
        const along = (Math.random() - 0.5) * 4;
        position.copy(center).addScaledVector(right, lateral).addScaledVector(tangent, along);
        position.y = standingHeight(center, position, ground);
        const height = 3.6 + Math.random() * 2.6;
        const trunkHeight = height * 0.45;
        const radius = 1.3 + Math.random() * 1.0;
        scale.set(0.28, trunkHeight, 0.28);
        matrix.compose(position, identityQuaternion, scale);
        trunks.mesh.setMatrixAt(trunks.count++, matrix);
        position.y += trunkHeight + radius * 0.55;
        scale.set(radius, radius * 0.88, radius);
        matrix.compose(position, quaternion, scale);
        crowns.mesh.setMatrixAt(crowns.count, matrix);
        crowns.mesh.setColorAt(crowns.count++, crownColour.setHSL(0.24 + Math.random() * 0.07, 0.42 + Math.random() * 0.15, 0.26 + Math.random() * 0.12));
      };

      switch (biome) {
        case "forest": {
          if (Math.random() > quality.sceneryDensity) break;
          const depth = OFFROAD_HALF_WIDTH + 4 + Math.random() * 18;
          if (Math.random() < 0.38) {
            placeRound(depth);
          } else if (Math.random() < 0.7) {
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
          if (Math.random() < 0.22) {
            placeRound(depth);
          } else if (Math.random() < 0.6) {
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
            place(crowd, CITY_HALF_WIDTH + 0.5 + Math.random() * 1.4, 1.2, 2, () => {
              const s = 0.85 + Math.random() * 0.3;
              scale.set(s, s, s);
            }, false);
          }
          // Parked cars: a separate, sparser roll just behind the crowd,
          // aligned along the track rather than randomly spun, so they read
          // as lined up watching rather than scattered.
          if (Math.random() < quality.sceneryDensity * 0.5) {
            place(cars, CITY_HALF_WIDTH + 3.1 + Math.random() * 0.5, 0.4, 1.5, () => {
              scale.set(1.7, 1.3, 3.8);
            }, true);
          }
          break;
        }
      }
    }
  }

  finishSlot(trees);
  finishSlot(trunks);
  finishSlot(crowns);
  if (crowns.mesh.instanceColor) crowns.mesh.instanceColor.needsUpdate = true;
  finishSlot(rocks);
  finishSlot(cows);
  finishSlot(sheep);
  finishSlot(crowd);
  finishSlot(cars);

  group.add(trees.mesh, trunks.mesh, crowns.mesh, rocks.mesh, cows.mesh, sheep.mesh, crowd.mesh, cars.mesh);
  return group;
}

/**
 * The sparse, further-back band: farm barns. Sampled much coarser than the
 * near band since these are big, infrequent props, not a scatter. (The town's
 * buildings are `buildCityStreet`.)
 */
function buildBackgroundProps(
  track: TrackDefinition,
  quality: GraphicsSettings,
  disposers: Array<() => void>,
  ground?: GroundHeight,
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

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < track.samplePoints.length; i += BACKGROUND_STRIDE) {
    if (track.segmentInFeature(i, "loop", true)) continue;
    const center = track.samplePoints[i];
    const right = track.sampleRights[i];
    const biome = track.biomeAt(track.sampleDistances[i]);
    if (biome !== "farm") continue;

    for (const side of [-1, 1] as const) {
      if (Math.random() > quality.sceneryDensity) continue;
      quaternion.setFromAxisAngle(up, Math.random() * Math.PI * 2);

      if (Math.random() > 0.35) continue; // barns are sparse
      const depth = OFFROAD_HALF_WIDTH + 18 + Math.random() * 20;
      position.copy(center).addScaledVector(right, side * depth);
      position.y = standingHeight(center, position, ground);
      const width = 3.5 + Math.random() * 1.5;
      const height = 4 + Math.random() * 2;
      scale.set(width, height, width * 1.4);
      matrix.compose(position, quaternion, scale);
      barns.mesh.setMatrixAt(barns.count++, matrix);
    }
  }

  finishSlot(barns);
  group.add(barns.mesh);
  return group;
}

/** Half-width, in radians, of the backdrop sector kept clear of peaks beyond the finish line. */
const PEAK_FINISH_CLEARANCE = 0.6;

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

  // A few different mountains, each a ridged cone with soft shoulders, coloured from forested foot through bare rock
  // to a snowy top, all in vertex colours: no textures, a couple of hundred triangles apiece.
  const mountainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, fog: true });
  const variants = [0, 1, 2, 3].map((n) => makeMountainGeometry(7 + n * 13));
  disposers.push(() => {
    variants.forEach((g) => g.dispose());
    mountainMaterial.dispose();
  });
  const peakCount = Math.max(24, Math.round(48 * Math.max(0.3, quality.sceneryDensity)));
  const peaks = variants.map((geometry, n) => {
    const mesh = new THREE.InstancedMesh(geometry, mountainMaterial, peakCount);
    mesh.name = `scenery-mountain-backdrop-${n}`;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.count = 0;
    return mesh;
  });

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  /** Distance from `p`, on the ground plane, to the nearest stretch of road. */
  const nearestRoad = (p: THREE.Vector3): number => {
    let best = Infinity;
    for (let i = 0; i < track.samplePoints.length; i += 3) {
      const q = track.samplePoints[i];
      best = Math.min(best, (q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    }
    return Math.sqrt(best);
  };

  // A peak dead ahead of the finish line would sit on top of the road from
  // the rider's view; keep a clear sector in the finish direction.
  const finishU = track.finishDistance / track.totalLength;
  const finishPoint = track.curve.getPointAt(finishU);
  const finishHeading = track.curve.getTangentAt(finishU);
  const clearAngle = Math.atan2(
    finishPoint.z + finishHeading.z * radius - centerZ,
    finishPoint.x + finishHeading.x * radius - centerX,
  );

  for (let i = 0; i < peakCount; i++) {
    const angle = (i / peakCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
    let off = Math.abs(angle - clearAngle) % (Math.PI * 2);
    if (off > Math.PI) off = Math.PI * 2 - off;
    if (off < PEAK_FINISH_CLEARANCE) continue;
    let r = radius * (0.9 + Math.random() * 0.3);
    // Broad and not too steep: a range, not a row of spikes.
    let width = 380 + Math.random() * 380;
    const height = 130 + Math.random() * 220;
    // A mountain's foot is as wide as the mountain, so on a compact course a broad one could stand right over the
    // road. Push it outward until its foot stands clear of every road, and narrow it if that is not enough.
    const at = (distance: number): void => {
      position.set(centerX + Math.cos(angle) * distance, lowestY - 20, centerZ + Math.sin(angle) * distance);
    };
    at(r);
    for (let step = 0; step < 40 && nearestRoad(position) < width + PEAK_ROAD_CLEARANCE; step++) {
      r += 100;
      at(r);
    }
    width = Math.max(150, Math.min(width, nearestRoad(position) - PEAK_ROAD_CLEARANCE));
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    scale.set(width, height, width);
    matrix.compose(position, quaternion, scale);
    const mesh = peaks[Math.floor(Math.random() * peaks.length)];
    mesh.setMatrixAt(mesh.count++, matrix);
  }
  for (const mesh of peaks) {
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  return group;
}

/**
 * One mountain, unit size (radius 1, height 1, base on y = 0): rings of vertices from a broken, ridged summit down to a
 * wide foot, pushed in and out by noise along the ridges so the slopes have spurs and gullies, and coloured by height
 * and slope: forest-grey foot, bare rock, then snow above a wobbling snowline, whiter on the flatter faces.
 */
function makeMountainGeometry(seed: number): THREE.BufferGeometry {
  const around = 18;
  const rings = 9;
  const rand = (n: number): number => {
    const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const smooth = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  // A little ridge noise round the mountain: spurs at a few angles, not a regular star.
  const spur = (angle: number, ring: number): number => {
    const a = (angle / (Math.PI * 2)) * around;
    const i = Math.floor(a);
    const f = a - i;
    const u = f * f * (3 - 2 * f);
    const k = (j: number): number => rand(((j + around) % around) + ring * 31);
    return k(i) + (k(i + 1) - k(i)) * u;
  };

  const positions: number[] = [0, 1, 0];
  const colours: number[] = [];
  const colour = new THREE.Color();
  const paint = (y: number, flat: number, n: number): void => {
    const foot = new THREE.Color(0.31, 0.4, 0.33);
    const rock = new THREE.Color(0.47, 0.48, 0.52);
    const snow = new THREE.Color(0.96, 0.97, 0.99);
    colour.copy(foot).lerp(rock, smooth(0.12, 0.5, y + n * 0.12));
    const snowline = 0.62 - flat * 0.1 + (n - 0.5) * 0.18;
    colour.lerp(snow, smooth(snowline, snowline + 0.14, y));
    colours.push(colour.r, colour.g, colour.b);
  };
  paint(1, 0.5, 0.5);
  for (let r = 1; r <= rings; r++) {
    const t = r / rings; // 0 at the summit, 1 at the foot
    for (let a = 0; a < around; a++) {
      const angle = (a / around) * Math.PI * 2;
      const n = spur(angle, r);
      // Slopes are steep high up and ease out toward the foot; the spurs push the outline in and out.
      const radius = Math.pow(t, 0.85) * (0.82 + 0.36 * n) + (r === rings ? 0.08 : 0);
      const y = Math.pow(1 - t, 1.25) * (0.9 + 0.2 * rand(a + r * 7));
      positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      paint(y, t, n);
    }
  }
  const indices: number[] = [];
  for (let a = 0; a < around; a++) indices.push(0, 1 + ((a + 1) % around), 1 + a);
  for (let r = 1; r < rings; r++) {
    for (let a = 0; a < around; a++) {
      const i0 = 1 + (r - 1) * around + a;
      const i1 = 1 + (r - 1) * around + ((a + 1) % around);
      const j0 = 1 + r * around + a;
      const j1 = 1 + r * around + ((a + 1) % around);
      indices.push(i0, i1, j0, i1, j1, j0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
