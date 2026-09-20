import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import { RagdollController } from "../physics/RagdollController";
import { GROUPS_RIDER } from "../physics/CollisionGroups";
import { LOCAL_UP, WORLD_UP } from "../utils/Directions";
import type { Bike } from "./Bike";

/**
 * The knockdown-and-recovery cycle, run identically for the player and for
 * every AI rider. Only who supplies the *riding* input differs; nothing below
 * knows or cares which it is, which is the design's "no divergent AI-vs-player
 * code" requirement applied to the part most likely to sprout two versions.
 *
 *   RIDING -> RAGDOLL -> GETTING_UP -> RUNNING_TO_BIKE -> MOUNTING -> RIDING
 *
 * The plan lists a separate FALLING state ahead of RAGDOLL. It collapsed into
 * RAGDOLL during implementation: with a physics-driven fall there is nothing
 * for a distinct FALLING state to *do* — the bodies are already tumbling from
 * the moment they spawn, and the transition out is a settle test rather than
 * an animation ending.
 */
export enum RiderState {
  RIDING = "riding",
  RAGDOLL = "ragdoll",
  GETTING_UP = "getting-up",
  RUNNING_TO_BIKE = "running-to-bike",
  MOUNTING = "mounting",
}

/** Where the rider sits relative to the bike's chassis origin, in metres. */
const SEAT_OFFSET = new THREE.Vector3(0, 0.75, -0.1);

/** Seconds spent hauling themselves upright before they can start running. */
const GETUP_SECONDS = 1.1;
/** Seconds spent climbing back on once they reach the bike. */
const MOUNT_SECONDS = 0.7;

/** How fast a rider runs on foot, in m/s — a jog, deliberately slower than any bike. */
const RUN_SPEED = 5.2;
/** Close enough to the bike to start climbing on, in metres. */
const MOUNT_RANGE = 1.6;
/**
 * Give up chasing the bike after this long and remount wherever it is. The
 * race cannot proceed with a rider permanently on foot, and a bike that ends
 * up somewhere unreachable — over an edge, the far side of the terrain — must
 * not strand them for good.
 */
const RUN_TIMEOUT_SECONDS = 20;

const RUNNER_HALF_HEIGHT = 0.5;
const RUNNER_RADIUS = 0.28;

export class RiderStateMachine {
  private state = RiderState.RIDING;
  private timer = 0;

  private readonly ragdoll: RagdollController;
  private runnerBody: RAPIER.RigidBody | null = null;
  private readonly runnerMesh: THREE.Mesh;

