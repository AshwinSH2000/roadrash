import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import { OFFROAD_SURFACE, ROAD_SURFACE, SAND_SURFACE, SurfaceRegistry, WATER_SURFACE } from "../physics/TerrainMaterial";
import { CITY_HALF_WIDTH, OFFROAD_HALF_WIDTH, ROAD_HALF_WIDTH, TrackDefinition } from "./TrackDefinition";
import { GROUPS_FINISH_SENSOR, GROUPS_TERRAIN } from "../physics/CollisionGroups";
import {
  createAsphaltTexture,
  createCliffTexture,
  createDirtTexture,
  createGrassTexture,
  createPavementTexture,
  createSandTexture,
  createWaterTexture,
} from "../render/Textures";
import { LoopGeometry, type TrackFeature } from "./TrackFeatures";
import type { LampRegistry } from "./LampRegistry";
import { buildBoundaryWalls } from "./Boundary";
import { buildBillboards, buildCurveSigns, buildStartLight, buildStreetLamps, type StartLightState } from "./Roadside";

/**
 * Turns a `TrackDefinition` spline into actual geometry: a road ribbon and
 * flanking off-road terrain, each with a matching Rapier trimesh collider,
 * plus lane markings and a finish-line sensor.
 *
 * Road and off-road are separate colliders on purpose — that's what lets
 * `SurfaceRegistry` tell them apart when a wheel reports what it's resting on.
 */

// Road/off-road colour now comes from `Textures.ts`'s procedural maps. These
// are the fallback flat fills for the headless sims, which run under Node
// with no `<canvas>` to build those maps from — see that file's comment.
const ROAD_FALLBACK_COLOR = 0x3c3f44;
const OFFROAD_FALLBACK_COLOR = 0x4a7c3f;
const MARKING_COLOR = 0xf0f0e8;
const SAND_FALLBACK_COLOR = 0xd8bf86;

/** Lane markings sit fractionally above the road to avoid z-fighting with it. */
const MARKING_LIFT = 0.02;
/** The outer edge of the off-road band drops away, so terrain reads as falling off rather than as a flat carpet. */
const OFFROAD_OUTER_DROP = -2.5;
const YELLOW_LINE_COLOR = 0xe8b923;
/** Width of the dirt shoulder along the edge of the asphalt, away from towns. */
const SHOULDER_WIDTH = 2.4;
/** Width of the kerb, and then the pavement, along the edge of the asphalt in towns. */
const KERB_WIDTH = 0.35;

interface BandSpec {
  /** Signed lateral offsets from the centerline, in metres (negative = track-left). */
  innerLateral: number;
  outerLateral: number;
  /** Vertical offsets applied at each edge, in metres. */
  innerLift?: number;
  outerLift?: number;
  /** Track distance covered by one V-repeat of the UVs, in metres. */
  uvRepeatLength?: number;
  /** Adds an `aLateral` attribute: distance from the centreline in metres, for the winter snow grading. */
  lateralAttr?: boolean;
  /** Return false to omit a segment entirely — used to make dashed markings. */
  segmentFilter?: (segmentIndex: number) => boolean;
}

interface BandGeometry {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  indices: Uint32Array;
}

export interface BuiltTrack {
  /** Per-frame animation of the scenery that moves (the river). `seconds` is any steadily increasing clock. */
  animate: (seconds: number) => void;
  /** Sets the traffic light by the start line. */
  setStartLight: (state: StartLightState) => void;
  group: THREE.Group;
  roadCollider: RAPIER.Collider;
  offroadColliders: RAPIER.Collider[];
  finishSensor: RAPIER.Collider;
}

/**
 * Builds one ribbon of geometry running the length of the track between two
 * lateral offsets.
 */
