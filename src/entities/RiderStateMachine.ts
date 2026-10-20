import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import { RagdollController } from "../physics/RagdollController";
import { GROUPS_RIDER, GROUPS_WHEEL_RAY } from "../physics/CollisionGroups";
import { LOCAL_FORWARD, LOCAL_UP, WORLD_UP } from "../utils/Directions";
import type { Bike } from "./Bike";
import {
  HIP,
  RagdollVisuals,
  RiderModel,
  STANDING_HIP_HEIGHT,
  type AttackTiming,
  type StrikeKind,
} from "./RiderModel";

/**
 * The knockdown-and-recovery cycle, run identically for the player and for
 * every AI rider. Only who supplies the *riding* input differs; nothing below
 * knows or cares which it is, which is the design's "no divergent AI-vs-player
 * code" requirement applied to the part most likely to sprout two versions.
 *
 *   RIDING -> RAGDOLL -> GETTING_UP -> RUNNING_TO_BIKE -> PICKING_UP -> MOUNTING -> RIDING
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
  PICKING_UP = "picking-up",
  MOUNTING = "mounting",
}

/** Where the rider sits relative to the bike's chassis origin, in metres. */
const SEAT_OFFSET = new THREE.Vector3(0, 0.15, -0.35);

/** Seconds spent hauling themselves upright before they can start running. */
const GETUP_SECONDS = 1.1;
/** Seconds spent hauling the fallen bike upright. */
const PICKUP_SECONDS = 1.1;
/** Seconds for the hurried hop from beside the bike onto the seat. */
const MOUNT_SECONDS = 0.45;
/** Where the rider stands to lift the bike: this far to its side, and this far forward along it, in metres. */
const PICKUP_SIDE_OFFSET = 0.7;
const PICKUP_FORWARD_OFFSET = 0.2;
/** Close enough to the standing spot to start lifting, in metres. */
const SPOT_REACHED = 0.3;
/** The bike must be nearly stopped before it is picked up, in m/s. */
const BIKE_STILL_SPEED = 1.5;
/** Height of the chassis centre above the road when the bike stands on its wheels, in metres. */
const UPRIGHT_CHASSIS_HEIGHT = 1.02;

/** How fast a rider runs on foot, in m/s — a jog, deliberately slower than any bike. */
const RUN_SPEED = 5.2;
/**
 * Give up chasing the bike after this long and remount wherever it is. The
 * race cannot proceed with a rider permanently on foot, and a bike that ends
 * up somewhere unreachable — over an edge, the far side of the terrain — must
 * not strand them for good.
 */
const RUN_TIMEOUT_SECONDS = 20;

const RUNNER_HALF_HEIGHT = 0.5;
const RUNNER_RADIUS = 0.28;
/** Capsule centre height above the ground, i.e. how far below the body the runner's feet are. */
const RUNNER_FEET_OFFSET = RUNNER_HALF_HEIGHT + RUNNER_RADIUS;
/** Strides per second while running. */
const RUN_CYCLE_HZ = 1.8;

export class RiderStateMachine {
  private state = RiderState.RIDING;
  private timer = 0;

  private readonly ragdoll: RagdollController;
  private runnerBody: RAPIER.RigidBody | null = null;
  /** The on-foot figure: the same jointed rider, posed standing, getting up or running. */
  private readonly runner: RiderModel;
  /** 0 when planted, 1 at full stride; eased so stopping at the bike isn't a snap. */
  private runAmplitude = 0;
  /** 0..1: how much of full stride the runner is moving at; eases down on the approach to the bike. */
  private runSpeedFraction = 1;
  /** The lift of the fallen bike: where it was, and where it ends up, standing. */
  private lifting = false;
  private readonly liftStartPos = new THREE.Vector3();
  private readonly liftStartQuat = new THREE.Quaternion();
  private readonly liftEndPos = new THREE.Vector3();
  private readonly liftEndQuat = new THREE.Quaternion();
  private liftHeading = 0;
  /** Which way the rider faced when they started lifting, then the hop's start and end on the ground. */
  private pickupYaw = 0;
  private readonly hopStart = new THREE.Vector3();
  private readonly hopEnd = new THREE.Vector3();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly runnerPrevPos = new THREE.Vector3();
  private readonly runnerCurrPos = new THREE.Vector3();
  private readonly runnerPrevQuat = new THREE.Quaternion();
  private readonly runnerCurrQuat = new THREE.Quaternion();
  /** The seated procedural rider, shown while on the bike. */
  private readonly model: RiderModel;

