import * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";
import type { LampRegistry } from "./LampRegistry";
import { ROAD_HALF_WIDTH, OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import { createRiderCharacter } from "../entities/RiderCharacter";
import { BILLBOARD_VARIANTS, createBillboardTexture, createSignTexture, type SignKind } from "../render/Textures";

/**
 * Things that stand beside the road: the curve warning signs and the traffic
 * light that counts the race in. Visual only (no colliders), like the rest of
 * the scenery; they sit just off the asphalt, inside the off-road band, where
 * the boundary wall is still metres further out.
 */

/** How far the off-road band has dropped by this lateral offset: it falls linearly to `-2.5` at the wall. */
function groundDrop(lateral: number): number {
  return -2.5 * Math.max(0, (lateral - ROAD_HALF_WIDTH) / (OFFROAD_HALF_WIDTH - ROAD_HALF_WIDTH));
}

/** A corner needs a warning sign if its radius is under this, in metres. */
const SIGN_CORNER_RADIUS = 150;
/** Corners tighter than this get the white arrow board; gentler ones the yellow diamond. */
const ARROW_BOARD_RADIUS = 75;
/** Signs stand this far before a corner, and no two closer than the gap. */
const SIGN_AHEAD = 80;
const SIGN_MIN_GAP = 140;
/** Metres between the road's edge and the sign post. */
const SIGN_SETBACK = 2.3;
const BOARD_SIZE = 1.25;
const POST_HEIGHT = 2.5;

/** One warning sign per significant corner, on the outside of the bend, facing the riders coming at it. */
export function buildCurveSigns(track: TrackDefinition, disposers: Array<() => void>): THREE.Group {
  const group = new THREE.Group();
  group.name = "curve-signs";

  interface Placement { position: THREE.Vector3; facing: THREE.Vector3; kind: SignKind }
  const placements: Placement[] = [];
  const radii = track.sampleRadii;
  const spacing = track.sampleSpacing;
  const ahead = Math.round(SIGN_AHEAD / spacing);
  let lastSign = -Infinity;

  for (let i = 0; i < radii.length; i++) {
    if (!(radii[i] < SIGN_CORNER_RADIUS) || track.segmentInFeature(i)) continue;
    // The run of tight samples is one corner.
    let end = i;
    let tightest = radii[i];
    while (end + 1 < radii.length && radii[end + 1] < SIGN_CORNER_RADIUS) {
      end++;
      tightest = Math.min(tightest, radii[end]);
    }
    const signIndex = Math.max(0, i - ahead);
    const distance = track.sampleDistances[signIndex];
    if (distance > track.startDistance + 20 && distance < track.finishDistance - 20 && distance - lastSign > SIGN_MIN_GAP) {
      // Which way the road turns: whether the tangent swings toward the right-hand side.
      const right = track.sampleRights[signIndex];
      const swing = track.sampleTangents[Math.min(end, radii.length - 1)].clone().sub(track.sampleTangents[i]);
      const turnsRight = swing.dot(right) > 0;
      const side = turnsRight ? -1 : 1; // the outside of the bend
      const lateral = ROAD_HALF_WIDTH + SIGN_SETBACK;
      const position = track.samplePoints[signIndex].clone().addScaledVector(right, side * lateral);
      position.y += groundDrop(lateral) + 0.05;
      const facing = track.sampleTangents[signIndex].clone().setY(0).normalize().negate();
      const board = tightest < ARROW_BOARD_RADIUS ? "arrow" : "diamond";
      placements.push({ position, facing, kind: `${board}-${turnsRight ? "right" : "left"}` as SignKind });
      lastSign = distance;
    }
    i = end;
  }

  if (placements.length === 0) return group;

  const postGeometry = new THREE.CylinderGeometry(0.045, 0.05, POST_HEIGHT, 6);
  postGeometry.translate(0, POST_HEIGHT / 2, 0);
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0x8c8c88, roughness: 0.7 });
  const posts = new THREE.InstancedMesh(postGeometry, postMaterial, placements.length);
  posts.name = "sign-posts";
  posts.castShadow = true;
  const boardGeometry = new THREE.PlaneGeometry(BOARD_SIZE, BOARD_SIZE);
  disposers.push(() => {
    postGeometry.dispose();
    postMaterial.dispose();
    boardGeometry.dispose();
  });

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const unit = new THREE.Vector3(1, 1, 1);
  const kinds = new Map<SignKind, Placement[]>();
  placements.forEach((p, n) => {
    matrix.compose(p.position, new THREE.Quaternion(), unit);
    posts.setMatrixAt(n, matrix);
    kinds.set(p.kind, [...(kinds.get(p.kind) ?? []), p]);
  });
  group.add(posts);

  for (const [kind, list] of kinds) {
    const texture = createSignTexture(kind);
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      color: texture ? 0xffffff : kind.startsWith("diamond") ? 0xf2b61c : 0xf4f2e8,
      roughness: 0.6,
      side: THREE.DoubleSide,
      transparent: kind.startsWith("diamond"),
      alphaTest: kind.startsWith("diamond") ? 0.5 : 0,
    });
    disposers.push(() => {
      material.dispose();
      texture?.dispose();
    });
    const boards = new THREE.InstancedMesh(boardGeometry, material, list.length);
    boards.name = `sign-boards-${kind}`;
    boards.castShadow = true;
    list.forEach((p, n) => {
      quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.facing);
      const at = p.position.clone();
      at.y += POST_HEIGHT - BOARD_SIZE * 0.45;
      matrix.compose(at, quaternion, unit);
      boards.setMatrixAt(n, matrix);
    });
    group.add(boards);
  }
  return group;
}