function buildBand(track: TrackDefinition, spec: BandSpec): BandGeometry {
  const {
    innerLateral,
    outerLateral,
    innerLift = 0,
    outerLift = 0,
    uvRepeatLength = 10,
    lateralAttr = false,
    segmentFilter,
  } = spec;

  const count = track.sampleCount;
  const positions: number[] = [];
  const uvs: number[] = [];
  const laterals: number[] = [];
  const indices: number[] = [];

  // Sample index -> index of its first emitted vertex, or -1 if not emitted.
  const vertexRowStart = new Int32Array(count).fill(-1);

  const emitRow = (sampleIndex: number): number => {
    const existing = vertexRowStart[sampleIndex];
    if (existing >= 0) return existing;

    const center = track.samplePoints[sampleIndex];
    const right = track.sampleRights[sampleIndex];
    const distance = track.sampleDistances[sampleIndex];

    const rowStart = positions.length / 3;
    positions.push(
      center.x + right.x * innerLateral,
      center.y + right.y * innerLateral + innerLift,
      center.z + right.z * innerLateral,
    );
    positions.push(
      center.x + right.x * outerLateral,
      center.y + right.y * outerLateral + outerLift,
      center.z + right.z * outerLateral,
    );

    const v = distance / uvRepeatLength;
    uvs.push(0, v, 1, v);
    if (lateralAttr) laterals.push(Math.abs(innerLateral), Math.abs(outerLateral));

    vertexRowStart[sampleIndex] = rowStart;
    return rowStart;
  };

  for (let seg = 0; seg < count - 1; seg++) {
    if (segmentFilter && !segmentFilter(seg)) continue;
    const a = emitRow(seg);
    const b = emitRow(seg + 1);
    indices.push(a, b, a + 1);
    indices.push(a + 1, b, b + 1);
  }

  // Every band in this game is a roughly horizontal ribbon, so its normals
  // must point up; if they don't, the surface renders unlit and backface-
  // culled — i.e. the road vanishes and you can see through it.
  //
  // This used to be decided from the sign of `outerLateral - innerLateral`,
  // which was a guess about geometry made from parameters. It broke the
  // moment the meaning of "right" was corrected in utils/Directions: the
  // lateral numbers were unchanged but every vertex moved to the other side
  // of the centreline, inverting all the winding at once. Measuring the
  // geometry that was actually built cannot go wrong that way.
  ensureUpwardWinding(positions, indices);

  const positionArray = new Float32Array(positions);
  const indexArray = new Uint32Array(indices);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positionArray, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  if (lateralAttr) geometry.setAttribute("aLateral", new THREE.BufferAttribute(new Float32Array(laterals), 1));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeVertexNormals();

  return { geometry, positions: positionArray, indices: indexArray };
}

/**
 * Flips triangle winding in place if the surface faces downward. Decided from
 * the largest triangle available rather than the first one, since a dashed
 * band's leading triangle can be a near-degenerate sliver whose normal is
 * numerical noise.
 */
function ensureUpwardWinding(positions: number[], indices: number[]): void {
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  let bestArea = 0;
  let bestNormalY = 0;
  const vertexAt = (index: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);

  for (let i = 0; i < indices.length; i += 3) {
    vertexAt(indices[i], ax);
    vertexAt(indices[i + 1], bx);
    vertexAt(indices[i + 2], cx);
    edge1.subVectors(bx, ax);
    edge2.subVectors(cx, ax);
    normal.crossVectors(edge1, edge2);
    const area = normal.length();
    if (area > bestArea) {
      bestArea = area;
      bestNormalY = normal.y;
    }
  }

  if (bestArea === 0 || bestNormalY >= 0) return;
  for (let i = 0; i < indices.length; i += 3) {
    const swap = indices[i + 1];
    indices[i + 1] = indices[i + 2];
    indices[i + 2] = swap;
  }
}

/**
 * Marks a mesh as a swept ribbon whose normals must face upward, so the
 * headless check in `scripts/race-sim.ts` can tell them apart from the boxes
 * (line markers, gantry) whose normals correctly average to zero.
 */
function markAsBand(mesh: THREE.Mesh, name: string): THREE.Mesh {
  mesh.name = name;
  mesh.userData.isTrackBand = true;
  return mesh;
}

/**
 * Builds a terrain material from a procedural texture, or `fallbackColor`
 * flat when `texture` is `null` (headless sims — see `Textures.ts`). `map`
 * is assigned after construction rather than passed alongside `undefined` in
 * the constructor params, which is what Three's Material constructor logs a
 * console warning about.
 */
function terrainMaterial(
  texture: THREE.Texture | null,
  fallbackColor: number,
  roughness: number,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: texture ? 0xffffff : fallbackColor,
    roughness,
    metalness: 0.0,
  });
  if (texture) material.map = texture;
  return material;
}

/** Metres of real height one cliff-texture tile covers, vertically down the skirt. */
const CLIFF_VERTICAL_TILE = 3;
/** Metres of track distance one cliff-texture tile covers, along the skirt. */
const CLIFF_ALONG_TILE = 6;

/**
 * A visible "cliff" skirt connecting the off-road band's dropped outer edge
 * down to the ground-fill plane far below, on both sides of the track.
 *
 * Requested directly, after the invisible boundary wall went in: on any
 * stretch where the track runs well above the course's single lowest point
 * (which is where the flat ground-fill plane is pinned — see that block's
 * comment below), there was nothing rendered in the gap between the
 * off-road edge and that plane, so the sky showed straight through it close
 * to the player, low in the frame — read as "is this sky, water, or
 * unfinished" rather than as the edge of the world. This closes that gap
 * with a textured surface that shares the off-road band's own outer-edge
 * X/Z and top Y (so there's no seam), varying in height per sample the way
 * the gap itself does — tall on a climb, a thin sliver at the course's
 * lowest point.
 *
 * Built as its own swept ribbon rather than by generalising `buildBand`:
 * its bottom edge isn't a fixed offset from the local sample the way every
 * other band's edges are — it's pinned to one global absolute height
 * (`groundFillY`) — which `BandSpec`'s per-call (not per-sample) lift can't
 * express. Visual only (no collider — the boundary wall already stops
 * anything physical well before here), so unlike the road/off-road bands,
 * winding doesn't need to be measured and corrected: the material is simply
 * double-sided.
 */
