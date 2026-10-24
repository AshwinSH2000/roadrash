import * as THREE from "three";
import type { LampRegistry } from "./LampRegistry";
import type { TrackDefinition } from "./TrackDefinition";
import { CITY_HALF_WIDTH, OFFROAD_HALF_WIDTH, ROAD_HALF_WIDTH } from "./TrackDefinition";
import type { GraphicsSettings } from "../settings/GraphicsSettings";
import {
  createAwningTexture,
  createFacadeTexture,
  createShopfrontTexture,
  createSignTexture,
  type FacadeStyle,
  type SignKind,
} from "../render/Textures";

/**
 * The towns: the buildings that line a street, and everything that stands on
 * it. All visual (nothing here has a collider; the invisible wall at
 * `CITY_HALF_WIDTH` is what keeps riders out), drawn from a handful of shared
 * shapes as instanced meshes so a whole town is a few dozen draw calls, and
 * built from canvas textures at load, not files.
 *
 * Buildings: rows end to end behind the pavement, each with a ground-floor
 * shopfront and a striped awning, balconies on the middle floors, and plant
 * on the roof; in rendered or brick fronts, with glass towers set back behind.
 * Street: lamp posts, trees in the pavement, benches and bins, pedestrian
 * barriers along the wall, yellow bollards, speed-limit and direction signs,
 * and a zebra crossing every few hundred metres with a light at each end.
 */

/** Where the off-road band's outer edge sits relative to the road, in metres, and how the ground falls to it. */
const BAND_EDGE_DROP = -2.5;
const groundLift = (lateral: number): number => (BAND_EDGE_DROP * (lateral - ROAD_HALF_WIDTH)) / (OFFROAD_HALF_WIDTH - ROAD_HALF_WIDTH);

/** Where the buildings' fronts stand, measured out from the centreline: just behind the onlookers and parked cars. */
const BUILDING_FRONT = CITY_HALF_WIDTH + 5.5;
const BUILDING_DEPTH = 14;
const BUILDING_WIDTHS = [9, 13] as const;
const BUILDING_HEIGHTS = [12, 19, 28] as const;
const TOWER = { width: 14, height: 46 };
/** Metres of wall one repeat of the facade texture covers. */
const FACADE_TILE = 4;
/** How far the foundations reach below the street. A multiple of the tile, so the ground-floor windows land on the tile boundary the shopfront covers. */
const FOUNDATION = 4;
const SHOPFRONT_HEIGHT = 3.6;
const FACADE_TINTS = [0xf0e6d6, 0xd9c19a, 0xbfc3c7, 0xe3c07a, 0xa9b4bd, 0xe8d8c4];
const BRICK_TINTS = [0xffffff, 0xe8cdbf, 0xd9b8a8, 0xc9a898];
const SHOP_TINTS = [0xffffff, 0xf0e4cc, 0xdfe6ea, 0xe8d6d0];
const AWNING_TINTS = [0xc8302a, 0x2f7a46, 0x2a5aa6, 0xd6a02a, 0x8a3a7a];

type Style = FacadeStyle;

interface Building {
  style: Style;
  width: number;
  height: number;
  /** On the ground at the middle of the building's footprint. */
  position: THREE.Vector3;
  /** Unit horizontal direction the front faces (toward the street). */
  facing: THREE.Vector3;
  quaternion: THREE.Quaternion;
  tint: number;
  shop: boolean;
  tower: boolean;
}

/** A box whose side faces carry a texture at a fixed scale, roof and floor plain. The origin is at ground level, with `FOUNDATION` below it. */
function texturedBox(width: number, height: number, depth: number, tileWidth: number, tileHeight: number, foundation: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height + foundation, depth);
  geometry.translate(0, (height - foundation) / 2, 0);
  const uv = geometry.getAttribute("uv");
  // BoxGeometry orders its faces +x, -x, +y, -y, +z, -z, four vertices each.
  const faceWidths = [depth, depth, 1, 1, width, width];
  for (let face = 0; face < 6; face++) {
    for (let k = 0; k < 4; k++) {
      const n = face * 4 + k;
      if (face === 2 || face === 3) uv.setXY(n, 0.02, 0.02);
      else uv.setXY(n, (uv.getX(n) * faceWidths[face]) / tileWidth, (uv.getY(n) * (height + foundation)) / tileHeight);
    }
  }
  return geometry;
}