export type StartLightState = "red" | "yellow" | "green" | "off";

export interface StartLight {
  group: THREE.Group;
  set(state: StartLightState): void;
}

/** Where the light stands, in metres past the start line and out from the road's edge. */
const LIGHT_PAST_LINE = 3;
const LIGHT_SETBACK = 2.2;
const LIGHT_HEIGHT = 4.2;

const LAMP_COLOURS: Record<Exclude<StartLightState, "off">, number> = { red: 0xff2a1a, yellow: 0xffc21a, green: 0x1de25a };

/** A roadside traffic light by the start line: red, then amber, then green as the race starts. */
export function buildStartLight(track: TrackDefinition, disposers: Array<() => void>): StartLight {
  const group = new THREE.Group();
  group.name = "start-light";

  const distance = track.startDistance + LIGHT_PAST_LINE;
  const index = track.sampleIndexAt(distance);
  const right = track.sampleRights[index];
  const lateral = ROAD_HALF_WIDTH + LIGHT_SETBACK;
  const base = track.samplePoints[index].clone().addScaledVector(right, lateral);
  base.y += groundDrop(lateral) + 0.05;
  // Faces the riders waiting behind the line.
  const facing = track.sampleTangents[index].clone().setY(0).normalize().negate();

  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, LIGHT_HEIGHT, 8), metal);
  pole.position.y = LIGHT_HEIGHT / 2;
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.35, 0.4), metal);
  housing.position.set(0, LIGHT_HEIGHT + 0.5, 0);
  group.add(pole, housing);

  const lamps = {} as Record<Exclude<StartLightState, "off">, THREE.MeshStandardMaterial>;
  const lampGeometry = new THREE.CircleGeometry(0.17, 16);
  (["red", "yellow", "green"] as const).forEach((name, n) => {
    const material = new THREE.MeshStandardMaterial({ color: 0x151515, emissive: LAMP_COLOURS[name], emissiveIntensity: 0, roughness: 0.4 });
    lamps[name] = material;
    const lamp = new THREE.Mesh(lampGeometry, material);
    lamp.position.set(0, LIGHT_HEIGHT + 0.5 + 0.45 - n * 0.45, 0.205);
    group.add(lamp);
  });
  disposers.push(() => {
    pole.geometry.dispose();
    housing.geometry.dispose();
    lampGeometry.dispose();
    metal.dispose();
    Object.values(lamps).forEach((m) => m.dispose());
  });

  group.position.copy(base);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing);
  group.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true) : undefined));

  const set = (state: StartLightState): void => {
    for (const name of ["red", "yellow", "green"] as const) {
      lamps[name].emissiveIntensity = state === name ? 2.4 : 0;
      lamps[name].color.setHex(state === name ? LAMP_COLOURS[name] : 0x151515);
    }
  };
  set("red");
  return { group, set };
}

