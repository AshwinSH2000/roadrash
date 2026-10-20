import * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";
import { ROAD_HALF_WIDTH, OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import { createSignTexture, type SignKind } from "../render/Textures";

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