/** The sample at `distance` if it is in a town and clear of the stunts, else null. */
function townIndex(track: TrackDefinition, distance: number): number | null {
  if (distance < 0 || distance > track.totalLength) return null;
  if (track.biomeAt(distance) !== "city") return null;
  const index = track.sampleIndexAt(distance);
  return track.segmentInFeature(index, undefined, true) ? null : index;
}

/** Everything a town has: buildings with their shopfronts, awnings, balconies and rooftops, and the furniture of the street. */
export function buildCity(track: TrackDefinition, quality: GraphicsSettings, disposers: Array<() => void>, lamps?: LampRegistry): THREE.Group {
  const group = new THREE.Group();
  group.name = "city";
  const buildings = placeBuildings(track, quality);
  if (buildings.length === 0) return group;
  group.add(buildBuildingMeshes(buildings, disposers));
  group.add(buildBuildingDetail(buildings, disposers));
  group.add(buildStreetFurniture(track, quality, disposers, lamps));
  return group;
}

// --- Buildings ---------------------------------------------------------------

function placeBuildings(track: TrackDefinition, quality: GraphicsSettings): Building[] {
  const buildings: Building[] = [];
  const fill = Math.min(1, 0.55 + quality.sceneryDensity * 0.5);
  const right = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
  const lateral = BUILDING_FRONT + BUILDING_DEPTH / 2;

  for (const side of [-1, 1] as const) {
    let distance = 0;
    while (distance < track.totalLength) {
      const width = pick(BUILDING_WIDTHS);
      const index = townIndex(track, distance + width / 2);
      if (index === null) {
        distance += 12;
        continue;
      }
      const advance = width + 0.6 + Math.random() * 1.2;
      const height = pick(BUILDING_HEIGHTS);
      right.copy(track.sampleRights[index]);
      // Which side of the road is the inside of the bend here? A row there would pile into itself.
      const behind = track.sampleTangents[Math.max(0, index - 6)];
      const ahead = track.sampleTangents[Math.min(track.sampleTangents.length - 1, index + 6)];
      const innerSide = ahead.clone().sub(behind).dot(right) > 0 ? 1 : -1;
      const crowded = side === innerSide && track.sampleRadii[index] < (lateral + BUILDING_DEPTH / 2 + 4) * 1.1;
      if (!crowded && Math.random() < fill) {
        const position = track.samplePoints[index].clone().addScaledVector(right, side * lateral);
        position.y += groundLift(BUILDING_FRONT);
        facing.copy(right).multiplyScalar(-side).setY(0).normalize();
        const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing);
        const style: Style = Math.random() < 0.55 ? "classic" : "brick";
        buildings.push({
          style,
          width,
          height,
          position,
          facing: facing.clone(),
          quaternion,
          tint: style === "brick" ? pick(BRICK_TINTS) : pick(FACADE_TINTS),
          shop: Math.random() < 0.8,
          tower: false,
        });
        // A glass tower set back behind the gap, now and then.
        if (Math.random() < 0.1) {
          const back = position.clone().addScaledVector(right, side * (BUILDING_DEPTH + 14 + Math.random() * 10));
          buildings.push({ style: "glass", width: TOWER.width, height: TOWER.height, position: back, facing: facing.clone(), quaternion: quaternion.clone(), tint: 0xffffff, shop: false, tower: true });
        }
      }
      distance += advance;
    }
  }
  return buildings;
}