/** Street lamps line the road this far either side of the start and finish lines, one per side every LAMP_GAP metres. */
const LAMP_SPAN = 150;
const LAMP_GAP = 30;
const LAMP_SETBACK = 2.6;
const LAMP_POLE_HEIGHT = 7;
const LAMP_ARM = 1.6;

/**
 * Lit street lamps beside the road around the start and finish lines (the
 * town stretches already have their own). Each is a pole with an arm over the
 * road and a glowing head; a soft additive halo stands in for real light,
 * which would cost a light per lamp.
 */
export function buildStreetLamps(track: TrackDefinition, disposers: Array<() => void>, lamps: LampRegistry): THREE.Group {
  const group = new THREE.Group();
  group.name = "street-lamps";

  interface Spot { position: THREE.Vector3; inward: THREE.Vector3 }
  const spots: Spot[] = [];
  for (const centre of [track.startDistance, track.finishDistance]) {
    for (let d = centre - LAMP_SPAN; d <= centre + LAMP_SPAN; d += LAMP_GAP) {
      if (d < 0 || d > track.totalLength) continue;
      const index = track.sampleIndexAt(d);
      if (track.biomeAt(d) === "city" || track.segmentInFeature(index, undefined, true)) continue;
      const right = track.sampleRights[index];
      const lateral = ROAD_HALF_WIDTH + LAMP_SETBACK;
      for (const side of [-1, 1]) {
        const position = track.samplePoints[index].clone().addScaledVector(right, side * lateral);
        position.y += groundDrop(lateral) + 0.05;
        spots.push({ position, inward: right.clone().multiplyScalar(-side) });
      }
    }
  }
  if (spots.length === 0) return group;

  const poleGeometry = new THREE.CylinderGeometry(0.07, 0.1, LAMP_POLE_HEIGHT, 8);
  poleGeometry.translate(0, LAMP_POLE_HEIGHT / 2, 0);
  const armGeometry = new THREE.BoxGeometry(LAMP_ARM, 0.09, 0.09);
  armGeometry.translate(LAMP_ARM / 2, 0, 0);
  const headGeometry = new THREE.BoxGeometry(0.7, 0.12, 0.34);
  const haloGeometry = new THREE.PlaneGeometry(4.5, 4.5);
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xf2f0e0, emissive: 0xfff3c4, emissiveIntensity: lamps.lit ? 2.2 : 0.35, roughness: 0.5 });
  const haloMaterial = new THREE.MeshBasicMaterial({
    map: createHaloTexture(),
    color: 0xffe9a8,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  disposers.push(() => {
    poleGeometry.dispose();
    armGeometry.dispose();
    headGeometry.dispose();
    haloGeometry.dispose();
    metal.dispose();
    glow.dispose();
    haloMaterial.map?.dispose();
    haloMaterial.dispose();
  });

  const poles = new THREE.InstancedMesh(poleGeometry, metal, spots.length);
  const arms = new THREE.InstancedMesh(armGeometry, metal, spots.length);
  const heads = new THREE.InstancedMesh(headGeometry, glow, spots.length);
  const halos = new THREE.InstancedMesh(haloGeometry, haloMaterial, spots.length);
  poles.name = "lamp-poles";
  arms.name = "lamp-arms";
  heads.name = "lamp-heads";
  halos.name = "lamp-halos";
  poles.castShadow = true;

  const matrix = new THREE.Matrix4();
  const unit = new THREE.Vector3(1, 1, 1);
  const quaternion = new THREE.Quaternion();
  const sideways = new THREE.Vector3(1, 0, 0);
  const lieFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)); // halo lies flat on the ground
  spots.forEach((spot, n) => {
    quaternion.setFromUnitVectors(sideways, spot.inward);
    matrix.compose(spot.position, quaternion, unit);
    poles.setMatrixAt(n, matrix);
    const top = spot.position.clone();
    top.y += LAMP_POLE_HEIGHT;
    matrix.compose(top, quaternion, unit);
    arms.setMatrixAt(n, matrix);
    const head = top.clone().addScaledVector(spot.inward, LAMP_ARM);
    head.y -= 0.08;
    matrix.compose(head, quaternion, unit);
    heads.setMatrixAt(n, matrix);
    // The pool of light on the road under the lamp.
    const pool = head.clone();
    pool.y = spot.position.y + 0.08;
    lamps.positions.push(head.clone());
    matrix.compose(pool, lieFlat, unit);
    halos.setMatrixAt(n, matrix);
  });
  group.add(poles, arms, heads);
  if (lamps.lit) group.add(halos);
  return group;
}