  private readonly tmpSeat = new THREE.Vector3();
  private readonly tmpLiftOffset = new THREE.Vector3();
  private readonly tmpToBike = new THREE.Vector3();
  private readonly tmpVelocity = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly bike: Bike,
    color: number,
  ) {
    this.model = new RiderModel(color);
    this.bike.addRiderObject(this.model.object);
    this.bike.attachRiderHands(this.model);
    this.ragdoll = new RagdollController(physics, scene, color, new RagdollVisuals(color));

    this.runner = new RiderModel(color);
    this.runner.setVisible(false);
    this.scene.add(this.runner.object);
  }

  /** Plays the seated rider's baton swing or standing kick; see `RiderModel.setAttack`. */
  setAttack(kind: StrikeKind | null, side: number, elapsed: number, timing: AttackTiming): void {
    if (this.state === RiderState.RIDING) this.model.setAttack(kind, side, elapsed, timing);
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
    this.model.setAttack(null, 0, 0, { windup: 0, active: 0, recovery: 0 });
    this.model.setVisible(false);
    this.state = RiderState.RAGDOLL;
    this.timer = 0;
  }

  tick(dtSeconds: number): void {
    this.timer += dtSeconds;
    this.captureRunner();

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
        if (this.timer >= RUN_TIMEOUT_SECONDS) {
          // Out of time (the bike is somewhere unreachable): skip the show and remount.
          this.finishMount();
        } else if (this.runTowardBike()) {
          this.beginPickUp();
        }
        break;

      case RiderState.PICKING_UP:
        this.holdRunner();
        this.updateLift();
        if (this.timer >= PICKUP_SECONDS) this.beginHop();
        break;

      case RiderState.MOUNTING:
        this.holdRunner();
        this.bike.liftTo(this.liftEndPos, this.liftEndQuat);
        if (this.timer >= MOUNT_SECONDS) this.finishMount();
        break;
    }
  }

  private seatPosition(): THREE.Vector3 {
    return this.tmpSeat
      .copy(SEAT_OFFSET)
      .add(this.tmpLiftOffset.set(0, this.bike.rideLift, 0))
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
    this.runner.setVisible(true);
    this.runAmplitude = 0;
    const spawned = this.runnerBody.translation();
    this.runnerCurrPos.set(spawned.x, spawned.y, spawned.z);
    this.runnerPrevPos.copy(this.runnerCurrPos);
    this.runnerCurrQuat.set(0, 0, 0, 1);
    this.runnerPrevQuat.copy(this.runnerCurrQuat);

    this.state = RiderState.GETTING_UP;
    this.timer = 0;
  }

  /** Flat unit vector the bike points along, from its orientation (stays valid when it lies on its side). */
  private bikeHeading(out: THREE.Vector3): THREE.Vector3 {
    out.copy(LOCAL_FORWARD).applyQuaternion(this.bike.worldQuaternion);
    out.y = 0;
    if (out.lengthSq() < 0.09) {
      // Standing on its nose or tail: no usable heading, keep the last one.
      return out.set(Math.sin(this.liftHeading), 0, Math.cos(this.liftHeading));
    }
    return out.normalize();
  }

  /** Where the rider stands to lift the bike: beside it, near the bars, on whichever side they came from. */
  private pickupSpot(out: THREE.Vector3, from: THREE.Vector3): THREE.Vector3 {
    const heading = this.bikeHeading(this.tmpB);
    this.liftHeading = Math.atan2(heading.x, heading.z);
    const lateral = this.tmpC.set(heading.z, 0, -heading.x);
    const side = Math.sign(this.tmpA.subVectors(from, this.bike.worldPosition).dot(lateral)) || 1;
    return out
      .copy(this.bike.worldPosition)
      .addScaledVector(lateral, side * PICKUP_SIDE_OFFSET)
      .addScaledVector(heading, PICKUP_FORWARD_OFFSET)
      .setY(0);
  }

  /** Drives the runner toward the bike's pickup spot. Returns true once there, with the bike nearly still. */
  private runTowardBike(): boolean {
    const body = this.runnerBody;
    if (!body) return true;

    const t = body.translation();
    const here = this.tmpSeat.set(t.x, t.y, t.z);
    this.pickupSpot(this.tmpToBike, here);
    this.tmpToBike.sub(this.tmpSeat.setY(0)).setY(0);
    const distance = this.tmpToBike.length();

    const bikeVelocity = this.bike.controller.chassisBody.linvel();
    const bikeSpeed = Math.hypot(bikeVelocity.x, bikeVelocity.y, bikeVelocity.z);
    if (distance <= SPOT_REACHED && bikeSpeed < BIKE_STILL_SPEED) return true;

    // Horizontal velocity is set directly rather than pushed with forces:
    // running is not a physics problem worth solving, and a velocity target
    // can't accumulate momentum and overshoot the spot. Slows over the last
    // metre so the rider settles beside the bike instead of skidding to a halt.
    this.runSpeedFraction = THREE.MathUtils.clamp(distance / 1.2, 0.3, 1);
    if (distance > 1e-3) this.tmpToBike.multiplyScalar((RUN_SPEED * this.runSpeedFraction) / distance);
    const v = body.linvel();
    body.setLinvel({ x: this.tmpToBike.x, y: v.y, z: this.tmpToBike.z }, true);

    // Face the direction of travel.
    const heading = Math.atan2(this.tmpToBike.x, this.tmpToBike.z);
    if (distance > 0.05) this.setRunnerYaw(heading);
    return false;
  }

  private setRunnerYaw(yaw: number): void {
    if (!this.runnerBody) return;
    const q = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yaw);
    this.runnerBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  }

  /** Keeps the runner planted while they work on the bike. */
  private holdRunner(): void {
    if (!this.runnerBody) return;
    const v = this.runnerBody.linvel();
    this.runnerBody.setLinvel({ x: 0, y: v.y, z: 0 }, true);
  }

  /** Starts hauling the bike up: it leaves the physics and is moved by script until the rider is on. */
  private beginPickUp(): void {
    if (!this.runnerBody) {
      this.finishMount();
      return;
    }
    const t = this.runnerBody.translation();
    // Turn to face the bike.
    this.pickupYaw = Math.atan2(this.bike.worldPosition.x - t.x, this.bike.worldPosition.z - t.z);
    this.setRunnerYaw(this.pickupYaw);

    this.liftStartPos.copy(this.bike.worldPosition);
    this.liftStartQuat.copy(this.bike.worldQuaternion);
    const heading = this.bikeHeading(this.tmpA);
    this.liftHeading = Math.atan2(heading.x, heading.z);
    this.liftEndQuat.setFromAxisAngle(WORLD_UP, this.liftHeading);

    // Where the road is under the bike, so it ends up standing on it.
    const origin = this.tmpB.copy(this.liftStartPos).setY(this.liftStartPos.y + 3);
    const hit = this.physics.world.castRay(
      new RAPIER.Ray(origin, { x: 0, y: -1, z: 0 }),
      12,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      GROUPS_WHEEL_RAY,
      undefined,
      this.bike.controller.chassisBody,
    );
    const groundY = hit ? origin.y - hit.timeOfImpact : this.liftStartPos.y - 0.4;
    this.liftEndPos.set(this.liftStartPos.x, groundY + UPRIGHT_CHASSIS_HEIGHT, this.liftStartPos.z);

    this.bike.beginLift();
    this.lifting = true;
    this.state = RiderState.PICKING_UP;
    this.timer = 0;
  }

  /** Raises the bike upright as the lift progresses, easing in once the rider has a grip. */
  private updateLift(): void {
    const progress = THREE.MathUtils.clamp(this.timer / PICKUP_SECONDS, 0, 1);
    const eased = THREE.MathUtils.smoothstep(progress, 0.25, 0.95);
    this.tmpA.lerpVectors(this.liftStartPos, this.liftEndPos, eased);
    const quat = new THREE.Quaternion().slerpQuaternions(this.liftStartQuat, this.liftEndQuat, eased);
    this.bike.liftTo(this.tmpA, quat);
  }

  /** The bike is up: the rider hurries on, over a short hop from beside it onto the seat. */
  private beginHop(): void {
    const t = this.runnerBody ? this.runnerBody.translation() : { x: 0, y: RUNNER_FEET_OFFSET, z: 0 };
    this.hopStart.set(t.x, t.y - RUNNER_FEET_OFFSET, t.z);
    // The seated hips in the world, then down to the ground the on-foot figure's origin sits on.
    this.hopEnd.copy(HIP).add(this.tmpLiftOffset.set(0, this.bike.rideLift, 0)).applyQuaternion(this.liftEndQuat).add(this.liftEndPos);
    this.hopEnd.y -= STANDING_HIP_HEIGHT;
    this.state = RiderState.MOUNTING;
    this.timer = 0;
  }

  private finishMount(): void {
    if (this.runnerBody) {
      this.physics.world.removeRigidBody(this.runnerBody);
      this.runnerBody = null;
    }
    this.runner.setVisible(false);
    if (this.lifting) {
      this.bike.endLift(this.liftEndPos, this.liftEndQuat);
      this.lifting = false;
    }
    this.bike.setRiderAttached(true);
    this.model.setVisible(true);
    this.state = RiderState.RIDING;
    this.timer = 0;
  }

  /** Records the runner body's transform, once per physics step, for render interpolation. */
  private captureRunner(): void {
    if (!this.runnerBody) return;
    this.runnerPrevPos.copy(this.runnerCurrPos);
    this.runnerPrevQuat.copy(this.runnerCurrQuat);
    const t = this.runnerBody.translation();
    const r = this.runnerBody.rotation();
    this.runnerCurrPos.set(t.x, t.y, t.z);
    this.runnerCurrQuat.set(r.x, r.y, r.z, r.w);
  }

  syncRender(alpha: number): void {
    this.ragdoll.syncRender(alpha);
    if (this.runnerBody && this.runner.object.visible) {
      // The model's origin is on the ground under the hips, not at the capsule centre.
      this.runner.object.position.lerpVectors(this.runnerPrevPos, this.runnerCurrPos, alpha);
      this.runner.object.position.y -= RUNNER_FEET_OFFSET;
      this.runner.object.quaternion.slerpQuaternions(this.runnerPrevQuat, this.runnerCurrQuat, alpha);

      if (this.state === RiderState.GETTING_UP) {
        this.runner.setGetUp(this.timer / GETUP_SECONDS);
      } else if (this.state === RiderState.PICKING_UP) {
        this.posePickUp();
      } else if (this.state === RiderState.MOUNTING) {
        this.poseHop();
      } else {
        // Full stride while chasing the bike, easing off as it nears.
        const target = this.state === RiderState.RUNNING_TO_BIKE ? this.runSpeedFraction : 0;
        this.runAmplitude += (target - this.runAmplitude) * 0.25;
        this.runner.setRun(this.timer * RUN_CYCLE_HZ * Math.PI * 2, this.runAmplitude);
      }
    }
  }

  /** Crouches the rider over the bike with their hands on the near grip and the middle of the bars. */
  private posePickUp(): void {
    const object = this.runner.object;
    object.updateMatrixWorld(true);
    const left = this.bike.gripWorld(1, this.tmpA);
    const right = this.bike.gripWorld(-1, this.tmpB);
    // The near grip is the one closer to the rider; the other hand takes the middle of the bars.
    const origin = object.position;
    const nearIsLeft = left.distanceToSquared(origin) <= right.distanceToSquared(origin);
    const near = (nearIsLeft ? left : right).clone();
    const middle = this.tmpC.addVectors(left, right).multiplyScalar(0.5).clone();
    object.worldToLocal(near);
    object.worldToLocal(middle);
    this.runner.setPickUp(this.timer / PICKUP_SECONDS, near, middle);
  }

  /** Carries the rider over the hop's arc, turning to face along the bike. */
  private poseHop(): void {
    const progress = THREE.MathUtils.clamp(this.timer / MOUNT_SECONDS, 0, 1);
    const eased = THREE.MathUtils.smoothstep(progress, 0, 1);
    const object = this.runner.object;
    object.position.lerpVectors(this.hopStart, this.hopEnd, eased);
    object.position.y += 0.28 * Math.sin(Math.PI * eased);
    // Shortest way round from facing the bike to facing along it.
    let turn = this.liftHeading - this.pickupYaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    object.quaternion.setFromAxisAngle(WORLD_UP, this.pickupYaw + turn * eased);
    this.runner.setHop(eased);
  }

  /** Puts the rider back on the bike immediately — used when a rider is rescued mid-fall. */
  forceRemount(): void {
    if (this.ragdoll.isActive) this.ragdoll.despawn();
    this.finishMount();
  }

  dispose(): void {
    this.ragdoll.dispose();
    if (this.runnerBody) {
      this.physics.world.removeRigidBody(this.runnerBody);
      this.runnerBody = null;
    }
    this.runner.dispose();
    this.model.dispose();
  }
}

/** Re-exported so callers can build a knockback without importing three directly. */
export function upwardKnockback(direction: THREE.Vector3, strength: number): THREE.Vector3 {
  return direction.clone().normalize().multiplyScalar(strength).addScaledVector(LOCAL_UP, strength * 0.35);
}
