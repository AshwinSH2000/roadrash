import * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";
import { CITY_HALF_WIDTH, OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import type { GraphicsSettings } from "../settings/GraphicsSettings";
import { createFacadeTexture } from "../render/Textures";

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
  group.add(buildCityStreet(track, quality, disposers));
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
        position.y = center.y + GROUND_DROP;
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
        position.y = center.y + GROUND_DROP;
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
      position.y = center.y + GROUND_DROP;
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

  // A peak dead ahead of the finish line would sit on top of the road from
  // the rider's view; keep a clear sector in the finish direction.
  const finishU = track.finishDistance / track.totalLength;
  const finishPoint = track.curve.getPointAt(finishU);
  const finishHeading = track.curve.getTangentAt(finishU);
  const clearAngle = Math.atan2(
    finishPoint.z + finishHeading.z * radius - centerZ,
    finishPoint.x + finishHeading.x * radius - centerX,
  );

  let placed = 0;
  for (let i = 0; i < peakCount; i++) {
    const angle = (i / peakCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
    let off = Math.abs(angle - clearAngle) % (Math.PI * 2);
    if (off > Math.PI) off = Math.PI * 2 - off;
    if (off < PEAK_FINISH_CLEARANCE) continue;
    const r = radius * (0.9 + Math.random() * 0.3);
    position.set(centerX + Math.cos(angle) * r, lowestY - 20, centerZ + Math.sin(angle) * r);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    const width = 250 + Math.random() * 300;
    const height = 180 + Math.random() * 260;
    scale.set(width, height, width);
    matrix.compose(position, quaternion, scale);
    peaks.setMatrixAt(placed++, matrix);
  }
  peaks.count = placed;
  peaks.instanceMatrix.needsUpdate = true;
  group.add(peaks);

  return group;
}

/** Where the buildings' fronts stand, measured out from the centreline: just behind the onlookers and parked cars. */
const BUILDING_FRONT = CITY_HALF_WIDTH + 5.5;
const BUILDING_DEPTH = 14;
const BUILDING_WIDTHS = [9, 13] as const;
const BUILDING_HEIGHTS = [12, 19, 28] as const;
/** Metres of wall one repeat of the facade texture covers. */
const FACADE_TILE = 4;
/** How far the foundations reach below the street, so a building never stands on air where the ground falls away. */
const FOUNDATION = 3;
const FACADE_TINTS = [0xf0e6d6, 0xc98a6a, 0xd9c19a, 0xbfc3c7, 0xe3c07a, 0xa9b4bd];

/** A box whose side faces carry the facade texture at a fixed scale (windows the same size on every building), roof and floor plain. */
function facadeBox(width: number, height: number, depth: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height + FOUNDATION, depth);
  geometry.translate(0, (height - FOUNDATION) / 2, 0);
  const uv = geometry.getAttribute("uv");
  // BoxGeometry orders its faces +x, -x, +y, -y, +z, -z, four vertices each.
  const faceWidths = [depth, depth, 1, 1, width, width];
  for (let face = 0; face < 6; face++) {
    for (let k = 0; k < 4; k++) {
      const n = face * 4 + k;
      if (face === 2 || face === 3) uv.setXY(n, 0.02, 0.02);
      else uv.setXY(n, (uv.getX(n) * faceWidths[face]) / FACADE_TILE, (uv.getY(n) * (height + FOUNDATION)) / FACADE_TILE);
    }
  }
  return geometry;
}

/**
 * The town: unbroken rows of windowed buildings on both sides of the street,
 * set back behind the pavement, the onlookers and the parked cars, as a city
 * street looks from the saddle. Buildings are placed end to end along the
 * course wherever it is in a town, in a few widths and heights, each tinted
 * its own colour; where the road bends tightly the inside row is left open
 * rather than letting buildings pile into each other. Behind the front row a
 * sparse second row of taller blocks shows between the gaps.
 */