  private readonly tmpSeat = new THREE.Vector3();
  private readonly tmpToBike = new THREE.Vector3();
  private readonly tmpVelocity = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly bike: Bike,
    color: number,
  ) {
    this.ragdoll = new RagdollController(physics, scene, color);

    this.runnerMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(RUNNER_RADIUS, RUNNER_HALF_HEIGHT * 2, 4, 10),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
    );
    this.runnerMesh.castShadow = true;
    this.runnerMesh.visible = false;
    this.scene.add(this.runnerMesh);
  }

  get current(): RiderState {
    return this.state;
  }

  get isRiding(): boolean {
    return this.state === RiderState.RIDING;
  }

  /** Position the chase camera should watch — the bike, or the rider once they're off it. */
  get cameraPosition(): THREE.Vector3 {
    if (this.state === RiderState.RAGDOLL) return this.ragdoll.pelvisPosition;
    if (this.runnerBody) {
      const t = this.runnerBody.translation();
      return this.tmpSeat.set(t.x, t.y, t.z);
    }
    return this.bike.worldPosition;
  }

  /** Diagnostic passthrough — see `RagdollController.peakSpeeds`. */
  get ragdollPeakSpeeds(): { linear: number; angular: number } {
    return this.ragdoll.peakSpeeds;
  }

  /** Live ragdoll body count; asserted back to zero after teardown. */
  get ragdollBodyCount(): number {
    return this.ragdoll.bodyCount;
  }

  /**
   * Throws the rider off. `impulse` is whatever hit them — a punch, a kick,
   * or a debug key. The tumble itself is not scripted: the ragdoll inherits
   * the bike's current velocity, so speed at the moment of impact is what
   * decides how far they go.
   */
  knockOff(impulse: THREE.Vector3): void {
    if (this.state !== RiderState.RIDING) return;

    const seat = this.seatPosition();
    const v = this.bike.controller.chassisBody.linvel();
    this.tmpVelocity.set(v.x, v.y, v.z);

    this.ragdoll.spawn(seat, this.bike.worldQuaternion, this.tmpVelocity, impulse);
    this.bike.setRiderAttached(false);
    this.state = RiderState.RAGDOLL;
    this.timer = 0;
  }

  tick(dtSeconds: number): void {
    this.timer += dtSeconds;

    switch (this.state) {
      case RiderState.RIDING:
        break;

      case RiderState.RAGDOLL:
        if (this.ragdoll.tick(dtSeconds)) {
          this.beginGetUp();
        }
        break;

      case RiderState.GETTING_UP:
        if (this.timer >= GETUP_SECONDS) {
          this.state = RiderState.RUNNING_TO_BIKE;
          this.timer = 0;
        }
        break;

      case RiderState.RUNNING_TO_BIKE:
        if (this.runTowardBike() || this.timer >= RUN_TIMEOUT_SECONDS) {
          this.state = RiderState.MOUNTING;
          this.timer = 0;
        }
        break;

      case RiderState.MOUNTING:
        if (this.timer >= MOUNT_SECONDS) this.finishMount();
        break;
    }
  }

  private seatPosition(): THREE.Vector3 {
    return this.tmpSeat
      .copy(SEAT_OFFSET)
      .applyQuaternion(this.bike.worldQuaternion)
      .add(this.bike.worldPosition);
  }

  /**
   * Swaps the ragdoll for a single upright capsule. Rotations are locked so
   * it can't fall over again while walking, and the mesh is parked at the
   * ragdoll's final resting place so the rider appears to stand up where they
   * landed rather than teleporting.
   */
  private beginGetUp(): void {
    const restingPlace = this.ragdoll.pelvisPosition.clone();
    this.ragdoll.despawn();

    this.runnerBody = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(restingPlace.x, restingPlace.y + RUNNER_HALF_HEIGHT, restingPlace.z)
        .setLinearDamping(0.5)
        .enabledRotations(false, true, false),
    );
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(RUNNER_HALF_HEIGHT, RUNNER_RADIUS)
        .setMass(78)
        .setFriction(0.8)
        .setCollisionGroups(GROUPS_RIDER),
      this.runnerBody,
    );
    this.runnerMesh.visible = true;

    this.state = RiderState.GETTING_UP;
    this.timer = 0;
  }

  /** Drives the runner toward the bike. Returns true once they're close enough to climb on. */
  private runTowardBike(): boolean {
    const body = this.runnerBody;
    if (!body) return true;

    const t = body.translation();
    this.tmpToBike.copy(this.bike.worldPosition).sub(this.tmpSeat.set(t.x, t.y, t.z));
    this.tmpToBike.y = 0;
    const distance = this.tmpToBike.length();
    if (distance <= MOUNT_RANGE) return true;

    // Horizontal velocity is set directly rather than pushed with forces:
    // running is not a physics problem worth solving, and a velocity target
    // can't accumulate momentum and overshoot the bike.
    this.tmpToBike.multiplyScalar(RUN_SPEED / distance);
    const v = body.linvel();
    body.setLinvel({ x: this.tmpToBike.x, y: v.y, z: this.tmpToBike.z }, true);

    // Face the direction of travel.
    const heading = Math.atan2(this.tmpToBike.x, this.tmpToBike.z);
    const q = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, heading);
    body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    return false;
  }

  private finishMount(): void {
    if (this.runnerBody) {
      this.physics.world.removeRigidBody(this.runnerBody);
      this.runnerBody = null;
    }
    this.runnerMesh.visible = false;
    this.bike.setRiderAttached(true);
    this.state = RiderState.RIDING;
    this.timer = 0;
  }

  syncRender(): void {
    this.ragdoll.syncRender();
    if (this.runnerBody && this.runnerMesh.visible) {
      const t = this.runnerBody.translation();
      const r = this.runnerBody.rotation();
      this.runnerMesh.position.set(t.x, t.y, t.z);
      this.runnerMesh.quaternion.set(r.x, r.y, r.z, r.w);
      // Slumped while getting up, upright once running.
      if (this.state === RiderState.GETTING_UP) {
        const progress = THREE.MathUtils.clamp(this.timer / GETUP_SECONDS, 0, 1);
        this.runnerMesh.quaternion.multiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0),
            (1 - progress) * Math.PI * 0.5,
          ),
        );
      }
    }
  }

  /** Puts the rider back on the bike immediately — used when a rider is rescued mid-fall. */
  forceRemount(): void {
    if (this.ragdoll.isActive) this.ragdoll.despawn();
    this.finishMount();
  }

  dispose(): void {
    this.ragdoll.despawn();
    if (this.runnerBody) {
      this.physics.world.removeRigidBody(this.runnerBody);
      this.runnerBody = null;
    }
    this.scene.remove(this.runnerMesh);
  }
}

/** Re-exported so callers can build a knockback without importing three directly. */
export function upwardKnockback(direction: THREE.Vector3, strength: number): THREE.Vector3 {
  return direction.clone().normalize().multiplyScalar(strength).addScaledVector(LOCAL_UP, strength * 0.35);
}
