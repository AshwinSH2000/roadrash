import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import { GROUPS_WALL } from "../physics/CollisionGroups";
import { OFFROAD_HALF_WIDTH, TrackDefinition } from "./TrackDefinition";

/**
 * The invisible wall that stops a rider drifting off the off-road band and
 * falling through the world (see TODO.md's "World edge" note): past
 * `OFFROAD_HALF_WIDTH` there is no terrain collider at all, only the visual
 * ground fill (`TrackBuilder.ts`'s "Ground fill" block) — a rider or bike
 * that reaches it today has nothing under it and falls until the
 * fell-off-the-world rescue catches it dozens of metres down.
 *
 * Built as a row of overlapping static box colliders following the
 * centerline, rather than one swept trimesh ribbon like the road/off-road
 * bands: a vertical wall's face normal doesn't have the "must point up"
 * property `TrackBuilder.ensureUpwardWinding` relies on, and a box's
 * outward-facing sides can't be wound wrong the way a ribbon's winding once
 * was (see `TrackBuilder.ts`'s "off-road band was wound backwards" hiccup) —
 * so this sidesteps that whole class of bug rather than risking it again.
 * Overlapping boxes on the inside of a tight corner are also harmless
 * (two static colliders never push on each other), where a swept ribbon
 * would fold through itself.
 *
 * Deliberately at exactly `OFFROAD_HALF_WIDTH`, not further out: that's the
 * edge of the last real terrain collider, and it's already proven clear of
 * self-intersection by `check-track`'s 39 m minimum-corner-radius rule (which
 * exists for the off-road band at this same offset) — reusing the constant
 * needs no new geometry validation.
 */

/** How many track samples to skip between wall segments (samples are ~3 m apart). */
const SAMPLE_STRIDE = 2;
/** Half-length of each segment as a multiple of the stride's along-track distance, so segments overlap and leave no seam. */
const OVERLAP_FACTOR = 1.3;
/** How far the wall reaches below the local ground, in metres — enough that a dip in the terrain can't slip under it. */
const BELOW_GROUND = 4;
/** How far the wall reaches above the local ground, in metres — generous given the Hillclimb Wall jump can send a rider well airborne. */
const ABOVE_GROUND = 14;
const WALL_HALF_THICKNESS = 0.5;

/** Builds the boundary wall's colliders onto the track's existing static body. Purely physical — no render mesh. */
export function buildBoundaryWalls(
  physics: PhysicsWorld,
  body: RAPIER.RigidBody,
  track: TrackDefinition,
): RAPIER.Collider[] {
  const colliders: RAPIER.Collider[] = [];
  const halfHeight = (BELOW_GROUND + ABOVE_GROUND) / 2;
  const centerLift = (ABOVE_GROUND - BELOW_GROUND) / 2;
  const halfLength = (SAMPLE_STRIDE * track.sampleSpacing * OVERLAP_FACTOR) / 2;

  const rotation = new THREE.Quaternion();
  const forward = new THREE.Vector3(0, 0, 1);
  const last = track.samplePoints.length - 1;

  for (let i = 0; i <= last; i += SAMPLE_STRIDE) {
    const center = track.samplePoints[i];
    const right = track.sampleRights[i];
    const tangent = track.sampleTangents[i];
    rotation.setFromUnitVectors(forward, tangent);

    for (const side of [-1, 1] as const) {
      const x = center.x + right.x * side * OFFROAD_HALF_WIDTH;
      const y = center.y + centerLift;
      const z = center.z + right.z * side * OFFROAD_HALF_WIDTH;

      const collider = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(WALL_HALF_THICKNESS, halfHeight, halfLength)
          .setTranslation(x, y, z)
          .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
          .setFriction(0.5)
          .setCollisionGroups(GROUPS_WALL),
        body,
      );
      colliders.push(collider);
    }
  }

  return colliders;
}