function buildCityStreet(
  track: TrackDefinition,
  quality: GraphicsSettings,
  disposers: Array<() => void>,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "city-street";

  interface Placement { variant: number; position: THREE.Vector3; facing: THREE.Vector3; tint: number }
  const placements: Placement[] = [];
  const variantOf = (w: number, h: number): number => BUILDING_WIDTHS.indexOf(w as 9 | 13) * BUILDING_HEIGHTS.length + BUILDING_HEIGHTS.indexOf(h as 12 | 19 | 28);
  const fill = Math.min(1, 0.55 + quality.sceneryDensity * 0.5);
  const slope = (lateral: number): number => GROUND_DROP * ((lateral - 7) / (OFFROAD_HALF_WIDTH - 7));
  const right = new THREE.Vector3();
  const facing = new THREE.Vector3();

  for (const side of [-1, 1] as const) {
    let distance = 0;
    while (distance < track.totalLength) {
      const width = BUILDING_WIDTHS[Math.floor(Math.random() * BUILDING_WIDTHS.length)];
      const index = track.sampleIndexAt(distance + width / 2);
      if (track.biomeAt(distance + width / 2) !== "city" || track.segmentInFeature(index, undefined, true)) {
        distance += 12;
        continue;
      }
      const advance = width + 0.6 + Math.random() * 1.2;
      const height = BUILDING_HEIGHTS[Math.floor(Math.random() * BUILDING_HEIGHTS.length)];
      // Which side of the road is the inside of the bend here?
      right.copy(track.sampleRights[index]);
      const behind = track.sampleTangents[Math.max(0, index - 6)];
      const ahead = track.sampleTangents[Math.min(track.sampleTangents.length - 1, index + 6)];
      const innerSide = ahead.clone().sub(behind).dot(right) > 0 ? 1 : -1;
      const lateral = BUILDING_FRONT + BUILDING_DEPTH / 2;
      const crowded = side === innerSide && track.sampleRadii[index] < (lateral + BUILDING_DEPTH / 2 + 4) * 1.1;
      if (!crowded && Math.random() < fill) {
        const position = track.samplePoints[index].clone().addScaledVector(right, side * lateral);
        position.y += slope(BUILDING_FRONT);
        facing.copy(right).multiplyScalar(-side).setY(0).normalize();
        const tint = FACADE_TINTS[Math.floor(Math.random() * FACADE_TINTS.length)];
        placements.push({ variant: variantOf(width, height), position, facing: facing.clone(), tint });
        // A taller block behind the gap, now and then.
        if (Math.random() < 0.18) {
          const back = position.clone().addScaledVector(right, side * (BUILDING_DEPTH + 10 + Math.random() * 8));
          placements.push({ variant: variantOf(13, 28), position: back, facing: facing.clone(), tint: FACADE_TINTS[Math.floor(Math.random() * FACADE_TINTS.length)] });
        }
      }
      distance += advance;
    }
  }
  if (placements.length === 0) return group;

  const facade = createFacadeTexture();
  const wall = new THREE.MeshStandardMaterial({ map: facade, color: 0xffffff, roughness: 0.9 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x5c5a57, roughness: 1 });
  disposers.push(() => {
    wall.dispose();
    roof.dispose();
    facade?.dispose();
  });
  const materials = [wall, wall, roof, roof, wall, wall];

  const variants: THREE.InstancedMesh[] = [];
  BUILDING_WIDTHS.forEach((w) => BUILDING_HEIGHTS.forEach((h) => {
    const list = placements.filter((p) => p.variant === variantOf(w, h));
    if (list.length === 0) return;
    const geometry = facadeBox(w, h, BUILDING_DEPTH);
    disposers.push(() => geometry.dispose());
    const mesh = new THREE.InstancedMesh(geometry, materials, list.length);
    mesh.name = `city-buildings-${w}x${h}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const unit = new THREE.Vector3(1, 1, 1);
    const colour = new THREE.Color();
    list.forEach((p, n) => {
      // The front (+Z) faces the street.
      quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.facing);
      matrix.compose(p.position, quaternion, unit);
      mesh.setMatrixAt(n, matrix);
      mesh.setColorAt(n, colour.setHex(p.tint));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    variants.push(mesh);
  }));
  group.add(...variants);
  return group;
}