function buildCliffSkirt(track: TrackDefinition, groundFillY: number): THREE.Mesh {
  // The skirt has no business under a loop: the road there is a shadow.
  const count = track.sampleCount;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const side of [-1, 1] as const) {
    const base = positions.length / 3;
    for (let i = 0; i < count; i++) {
      const center = track.samplePoints[i];
      const right = track.sampleRights[i];
      const topY = center.y + OFFROAD_OUTER_DROP;
      const height = Math.max(0.1, topY - groundFillY);

      const x = center.x + right.x * side * OFFROAD_HALF_WIDTH;
      const z = center.z + right.z * side * OFFROAD_HALF_WIDTH;
      positions.push(x, topY, z, x, groundFillY, z);

      const v = track.sampleDistances[i] / CLIFF_ALONG_TILE;
      uvs.push(0, v, height / CLIFF_VERTICAL_TILE, v);
    }

    for (let i = 0; i < count - 1; i++) {
      if (track.segmentInFeature(i, "loop", true)) continue;
      const a = base + i * 2;
      const b = base + (i + 1) * 2;
      indices.push(a, b, a + 1);
      indices.push(a + 1, b, b + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = terrainMaterial(createCliffTexture(), 0x7a6a58, 1.0);
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "boundary-cliff";
  mesh.receiveShadow = true;
  return mesh;
}

function addTrimeshCollider(
  physics: PhysicsWorld,
  body: RAPIER.RigidBody,
  band: BandGeometry,
  friction: number,
): RAPIER.Collider {
  return physics.world.createCollider(
    RAPIER.ColliderDesc.trimesh(band.positions, band.indices)
      .setFriction(friction)
      .setCollisionGroups(GROUPS_TERRAIN),
    body,
  );
}

export function buildTrack(
  physics: PhysicsWorld,
  scene: THREE.Scene,
  track: TrackDefinition,
  surfaces: SurfaceRegistry,
  lamps: LampRegistry = { lit: false, positions: [] },
): BuiltTrack {
  const group = new THREE.Group();
  scene.add(group);

  const staticBody = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // --- Road surface ------------------------------------------------------
  // `uvRepeatLength` here is in metres of *track distance* per V-repeat, and
  // is deliberately set to match `createAsphaltTexture`'s own tile size (see
  // its comment) rather than an arbitrary "looks about right" number, so the
  // two stay in lockstep if either is retuned.
  const roadTileMetres = 2.5;
  const roadBand = buildBand(track, {
    innerLateral: -ROAD_HALF_WIDTH,
    outerLateral: ROAD_HALF_WIDTH,
    uvRepeatLength: roadTileMetres,
    lateralAttr: true,
    segmentFilter: (seg) => !track.segmentInFeature(seg),
  });
  const roadMaterial = terrainMaterial(createAsphaltTexture(ROAD_HALF_WIDTH * 2), ROAD_FALLBACK_COLOR, 0.95);
  // Winter: only lightly dusted, so the road still reads against the snow around it (`render/Environment.ts`).
  roadMaterial.userData.snowTrack = true;
  const roadMesh = new THREE.Mesh(roadBand.geometry, roadMaterial);
  roadMesh.receiveShadow = true;
  group.add(markAsBand(roadMesh, "road"));
  const roadCollider = addTrimeshCollider(physics, staticBody, roadBand, 1.0);
  surfaces.register(roadCollider, ROAD_SURFACE);

  // --- Sand pits -----------------------------------------------------------
  // The same road ribbon over the sand's segments, with its own surface: a
  // separate collider is what lets a wheel report "sand" and lose its grip.
  const sandFeatures = track.featuresOfKind("sand");
  if (sandFeatures.length > 0) {
    const sandBand = buildBand(track, {
      innerLateral: -ROAD_HALF_WIDTH,
      outerLateral: ROAD_HALF_WIDTH,
      uvRepeatLength: roadTileMetres,
      segmentFilter: (seg) => track.segmentInFeature(seg, "sand"),
    });
    const sandMesh = new THREE.Mesh(sandBand.geometry, terrainMaterial(createSandTexture(ROAD_HALF_WIDTH * 2), SAND_FALLBACK_COLOR, 1.0));
    sandMesh.receiveShadow = true;
    group.add(markAsBand(sandMesh, "sand"));
    const sandCollider = addTrimeshCollider(physics, staticBody, sandBand, 0.6);
    surfaces.register(sandCollider, SAND_SURFACE);
  }

  // --- Off-road terrain, one band each side ------------------------------
  const offroadTileMetres = 2;
  const offroadBandWidth = OFFROAD_HALF_WIDTH - ROAD_HALF_WIDTH;
  const offroadMaterial = terrainMaterial(
    createGrassTexture(offroadBandWidth),
    OFFROAD_FALLBACK_COLOR,
    1.0,
  );
  offroadMaterial.userData.snowTrack = true;
  const offroadColliders: RAPIER.Collider[] = [];
  for (const side of [-1, 1] as const) {
    const band = buildBand(track, {
      innerLateral: side * ROAD_HALF_WIDTH,
      outerLateral: side * OFFROAD_HALF_WIDTH,
      outerLift: OFFROAD_OUTER_DROP,
      uvRepeatLength: offroadTileMetres,
      lateralAttr: true,
      segmentFilter: (seg) => !track.segmentInFeature(seg, "river", true) && !track.segmentInFeature(seg, "loop", true),
    });
    const mesh = new THREE.Mesh(band.geometry, offroadMaterial);
    mesh.receiveShadow = true;
    group.add(markAsBand(mesh, `offroad-${side < 0 ? "left" : "right"}`));

    const collider = addTrimeshCollider(physics, staticBody, band, 0.85);
    surfaces.register(collider, OFFROAD_SURFACE);
    offroadColliders.push(collider);
  }

  // --- Ground fill, well past the off-road band ---------------------------
  // Purely a backdrop: the off-road band above is the last real terrain (see
  // TODO.md's "world edge" note) — beyond it there was nothing, so the world
  // read as a road floating over flat sky-blue the moment you looked
  // sideways or into the distance. This is visual only (no collider, no
  // `surfaces.register`): a rider out here is already well past anywhere the
  // "stuck"/rescue system tolerates, and giving it real collision would be
  // pure triangle count for a case nothing is meant to reach.
  //
  // This used to be a band swept along the track, as wide as the road bands
  // above. That doesn't work: the self-clearance check (TrackValidator) only
  // guarantees the road and off-road bands stay clear of each other, not a
  // fill hundreds of metres wide, so on any course that curves back near
  // itself — which is most of them — the fill swept from one stretch cut
  // across whatever *other* stretch happened to pass nearby in world space.
  // That rendered as grass laid over the real road (Ridgeway) or a shelf of
  // "ground" at head height where the fill from the base of a climb reached
  // across to the crest (Hillclimb). A single flat plane, pinned below the
  // lowest point the course ever reaches, can't rise into anything the
  // course actually uses no matter how it loops.
  const GROUND_FILL_HALF_EXTENT = 4000;
  const GROUND_FILL_DROP_MARGIN = 3;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let lowestPoint = Infinity;
  for (const p of track.samplePoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    if (p.y < lowestPoint) lowestPoint = p.y;
  }
  // Below the lowest point any off-road outer edge ever reaches, anywhere on
  // the course — see the block comment above for why "anywhere" matters.
  const groundFillY = lowestPoint + OFFROAD_OUTER_DROP - GROUND_FILL_DROP_MARGIN;

  const groundFillTexture = createGrassTexture(GROUND_FILL_HALF_EXTENT * 2);
  if (groundFillTexture) groundFillTexture.repeat.y = groundFillTexture.repeat.x;
  const groundFillMaterial = terrainMaterial(groundFillTexture, OFFROAD_FALLBACK_COLOR, 1.0);
  const groundFillGeometry = new THREE.PlaneGeometry(GROUND_FILL_HALF_EXTENT * 2, GROUND_FILL_HALF_EXTENT * 2);
  groundFillGeometry.rotateX(-Math.PI / 2);
  const groundFillMesh = new THREE.Mesh(groundFillGeometry, groundFillMaterial);
  groundFillMesh.position.set((minX + maxX) / 2, groundFillY, (minZ + maxZ) / 2);
  groundFillMesh.receiveShadow = true;
  groundFillMesh.name = "ground-fill";
  group.add(groundFillMesh);

  // --- Boundary cliff (visual) ---------------------------------------------
  // Fills the gap between the off-road edge and the ground fill below it —
  // see buildCliffSkirt for why that gap read as an unfinished sky-coloured
  // hole rather than an edge of the world.
  group.add(buildCliffSkirt(track, groundFillY));

  // --- Boundary wall -------------------------------------------------------
  // Invisible — stops a rider drifting past the off-road band from falling
  // through into the void beyond it. See Boundary.ts for why.
  buildBoundaryWalls(physics, staticBody, track);

  // --- Lane markings -----------------------------------------------------
  const markingMaterial = new THREE.MeshStandardMaterial({
    color: MARKING_COLOR,
    roughness: 0.8,
  });

  for (const side of [-1, 1] as const) {
    const edgeLine = buildBand(track, {
      innerLateral: side * (ROAD_HALF_WIDTH - 0.55),
      outerLateral: side * (ROAD_HALF_WIDTH - 0.25),
      innerLift: MARKING_LIFT,
      outerLift: MARKING_LIFT,
      segmentFilter: (seg) => !track.segmentInFeature(seg),
    });
    group.add(
      markAsBand(
        new THREE.Mesh(edgeLine.geometry, markingMaterial),
        `edge-line-${side < 0 ? "left" : "right"}`,
      ),
    );
  }

  // Centre: a solid double yellow line, as on any two-way road, and white dashed lane lines
  // a quarter of the way in from each edge. Dashes: samples are ~3 m apart, so 2 on / 3 off
  // gives roughly a 6 m dash with a 9 m gap.
  const yellowMaterial = new THREE.MeshStandardMaterial({ color: YELLOW_LINE_COLOR, roughness: 0.8 });
  for (const side of [-1, 1] as const) {
    const yellow = buildBand(track, {
      innerLateral: side * 0.12,
      outerLateral: side * 0.32,
      innerLift: MARKING_LIFT,
      outerLift: MARKING_LIFT,
      segmentFilter: (seg) => !track.segmentInFeature(seg),
    });
    group.add(markAsBand(new THREE.Mesh(yellow.geometry, yellowMaterial), `centre-line-${side < 0 ? "left" : "right"}`));
  }
  for (const side of [-1, 1] as const) {
    const lane = buildBand(track, {
      innerLateral: side * (ROAD_HALF_WIDTH / 2 - 0.1),
      outerLateral: side * (ROAD_HALF_WIDTH / 2 + 0.1),
      innerLift: MARKING_LIFT,
      outerLift: MARKING_LIFT,
      segmentFilter: (seg) => seg % 5 < 2 && !track.segmentInFeature(seg),
    });
    group.add(markAsBand(new THREE.Mesh(lane.geometry, markingMaterial), `lane-line-${side < 0 ? "left" : "right"}`));
  }

  // --- Shoulder, kerb and pavement ---------------------------------------
  // Visual strips laid on the off-road band along the asphalt's edge, following its slope:
  // packed dirt in the country, a kerb and paving in towns. The grip underneath is the
  // off-road band's, as before; this is only what it looks like.
  const stripSegment = (city: boolean) => (seg: number): boolean =>
    !track.segmentInFeature(seg, "river", true) &&
    !track.segmentInFeature(seg, "loop", true) &&
    (track.biomeAt(track.sampleDistances[seg]) === "city") === city;
  const slope = (lateral: number): number => OFFROAD_OUTER_DROP * ((lateral - ROAD_HALF_WIDTH) / (OFFROAD_HALF_WIDTH - ROAD_HALF_WIDTH));
  const dirtTexture = createDirtTexture(SHOULDER_WIDTH);
  const dirtMaterial = terrainMaterial(dirtTexture, 0x7a5a3c, 1.0);
  const pavementWidth = CITY_HALF_WIDTH - ROAD_HALF_WIDTH - KERB_WIDTH;
  const pavementMaterial = terrainMaterial(createPavementTexture(pavementWidth), 0x9a9a96, 0.95);
  const kerbMaterial = new THREE.MeshStandardMaterial({ color: 0xc9c7c0, roughness: 0.9 });
  // Winter: the strips beside the asphalt are 70% snow, between the road (30%) and the open ground (100%).
  for (const m of [dirtMaterial, pavementMaterial, kerbMaterial]) m.userData.snowTrack = true;
  for (const side of [-1, 1] as const) {
    const name = side < 0 ? "left" : "right";
    const dirt = buildBand(track, {
      innerLateral: side * ROAD_HALF_WIDTH,
      outerLateral: side * (ROAD_HALF_WIDTH + SHOULDER_WIDTH),
      innerLift: 0.03,
      outerLift: slope(ROAD_HALF_WIDTH + SHOULDER_WIDTH) + 0.03,
      uvRepeatLength: 2,
      lateralAttr: true,
      segmentFilter: stripSegment(false),
    });
    const dirtMesh = new THREE.Mesh(dirt.geometry, dirtMaterial);
    dirtMesh.receiveShadow = true;
    group.add(markAsBand(dirtMesh, `shoulder-${name}`));

    const kerb = buildBand(track, {
      innerLateral: side * ROAD_HALF_WIDTH,
      outerLateral: side * (ROAD_HALF_WIDTH + KERB_WIDTH),
      innerLift: 0.05,
      outerLift: slope(ROAD_HALF_WIDTH + KERB_WIDTH) + 0.05,
      uvRepeatLength: 2,
      lateralAttr: true,
      segmentFilter: stripSegment(true),
    });
    group.add(markAsBand(new THREE.Mesh(kerb.geometry, kerbMaterial), `kerb-${name}`));
    const pavement = buildBand(track, {
      innerLateral: side * (ROAD_HALF_WIDTH + KERB_WIDTH),
      outerLateral: side * CITY_HALF_WIDTH,
      innerLift: 0.04,
      outerLift: slope(CITY_HALF_WIDTH) + 0.04,
      uvRepeatLength: 2,
      lateralAttr: true,
      segmentFilter: stripSegment(true),
    });
    const pavementMesh = new THREE.Mesh(pavement.geometry, pavementMaterial);
    pavementMesh.receiveShadow = true;
    group.add(markAsBand(pavementMesh, `pavement-${name}`));
  }

  // --- Roadside: curve signs and the start light ----------------------------
  const roadsideDisposers: Array<() => void> = [];
  group.add(buildCurveSigns(track, roadsideDisposers));
  const startLight = buildStartLight(track, roadsideDisposers);
  group.add(startLight.group);
  group.add(buildStreetLamps(track, roadsideDisposers, lamps));
  group.add(buildBillboards(track, roadsideDisposers));

  // --- Start and finish line markings ------------------------------------
  group.add(buildLineMarker(track, track.startDistance, 0x2f6fd0));
  group.add(buildLineMarker(track, track.finishDistance, 0xd02f2f));
  group.add(buildFinishGantry(track));

  // --- Finish sensor -----------------------------------------------------
  const finishU = track.finishDistance / track.totalLength;
  const finishPoint = track.curve.getPointAt(finishU);
  const finishTangent = track.curve.getTangentAt(finishU).normalize();
  const finishQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    finishTangent,
  );
  const finishSensor = physics.world.createCollider(
    RAPIER.ColliderDesc
      // Spans the full road width, tall enough that a jumping rider still
      // trips it, and thin along the direction of travel.
      .cuboid(ROAD_HALF_WIDTH, 6, 0.5)
      .setSensor(true)
      .setCollisionGroups(GROUPS_FINISH_SENSOR)
      .setTranslation(finishPoint.x, finishPoint.y + 5, finishPoint.z)
      .setRotation({ x: finishQuat.x, y: finishQuat.y, z: finishQuat.z, w: finishQuat.w }),
    staticBody,
  );

  // --- Stunt features ------------------------------------------------------
  const animators: ((seconds: number) => void)[] = [];
  for (const feature of track.features) {
    if (feature.kind === "river") animators.push(buildRiver(physics, staticBody, surfaces, group, track, feature, groundFillY));
    if (feature.kind === "loop" && feature.loop) buildLoop(physics, staticBody, surfaces, group, feature.loop);
  }

  return {
    group,
    roadCollider,
    offroadColliders,
    finishSensor,
    animate: (seconds) => animators.forEach((animate) => animate(seconds)),
    setStartLight: (state) => startLight.set(state),
  };
}

/** Where a sample's road, off-road edges and ground sit across the track, as lateral offsets and heights above the centre. */
const PROFILE_LATERAL = [-OFFROAD_HALF_WIDTH, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, OFFROAD_HALF_WIDTH];
const PROFILE_DROP = [OFFROAD_OUTER_DROP, 0, 0, OFFROAD_OUTER_DROP];

/** A vertical face under the ground profile at one sample, straight down to `bottomY` — the wall of the river's canyon. */
function buildProfileWall(track: TrackDefinition, sampleIndex: number, bottomY: number): THREE.Mesh {
  const center = track.samplePoints[sampleIndex];
  const right = track.sampleRights[sampleIndex];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  PROFILE_LATERAL.forEach((lateral, i) => {
    const x = center.x + right.x * lateral;
    const z = center.z + right.z * lateral;
    const topY = center.y + PROFILE_DROP[i];
    positions.push(x, topY, z, x, bottomY, z);
    const u = (lateral + OFFROAD_HALF_WIDTH) / CLIFF_ALONG_TILE;
    uvs.push(u, 0, u, Math.max(0.1, topY - bottomY) / CLIFF_VERTICAL_TILE);
  });
  for (let i = 0; i < PROFILE_LATERAL.length - 1; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = terrainMaterial(createCliffTexture(), 0x7a6a58, 1.0);
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "river-wall";
  return mesh;
}

/**
 * The river under a gap in the road: a canyon floor, the walls where the road
 * ends, flowing water, and a solid bed that stops a bike that fell short.
 * Returns the water's animation.
 */
function buildRiver(
  physics: PhysicsWorld,
  body: RAPIER.RigidBody,
  surfaces: SurfaceRegistry,
  group: THREE.Group,
  track: TrackDefinition,
  feature: TrackFeature,
  groundFillY: number,
): (seconds: number) => void {
  const a = track.samplePoints[feature.startIndex];
  const b = track.samplePoints[feature.endIndex];
  const gapLength = Math.hypot(b.x - a.x, b.z - a.z);
  const heading = Math.atan2(b.x - a.x, b.z - a.z);
  const centerX = (a.x + b.x) / 2;
  const centerZ = (a.z + b.z) / 2;
  const width = OFFROAD_HALF_WIDTH * 2;
  const bedY = groundFillY + 0.35;
  const waterY = bedY + 1.6;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);

  group.add(buildProfileWall(track, feature.startIndex, bedY));
  group.add(buildProfileWall(track, feature.endIndex, bedY));

  // Solid bed, a little longer than the gap so a bike dropping off a lip
  // lands on it rather than skimming past its edge.
  const bedCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(width / 2, 0.5, gapLength / 2 + 3)
      .setTranslation(centerX, bedY - 0.5, centerZ)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setFriction(0.5)
      .setCollisionGroups(GROUPS_TERRAIN),
    body,
  );
  surfaces.register(bedCollider, WATER_SURFACE);

  const bedGeometry = new THREE.PlaneGeometry(width, gapLength + 6);
  bedGeometry.rotateX(-Math.PI / 2);
  const bed = new THREE.Mesh(bedGeometry, new THREE.MeshStandardMaterial({ color: 0x5b4a38, roughness: 1 }));
  bed.position.set(centerX, bedY, centerZ);
  bed.quaternion.copy(q);
  group.add(bed);

  const waterTexture = createWaterTexture();
  if (waterTexture) waterTexture.repeat.set(width / 8, (gapLength + 6) / 8);
  const waterMaterial = new THREE.MeshStandardMaterial({
    color: waterTexture ? 0xffffff : 0x2f6f86,
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
  });
  if (waterTexture) waterMaterial.map = waterTexture;
  const waterGeometry = new THREE.PlaneGeometry(width, gapLength + 6);
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.position.set(centerX, waterY, centerZ);
  water.quaternion.copy(q);
  water.name = "river-water";
  group.add(water);

  // The river runs across the road, along the plane's own X axis.
  return (seconds) => {
    if (waterTexture) waterTexture.offset.x = -seconds * 0.12;
  };
}