/** A radial falloff for the lamp light pool. Plain white-to-clear gradient; `null` under Node. */
function createHaloTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

/** Ad boards stand roughly this far apart along the road, alternating sides. */
const BILLBOARD_GAP = 380;
const BILLBOARD_SETBACK = 9;
const BILLBOARD_WIDTH = 6;
const BILLBOARD_HEIGHT = 3;
const BILLBOARD_LEG_HEIGHT = 3;

/** Big ad boards on two legs beside the road, facing the riders, clear of corners, features and the lit start/finish stretches. */
export function buildBillboards(track: TrackDefinition, disposers: Array<() => void>): THREE.Group {
  const group = new THREE.Group();
  group.name = "billboards";

  interface Placement { position: THREE.Vector3; facing: THREE.Vector3; variant: number }
  const placements: Placement[] = [];
  let n = 0;
  for (let d = track.startDistance + LAMP_SPAN + BILLBOARD_GAP / 2; d < track.finishDistance - LAMP_SPAN; d += BILLBOARD_GAP) {
    const index = track.sampleIndexAt(d);
    if (track.biomeAt(d) === "city" || track.segmentInFeature(index, undefined, true) || !(track.sampleRadii[index] > 400)) continue;
    const side = n % 2 === 0 ? 1 : -1;
    const lateral = ROAD_HALF_WIDTH + BILLBOARD_SETBACK;
    const position = track.samplePoints[index].clone().addScaledVector(track.sampleRights[index], side * lateral);
    position.y += groundDrop(lateral) + 0.05;
    const facing = track.sampleTangents[index].clone().setY(0).normalize().negate();
    placements.push({ position, facing, variant: n % BILLBOARD_VARIANTS });
    n++;
  }
  if (placements.length === 0) return group;

  const legGeometry = new THREE.BoxGeometry(0.18, BILLBOARD_LEG_HEIGHT, 0.18);
  legGeometry.translate(0, BILLBOARD_LEG_HEIGHT / 2, 0);
  const frameGeometry = new THREE.BoxGeometry(BILLBOARD_WIDTH + 0.3, BILLBOARD_HEIGHT + 0.3, 0.12);
  const boardGeometry = new THREE.PlaneGeometry(BILLBOARD_WIDTH, BILLBOARD_HEIGHT);
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 });
  disposers.push(() => {
    legGeometry.dispose();
    frameGeometry.dispose();
    boardGeometry.dispose();
    metal.dispose();
  });

  const toBoardMaterial: Array<THREE.MeshStandardMaterial> = [];
  for (let v = 0; v < BILLBOARD_VARIANTS; v++) {
    const texture = createBillboardTexture(v);
    const material = new THREE.MeshStandardMaterial({ map: texture, color: texture ? 0xffffff : 0xb0b0b0, roughness: 0.7 });
    disposers.push(() => {
      material.dispose();
      texture?.dispose();
    });
    toBoardMaterial.push(material);
  }

  const forward = new THREE.Vector3(0, 0, 1);
  const legOffset = BILLBOARD_WIDTH * 0.32;
  for (const p of placements) {
    const board = new THREE.Group();
    board.position.copy(p.position);
    board.quaternion.setFromUnitVectors(forward, p.facing);
    for (const x of [-legOffset, legOffset]) {
      const leg = new THREE.Mesh(legGeometry, metal);
      leg.position.x = x;
      leg.castShadow = true;
      board.add(leg);
    }
    const frame = new THREE.Mesh(frameGeometry, metal);
    frame.position.set(0, BILLBOARD_LEG_HEIGHT + BILLBOARD_HEIGHT / 2, -0.07);
    frame.castShadow = true;
    const face = new THREE.Mesh(boardGeometry, toBoardMaterial[p.variant]);
    face.position.set(0, BILLBOARD_LEG_HEIGHT + BILLBOARD_HEIGHT / 2, 0.001);
    board.add(frame, face);
    group.add(board);
  }
  return group;
}