/** The buildings themselves: one instanced mesh per style and size. */
function buildBuildingMeshes(buildings: Building[], disposers: Array<() => void>): THREE.Group {
  const group = new THREE.Group();
  group.name = "city-buildings";
  const roof = new THREE.MeshStandardMaterial({ color: 0x5c5a57, roughness: 1 });
  const walls = new Map<Style, THREE.MeshStandardMaterial>();
  const textures: THREE.Texture[] = [];
  for (const style of ["classic", "brick", "glass"] as const) {
    const texture = createFacadeTexture(style);
    if (texture) textures.push(texture);
    walls.set(style, new THREE.MeshStandardMaterial({ map: texture, color: 0xffffff, roughness: style === "glass" ? 0.35 : 0.9, metalness: style === "glass" ? 0.25 : 0 }));
  }
  disposers.push(() => {
    roof.dispose();
    walls.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
  });

  const keys = new Set(buildings.map((b) => `${b.style}:${b.width}x${b.height}`));
  const matrix = new THREE.Matrix4();
  const unit = new THREE.Vector3(1, 1, 1);
  const colour = new THREE.Color();
  for (const key of keys) {
    const list = buildings.filter((b) => `${b.style}:${b.width}x${b.height}` === key);
    const { style, width, height } = list[0];
    const wall = walls.get(style)!;
    const geometry = texturedBox(width, height, BUILDING_DEPTH, FACADE_TILE, FACADE_TILE, FOUNDATION);
    disposers.push(() => geometry.dispose());
    const mesh = new THREE.InstancedMesh(geometry, [wall, wall, roof, roof, wall, wall], list.length);
    mesh.name = `city-buildings-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    list.forEach((b, n) => {
      matrix.compose(b.position, b.quaternion, unit);
      mesh.setMatrixAt(n, matrix);
      mesh.setColorAt(n, colour.setHex(b.tint));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  return group;
}

/** A transform from a building's own frame (+Z toward the street, y up from the ground) into the world. */
function toWorld(b: Building, local: THREE.Vector3, out: THREE.Matrix4, extra?: THREE.Quaternion): THREE.Matrix4 {
  const position = local.clone().applyQuaternion(b.quaternion).add(b.position);
  const quaternion = extra ? b.quaternion.clone().multiply(extra) : b.quaternion;
  return out.compose(position, quaternion, new THREE.Vector3(1, 1, 1));
}

/** Instanced meshes from a list of (matrix, colour) pairs, or nothing if the list is empty. */
function instances(
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  list: { matrix: THREE.Matrix4; colour?: number }[],
  name: string,
  shadows = true,
): THREE.InstancedMesh | null {
  if (list.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, list.length);
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  const colour = new THREE.Color();
  list.forEach((item, n) => {
    mesh.setMatrixAt(n, item.matrix);
    if (item.colour !== undefined) mesh.setColorAt(n, colour.setHex(item.colour));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** Shopfronts and awnings on the ground floor, balconies on the middle floors, plant on the roof. */
function buildBuildingDetail(buildings: Building[], disposers: Array<() => void>): THREE.Group {
  const group = new THREE.Group();
  group.name = "city-building-detail";
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

  const shopTexture = createShopfrontTexture();
  const awningTexture = createAwningTexture();
  const shopMaterial = new THREE.MeshStandardMaterial({ map: shopTexture, color: 0xffffff, roughness: 0.8 });
  const awningMaterial = new THREE.MeshStandardMaterial({ map: awningTexture, color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb4b0a8, roughness: 1 });
  const railing = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 });
  const plant = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.9 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x9a6a4a, roughness: 0.95 });
  disposers.push(() => {
    [shopMaterial, awningMaterial, concrete, railing, plant, rust].forEach((m) => m.dispose());
    shopTexture?.dispose();
    awningTexture?.dispose();
  });
  const shared = (geometry: THREE.BufferGeometry): THREE.BufferGeometry => {
    disposers.push(() => geometry.dispose());
    return geometry;
  };

  const m = new THREE.Matrix4();
  const shops = new Map<number, { matrix: THREE.Matrix4; colour: number }[]>();
  const awnings = new Map<number, { matrix: THREE.Matrix4; colour: number }[]>();
  const slabs: { matrix: THREE.Matrix4 }[] = [];
  const rails: { matrix: THREE.Matrix4 }[] = [];
  const tanks: { matrix: THREE.Matrix4 }[] = [];
  const units: { matrix: THREE.Matrix4 }[] = [];
  const housings: { matrix: THREE.Matrix4 }[] = [];
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0);

  for (const b of buildings) {
    // Ground floor.
    if (b.shop && !b.tower) {
      const shopList = shops.get(b.width) ?? [];
      shopList.push({ matrix: toWorld(b, new THREE.Vector3(0, SHOPFRONT_HEIGHT / 2, BUILDING_DEPTH / 2 + 0.25), new THREE.Matrix4()), colour: pick(SHOP_TINTS) });
      shops.set(b.width, shopList);
      const awningList = awnings.get(b.width) ?? [];
      awningList.push({ matrix: toWorld(b, new THREE.Vector3(0, SHOPFRONT_HEIGHT + 0.25, BUILDING_DEPTH / 2 + 0.85), new THREE.Matrix4(), tilt), colour: pick(AWNING_TINTS) });
      awnings.set(b.width, awningList);
    }

    // Balconies on every second floor above the first, on one window in each bay.
    if (!b.tower && b.style !== "glass" && b.height >= 19 && Math.random() < 0.4) {
      const bays = Math.floor(b.width / FACADE_TILE);
      for (let y0 = FACADE_TILE * 2; y0 + FACADE_TILE <= b.height; y0 += FACADE_TILE * 2) {
        for (let bay = 0; bay < bays; bay++) {
          const x = -b.width / 2 + FACADE_TILE * bay + FACADE_TILE * 0.73;
          slabs.push({ matrix: toWorld(b, new THREE.Vector3(x, y0 + 1, BUILDING_DEPTH / 2 + 0.5), new THREE.Matrix4()) });
          rails.push({ matrix: toWorld(b, new THREE.Vector3(x, y0 + 1.5, BUILDING_DEPTH / 2 + 0.97), new THREE.Matrix4()) });
        }
      }
    }

    // The roof: a water tank, air-conditioning boxes, a stair housing.
    const spreadX = Math.max(1, b.width / 2 - 2.5);
    const spreadZ = BUILDING_DEPTH / 2 - 2.5;
    const roofSpot = (): THREE.Vector3 => new THREE.Vector3((Math.random() * 2 - 1) * spreadX, b.height, (Math.random() * 2 - 1) * spreadZ);
    if (Math.random() < 0.35) tanks.push({ matrix: toWorld(b, roofSpot().add(new THREE.Vector3(0, 1.1, 0)), m.clone()) });
    for (let k = 0; k < (b.tower ? 4 : 2); k++) if (Math.random() < 0.55) units.push({ matrix: toWorld(b, roofSpot().add(new THREE.Vector3(0, 0.5, 0)), m.clone(), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 1.2 - 0.6)) });
    if (Math.random() < 0.5) housings.push({ matrix: toWorld(b, roofSpot().add(new THREE.Vector3(0, 1.2, 0)), m.clone()) });
  }

  for (const [width, list] of shops) {
    const geometry = shared(texturedBox(width - 0.6, SHOPFRONT_HEIGHT, 0.5, FACADE_TILE, SHOPFRONT_HEIGHT, 0));
    // The box helper puts its origin at the foot; the shopfront is placed by its middle.
    geometry.translate(0, -SHOPFRONT_HEIGHT / 2, 0);
    const mesh = instances(geometry, shopMaterial, list, `city-shopfronts-${width}`);
    if (mesh) group.add(mesh);
  }
  for (const [width, list] of awnings) {
    const geometry = shared(new THREE.BoxGeometry(width - 1.4, 0.08, 1.7));
    geometry.rotateX(0.3);
    const mesh = instances(geometry, awningMaterial, list, `city-awnings-${width}`);
    if (mesh) group.add(mesh);
  }
  const extras: [THREE.BufferGeometry, THREE.Material, { matrix: THREE.Matrix4 }[], string][] = [
    [shared(new THREE.BoxGeometry(2, 0.12, 1)), concrete, slabs, "city-balcony-slabs"],
    [shared(new THREE.BoxGeometry(2, 0.9, 0.06)), railing, rails, "city-balcony-rails"],
    [shared(new THREE.CylinderGeometry(1.1, 1.1, 2.2, 10)), rust, tanks, "city-roof-tanks"],
    [shared(new THREE.BoxGeometry(2, 1, 1.4)), plant, units, "city-roof-units"],
    [shared(new THREE.BoxGeometry(3, 2.4, 3)), plant, housings, "city-roof-housings"],
  ];
  for (const [geometry, material, list, name] of extras) {
    const mesh = instances(geometry, material, list, name);
    if (mesh) group.add(mesh);
  }
  return group;
}

// --- The street ---------------------------------------------------------------

/** Lamp posts, trees, benches, bins, barriers, bollards, signs and zebra crossings along every stretch of town. */
function buildStreetFurniture(track: TrackDefinition, quality: GraphicsSettings, disposers: Array<() => void>, lamps?: LampRegistry): THREE.Group {
  const group = new THREE.Group();
  group.name = "city-street-furniture";
  const fill = Math.min(1, 0.5 + quality.sceneryDensity * 0.6);
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3(0, 0, 1);
  const one = new THREE.Vector3(1, 1, 1);

  /** Where a thing stands, by distance along the road and lateral offset (positive right): the position, and the unit vectors along the road and toward the road. */
  const spot = (distance: number, side: number, lateral: number): { index: number; position: THREE.Vector3; along: THREE.Vector3; toRoad: THREE.Vector3 } | null => {
    const index = townIndex(track, distance);
    if (index === null) return null;
    const right = track.sampleRights[index];
    const position = track.samplePoints[index].clone().addScaledVector(right, side * lateral);
    position.y += groundLift(lateral) + 0.04;
    return { index, position, along: track.sampleTangents[index].clone().setY(0).normalize(), toRoad: right.clone().multiplyScalar(-side).setY(0).normalize() };
  };
  const compose = (position: THREE.Vector3, toward: THREE.Vector3, lift = 0, local = new THREE.Vector3()): THREE.Matrix4 => {
    const q = new THREE.Quaternion().setFromUnitVectors(forward, toward);
    const p = position.clone().add(local.clone().applyQuaternion(q));
    p.y += lift;
    return new THREE.Matrix4().compose(p, q, one);
  };
  const shared = <T extends THREE.BufferGeometry | THREE.Material>(thing: T): T => {
    disposers.push(() => thing.dispose());
    return thing;
  };
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], list: { matrix: THREE.Matrix4; colour?: number }[], name: string): void => {
    const instanced = instances(geometry, material, list, name);
    if (instanced) group.add(instanced);
  };

  const darkMetal = shared(new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.3 }));
  const lampGlow = shared(new THREE.MeshStandardMaterial({ color: 0xf2f0e0, emissive: 0xfff3c4, emissiveIntensity: lamps?.lit ? 2.2 : 0.35, roughness: 0.5 }));
  const wood = shared(new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 0.9 }));
  const bollardYellow = shared(new THREE.MeshStandardMaterial({ color: 0xe8b923, roughness: 0.6 }));
  const trunkMaterial = shared(new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 }));
  const crownMaterial = shared(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }));
  const markingMaterial = shared(new THREE.MeshStandardMaterial({ color: 0xf0f0e8, roughness: 0.8 }));
  const greenLamp = shared(new THREE.MeshStandardMaterial({ color: 0x103018, emissive: 0x1de25a, emissiveIntensity: 1.6, roughness: 0.4 }));

  // Lamp posts: a pole, an arm out over the road, a lamp head; one every 38 m, sides alternating.
  const poles: { matrix: THREE.Matrix4 }[] = [];
  const arms: { matrix: THREE.Matrix4 }[] = [];
  const heads: { matrix: THREE.Matrix4 }[] = [];
  const lampLateral = CITY_HALF_WIDTH - 0.8;
  for (let d = 15, n = 0; d < track.totalLength; d += 38, n++) {
    const side = n % 2 === 0 ? 1 : -1;
    const s = spot(d, side, lampLateral);
    if (!s) continue;
    poles.push({ matrix: compose(s.position, s.toRoad, 3.6) });
    arms.push({ matrix: compose(s.position, s.toRoad, 7.1, new THREE.Vector3(0, 0, 1.0)) });
    heads.push({ matrix: compose(s.position, s.toRoad, 6.95, new THREE.Vector3(0, 0, 2.0)) });
    lamps?.positions.push(s.position.clone().addScaledVector(s.toRoad, 2.0).setY(s.position.y + 6.95));
  }
  mesh(shared(new THREE.CylinderGeometry(0.07, 0.1, 7.2, 8)), darkMetal, poles, "city-lamp-poles");
  mesh(shared(new THREE.BoxGeometry(0.1, 0.1, 2.2)), darkMetal, arms, "city-lamp-arms");
  mesh(shared(new THREE.BoxGeometry(0.5, 0.14, 0.9)), lampGlow, heads, "city-lamp-heads");

  // Trees in the pavement, small and round.
  const trunks: { matrix: THREE.Matrix4 }[] = [];
  const crowns: { matrix: THREE.Matrix4; colour: number }[] = [];
  const tint = new THREE.Color();
  for (let d = 30, n = 0; d < track.totalLength; d += 44, n++) {
    if (Math.random() > fill) continue;
    const s = spot(d + (Math.random() - 0.5) * 10, n % 2 === 0 ? -1 : 1, CITY_HALF_WIDTH - 1.2);
    if (!s) continue;
    const height = 3.4 + Math.random() * 1.4;
    const radius = 1.2 + Math.random() * 0.6;
    trunks.push({ matrix: new THREE.Matrix4().compose(s.position.clone().add(new THREE.Vector3(0, height * 0.22, 0)), new THREE.Quaternion(), new THREE.Vector3(0.22, height * 0.45, 0.22)) });
    crowns.push({
      matrix: new THREE.Matrix4().compose(s.position.clone().add(new THREE.Vector3(0, height * 0.45 + radius * 0.6, 0)), new THREE.Quaternion().setFromAxisAngle(up, Math.random() * 6), new THREE.Vector3(radius, radius * 0.9, radius)),
      colour: tint.setHSL(0.24 + Math.random() * 0.07, 0.42 + Math.random() * 0.15, 0.27 + Math.random() * 0.1).getHex(),
    });
  }
  mesh(shared(new THREE.CylinderGeometry(0.5, 0.65, 1, 6)), trunkMaterial, trunks, "city-tree-trunks");
  mesh(shared(new THREE.IcosahedronGeometry(1, 1)), crownMaterial, crowns, "city-tree-crowns");

  // Benches (seat and back) and bins by the wall, every ~85 m.
  const seats: { matrix: THREE.Matrix4 }[] = [];
  const backs: { matrix: THREE.Matrix4 }[] = [];
  const bins: { matrix: THREE.Matrix4 }[] = [];
  for (let d = 60, n = 0; d < track.totalLength; d += 85, n++) {
    if (Math.random() > fill) continue;
    const side = n % 2 === 0 ? 1 : -1;
    const s = spot(d, side, CITY_HALF_WIDTH - 0.9);
    if (!s) continue;
    seats.push({ matrix: compose(s.position, s.toRoad, 0.45) });
    backs.push({ matrix: compose(s.position, s.toRoad, 0.85, new THREE.Vector3(0, 0, -0.28)) });
    const b = spot(d + 3.2, side, CITY_HALF_WIDTH - 0.9);
    if (b) bins.push({ matrix: compose(b.position, b.toRoad, 0.45) });
  }
  mesh(shared(new THREE.BoxGeometry(1.7, 0.08, 0.5)), wood, seats, "city-bench-seats");
  mesh(shared(new THREE.BoxGeometry(1.7, 0.45, 0.06)), wood, backs, "city-bench-backs");
  mesh(shared(new THREE.CylinderGeometry(0.26, 0.22, 0.9, 10)), darkMetal, bins, "city-bins");

  // Pedestrian barriers along the wall, in runs of 60 m with 90 m between: a post every 2.5 m and two rails.
  const barrierPosts: { matrix: THREE.Matrix4 }[] = [];
  const barrierRails: { matrix: THREE.Matrix4 }[] = [];
  for (let d = 0; d < track.totalLength; d += 2.5) {
    if (Math.floor(d / 75) % 2 !== 0) continue;
    for (const side of [-1, 1] as const) {
      const s = spot(d, side, CITY_HALF_WIDTH - 0.2);
      if (!s) continue;
      barrierPosts.push({ matrix: compose(s.position, s.along, 0.55) });
      for (const h of [0.35, 0.85]) barrierRails.push({ matrix: compose(s.position, s.along, h, new THREE.Vector3(0, 0, 1.25)) });
    }
  }
  mesh(shared(new THREE.BoxGeometry(0.08, 1.1, 0.08)), darkMetal, barrierPosts, "city-barrier-posts");
  mesh(shared(new THREE.BoxGeometry(0.05, 0.05, 2.6)), darkMetal, barrierRails, "city-barrier-rails");

  // Yellow bollards in fours along the kerb side of the pavement, every ~70 m.
  const bollards: { matrix: THREE.Matrix4 }[] = [];
  for (let d = 40, n = 0; d < track.totalLength; d += 70, n++) {
    const side = n % 2 === 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) {
      const s = spot(d + k * 1.6, side, CITY_HALF_WIDTH - 1.7);
      if (s) bollards.push({ matrix: compose(s.position, s.along, 0.48) });
    }
  }
  mesh(shared(new THREE.CylinderGeometry(0.1, 0.11, 0.95, 8)), bollardYellow, bollards, "city-bollards");

  // Signs on posts: speed limit, straight on, no entry.
  const signKinds: SignKind[] = ["limit", "ahead", "no-entry"];
  const signLists = new Map<SignKind, { matrix: THREE.Matrix4 }[]>();
  const signPosts: { matrix: THREE.Matrix4 }[] = [];
  for (let d = 90, n = 0; d < track.totalLength; d += 150, n++) {
    const s = spot(d, n % 2 === 0 ? 1 : -1, CITY_HALF_WIDTH - 1.1);
    if (!s) continue;
    // Facing the riders coming along the road.
    const facing = s.along.clone().negate();
    const kind = signKinds[n % signKinds.length];
    signPosts.push({ matrix: compose(s.position, facing, 1.2) });
    signLists.set(kind, [...(signLists.get(kind) ?? []), { matrix: compose(s.position, facing, 2.55, new THREE.Vector3(0, 0, 0.06)) }]);
  }
  mesh(shared(new THREE.CylinderGeometry(0.04, 0.05, 2.4, 6)), darkMetal, signPosts, "city-sign-posts");
  for (const [kind, list] of signLists) {
    const texture = createSignTexture(kind);
    const material = shared(new THREE.MeshStandardMaterial({ map: texture, color: texture ? 0xffffff : 0xdddddd, roughness: 0.6, side: THREE.DoubleSide, transparent: true, alphaTest: 0.5 }));
    if (texture) disposers.push(() => texture.dispose());
    mesh(shared(new THREE.PlaneGeometry(0.7, 0.7)), material, list, `city-signs-${kind}`);
  }

  // Zebra crossings, every 280 m on a straight bit of road, with a light at each kerb.
  const stripes: { matrix: THREE.Matrix4 }[] = [];
  const lightPoles: { matrix: THREE.Matrix4 }[] = [];
  const lightHeads: { matrix: THREE.Matrix4 }[] = [];
  const lightLamps: { matrix: THREE.Matrix4 }[] = [];
  for (let d = 140; d < track.totalLength - 40; d += 280) {
    const centre = spot(d, 1, 0);
    if (!centre || track.sampleRadii[centre.index] < 400 || d < track.startDistance + 45 || d > track.finishDistance - 45) continue;
    const right = track.sampleRights[centre.index];
    for (let lateral = -6.4; lateral <= 6.4; lateral += 1.1) {
      const p = track.samplePoints[centre.index].clone().addScaledVector(right, lateral);
      p.y += 0.03;
      stripes.push({ matrix: new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromUnitVectors(forward, centre.along), one) });
    }
    // The lights stand a little before the crossing, facing the riders.
    for (const side of [-1, 1] as const) {
      const s = spot(d - 3.2, side, ROAD_HALF_WIDTH + 1.1);
      if (!s) continue;
      const facing = s.along.clone().negate();
      lightPoles.push({ matrix: compose(s.position, facing, 1.7) });
      lightHeads.push({ matrix: compose(s.position, facing, 3.5) });
      lightLamps.push({ matrix: compose(s.position, facing, 3.5, new THREE.Vector3(0, 0.22, 0.17)) });
    }
  }
  mesh(shared(new THREE.BoxGeometry(0.5, 0.03, 3.2)), markingMaterial, stripes, "city-zebra");
  mesh(shared(new THREE.CylinderGeometry(0.05, 0.06, 3.4, 8)), darkMetal, lightPoles, "city-light-poles");
  mesh(shared(new THREE.BoxGeometry(0.3, 0.8, 0.3)), darkMetal, lightHeads, "city-light-heads");
  mesh(shared(new THREE.CircleGeometry(0.09, 10)), greenLamp, lightLamps, "city-light-lamps");

  return group;
}