/** How many segments a loop ribbon is cut into around its full turn. */
const LOOP_SEGMENTS = 120;

/**
 * A strip following the loop between two lateral offsets (`lift` along the
 * ribbon's inward normal), with its winding facing the rider.
 */
function buildLoopStrip(loop: LoopGeometry, innerLateral: number, outerLateral: number, lift: number, uvRepeat: number): BandGeometry {
  const frame = LoopGeometry.createFrame();
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let travelled = 0;
  for (let i = 0; i <= LOOP_SEGMENTS; i++) {
    const t = (i / LOOP_SEGMENTS) * Math.PI * 2;
    loop.frame(t, frame);
    if (i > 0) travelled += (frame.speedFactor * Math.PI * 2) / LOOP_SEGMENTS;
    for (const lateral of [innerLateral, outerLateral]) {
      positions.push(
        frame.position.x + loop.across.x * lateral + frame.normal.x * lift,
        frame.position.y + loop.across.y * lateral + frame.normal.y * lift,
        frame.position.z + loop.across.z * lateral + frame.normal.z * lift,
      );
    }
    const v = travelled / uvRepeat;
    uvs.push(0, v, 1, v);
  }
  for (let i = 0; i < LOOP_SEGMENTS; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }

  // Face the rider: compare the first triangle's normal with the ribbon's.
  const p = (index: number): THREE.Vector3 => new THREE.Vector3(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
  const first = new THREE.Vector3()
    .crossVectors(p(indices[1]).sub(p(indices[0])), p(indices[2]).sub(p(indices[0])));
  loop.frame(0, frame);
  if (first.dot(frame.normal) < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const swap = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = swap;
    }
  }

  const positionArray = new Float32Array(positions);
  const indexArray = new Uint32Array(indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positionArray, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeVertexNormals();
  return { geometry, positions: positionArray, indices: indexArray };
}

/**
 * The loop itself: asphalt ribbon with edge lines (and a collider, so the
 * wheel rays see a road to draw against and a rider who comes off lands on
 * something), support pillars, and the ground under it that the bands leave
 * bare. The bike's motion on it is `LoopRide`, not this collider.
 */
function buildLoop(
  physics: PhysicsWorld,
  body: RAPIER.RigidBody,
  surfaces: SurfaceRegistry,
  group: THREE.Group,
  loop: LoopGeometry,
): void {
  const road = buildLoopStrip(loop, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, 0, 2.5);
  const roadMaterial = terrainMaterial(createAsphaltTexture(ROAD_HALF_WIDTH * 2), ROAD_FALLBACK_COLOR, 0.95);
  roadMaterial.side = THREE.DoubleSide;
  const roadMesh = new THREE.Mesh(road.geometry, roadMaterial);
  roadMesh.name = "loop-road";
  roadMesh.receiveShadow = true;
  roadMesh.castShadow = true;
  group.add(roadMesh);
  surfaces.register(addTrimeshCollider(physics, body, road, 1.0), ROAD_SURFACE);

  const lineMaterial = new THREE.MeshStandardMaterial({ color: MARKING_COLOR, roughness: 0.8, side: THREE.DoubleSide });
  for (const side of [-1, 1] as const) {
    const edge = buildLoopStrip(loop, side * (ROAD_HALF_WIDTH - 0.55), side * (ROAD_HALF_WIDTH - 0.25), MARKING_LIFT, 2.5);
    group.add(new THREE.Mesh(edge.geometry, lineMaterial));
  }
  // Outer lips, so the ribbon reads as a solid structure from the side.
  const lipMaterial = new THREE.MeshStandardMaterial({ color: 0xd04a2f, roughness: 0.7, side: THREE.DoubleSide });
  for (const side of [-1, 1] as const) {
    const lip = buildLoopStrip(loop, side * ROAD_HALF_WIDTH, side * (ROAD_HALF_WIDTH + 0.5), 0.1, 2.5);
    group.add(new THREE.Mesh(lip.geometry, lipMaterial));
  }

  // Ground under the loop, between where the bands stop and start again.
  const length = loop.advance + 12;
  const width = loop.shift + OFFROAD_HALF_WIDTH * 2;
  const heading = Math.atan2(loop.heading.x, loop.heading.z);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  const cx = loop.origin.x + loop.heading.x * (loop.advance / 2) + loop.shiftDirection.x * (loop.shift / 2);
  const cz = loop.origin.z + loop.heading.z * (loop.advance / 2) + loop.shiftDirection.z * (loop.shift / 2);
  const slabTop = loop.origin.y - 0.06;
  const slabGeometry = new THREE.PlaneGeometry(width, length);
  slabGeometry.rotateX(-Math.PI / 2);
  const slab = new THREE.Mesh(
    slabGeometry,
    terrainMaterial(createGrassTexture(width), OFFROAD_FALLBACK_COLOR, 1.0),
  );
  slab.position.set(cx, slabTop, cz);
  slab.quaternion.copy(q);
  slab.receiveShadow = true;
  group.add(slab);
  const slabCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(width / 2, 0.5, length / 2)
      .setTranslation(cx, slabTop - 0.5, cz)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setFriction(0.85)
      .setCollisionGroups(GROUPS_TERRAIN),
    body,
  );
  surfaces.register(slabCollider, OFFROAD_SURFACE);
}