/** Spectators gather this far either side of the start and finish lines. */
const CROWD_SPAN = 14;
/** Fans per side of the road at each line: 4 spots x this = the whole crowd. */
const CROWD_PER_SIDE = 5;
const CROWD_SETBACK_MIN = 4;
const CROWD_SETBACK_MAX = 7;

/** Fifteen shirt and fifteen trouser colours; every fan gets a random pair, so 225 looks. */
const SHIRT_COLOURS = [
  0xd8452c, 0x2c6fd8, 0xe8c21c, 0x2fa05c, 0xf4f2e8, 0x8a3fb0, 0x1c1c1c, 0xe86fa0, 0x19b5b5, 0xf08a24,
  0x7a1f2b, 0x5a8f29, 0x3a3f9e, 0xb8b8c0, 0xc9a66b,
];
const TROUSER_COLOURS = [
  0x23262e, 0x3b4a6b, 0x1f3a5f, 0x6b5a45, 0x8a7a5a, 0x4a4a4a, 0x2f4f3a, 0x7a2f2f, 0xc2b280, 0x555e70,
  0x101010, 0x6a4a8a, 0x3f6f6f, 0x9a9a9a, 0x4b3621,
];

/**
 * Fans standing off the road at the start and finish lines. Each is the rider
 * model (`rider.glb`) in a standing pose, in a random shirt and trousers from
 * the two palettes above, facing the road. Skinned meshes cannot be instanced,
 * so the crowd is kept small. Without the model they are capsules.
 */
export function buildSpectators(track: TrackDefinition, disposers: Array<() => void>): THREE.Group {
  const group = new THREE.Group();
  group.name = "spectators";

  const capsuleGeometry = new THREE.CapsuleGeometry(0.22, 0.9, 4, 6);
  capsuleGeometry.translate(0, 0.22 + 0.45, 0);
  const capsuleMaterials = new Map<number, THREE.MeshStandardMaterial>();
  disposers.push(() => {
    capsuleGeometry.dispose();
    capsuleMaterials.forEach((m) => m.dispose());
  });

  // Deterministic scatter, so a reload shows the same crowd.
  let seed = 7;
  const random = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (list: readonly number[]): number => list[Math.floor(random() * list.length)];

  for (const centre of [track.startDistance, track.finishDistance]) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < CROWD_PER_SIDE; k++) {
        const d = centre + (random() * 2 - 1) * CROWD_SPAN;
        const index = track.sampleIndexAt(d);
        const right = track.sampleRights[index];
        const lateral = ROAD_HALF_WIDTH + CROWD_SETBACK_MIN + random() * (CROWD_SETBACK_MAX - CROWD_SETBACK_MIN);
        const position = track.samplePoints[index].clone().addScaledVector(right, side * lateral);
        position.y += groundDrop(lateral) + 0.05;
        // Faces the road, give or take a few degrees.
        const yaw = Math.atan2(-right.x * side, -right.z * side) + (random() - 0.5) * 0.6;
        const shirt = pick(SHIRT_COLOURS);
        const trousers = pick(TROUSER_COLOURS);

        const figure = createRiderCharacter(shirt, trousers);
        if (figure) {
          figure.holder.position.copy(position);
          figure.holder.rotation.y = yaw;
          const scale = 0.94 + random() * 0.12;
          figure.holder.scale.setScalar(scale);
          group.add(figure.holder);
          disposers.push(() => figure.dispose());
        } else {
          let material = capsuleMaterials.get(shirt);
          if (!material) {
            material = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.8 });
            capsuleMaterials.set(shirt, material);
          }
          const fan = new THREE.Mesh(capsuleGeometry, material);
          fan.position.copy(position);
          fan.castShadow = true;
          group.add(fan);
        }
      }
    }
  }
  return group;
}