/** A full-width painted band across the road at a given distance along it. */
function buildLineMarker(track: TrackDefinition, distanceAlong: number, color: number): THREE.Mesh {
  const u = THREE.MathUtils.clamp(distanceAlong / track.totalLength, 0, 1);
  const point = track.curve.getPointAt(u);
  const tangent = track.curve.getTangentAt(u).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);

  const geometry = new THREE.BoxGeometry(ROAD_HALF_WIDTH * 2, 0.04, 1.2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
  );
  mesh.position.copy(point).setY(point.y + MARKING_LIFT);
  mesh.quaternion.copy(quat);
  return mesh;
}

/** Posts-and-banner arch over the finish line, so it's visible from a distance. */
function buildFinishGantry(track: TrackDefinition): THREE.Group {
  const gantry = new THREE.Group();
  const u = track.finishDistance / track.totalLength;
  const point = track.curve.getPointAt(u);
  const tangent = track.curve.getTangentAt(u).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);

  const postMaterial = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.6 });
  const bannerMaterial = new THREE.MeshStandardMaterial({ color: 0xd02f2f, roughness: 0.9 });

  const postHeight = 7;
  const postGeometry = new THREE.BoxGeometry(0.4, postHeight, 0.4);
  for (const side of [-1, 1] as const) {
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.position.set(side * (ROAD_HALF_WIDTH + 0.5), postHeight / 2, 0);
    post.castShadow = true;
    gantry.add(post);
  }

  const banner = new THREE.Mesh(
    new THREE.BoxGeometry((ROAD_HALF_WIDTH + 0.7) * 2, 1.6, 0.3),
    bannerMaterial,
  );
  banner.position.set(0, postHeight - 0.8, 0);
  banner.castShadow = true;
  gantry.add(banner);

  gantry.position.copy(point);
  gantry.quaternion.copy(quat);
  return gantry;
}
