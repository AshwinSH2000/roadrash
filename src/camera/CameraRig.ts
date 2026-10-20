import * as THREE from "three";
import type { Bike } from "../entities/Bike";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import type { TrackDefinition } from "../track/TrackDefinition";
import { ROAD_HALF_WIDTH } from "../track/TrackDefinition";
import { ChaseCamera, DEFAULT_CHASE_CAMERA_CONFIG, type ChaseCameraConfig } from "./ChaseCamera";

/** The views the player can cycle through with C. */
export type CameraMode = "chase" | "helmet" | "bumper" | "high" | "trackside";

export const CAMERA_MODES: readonly CameraMode[] = ["chase", "helmet", "bumper", "high", "trackside"];

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "CHASE",
  helmet: "HELMET CAM",
  bumper: "BUMPER CAM",
  high: "HIGH VIEW",
  trackside: "TV TRACKSIDE",
};

/** A tall, loose view from well above and behind: sees the corner coming. */
const HIGH_CAMERA_CONFIG: ChaseCameraConfig = {
  ...DEFAULT_CHASE_CAMERA_CONFIG,
  followDistance: 11,
  extraDistanceAtSpeed: 5,
  followHeight: 8.5,
  extraHeightAtSpeed: 2,
  lookHeight: 0.4,
  lookAheadAtSpeed: 16,
  positionSmoothTime: 0.4,
  targetSmoothTime: 0.5,
  baseFov: 52,
  fovAtSpeed: 66,
  rollFraction: 0,
};

/** Helmet cam: a little ahead of the visor; bumper cam: just ahead of the front wheel and low. */
const HELMET_EYE_FORWARD = 0.1;
const BUMPER_OFFSET = new THREE.Vector3(0, -0.1, 1.3);
/** How much of the bike's lean (and loop roll) the first-person views copy. Full lean is nauseating. */
const HELMET_ROLL = 0.5;
const BUMPER_ROLL = 0.4;
const HELMET_FOV = { base: 80, atSpeed: 96 };
const BUMPER_FOV = { base: 72, atSpeed: 90 };
const FIRST_PERSON_NEAR = 0.08;
const DEFAULT_NEAR = 0.1;

/** Trackside: how far ahead of the bike the camera is set up, how far beside the road, how high, and when to move on. */
const TRACKSIDE_AHEAD = 60;
const TRACKSIDE_OFFSET = ROAD_HALF_WIDTH + 4.5;
const TRACKSIDE_HEIGHT = 2.2;
const TRACKSIDE_PASSED = 22;
const TRACKSIDE_LOST = 140;
/** Half-height of the subject to keep in frame (metres), and the FOV limits (degrees). */
const TRACKSIDE_SUBJECT = 3.4;
const TRACKSIDE_MIN_FOV = 14;
const TRACKSIDE_MAX_FOV = 62;

/** What the rig needs to know each frame beyond the bike itself. */
export interface CameraContext {
  /** False once the rider is off the bike: every mode then falls back to the chase view that frames the fall. */
  riding: boolean;
  /** The player's distance along the track, for the trackside camera. */
  distanceAlong: number;
}

/**
 * Owns the camera modes. The chase view is the existing `ChaseCamera`; the
 * high view is a second one with a different arm. The helmet and bumper views
 * hang off the bike's own (leaned, pitched) transform. The trackside view sets
 * itself up beside the road ahead, as a broadcast camera would, tracks the bike
 * past and moves on to the next spot.
 *
 * Any mode falls back to the chase view while the rider is off the bike or
 * after the player has finished, because those views frame the fall and the
 * finish line and the others cannot.
 */
export class CameraRig {
  readonly chase: ChaseCamera;
  private readonly high: ChaseCamera;
  private _mode: CameraMode = "chase";
  private applied: CameraMode | null = null;
  private reversed = false;

  private readonly eye = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly yawQuat = new THREE.Quaternion();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly world = new THREE.Vector3(0, 1, 0);
  private currentFov = 70;

  private readonly trackPos = new THREE.Vector3();
  private readonly trackLook = new THREE.Vector3();
  private trackPlacedAt = Number.NaN;
  private trackSide = 1;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    physics: PhysicsWorld,
    private readonly track: TrackDefinition,
  ) {
    this.chase = new ChaseCamera(camera, physics);
    this.high = new ChaseCamera(camera, physics, HIGH_CAMERA_CONFIG);
  }

  get mode(): CameraMode {
    return this._mode;
  }

  /** Moves to the next view and returns it. */
  cycle(): CameraMode {
    this._mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this._mode) + 1) % CAMERA_MODES.length];
    return this._mode;
  }

  setReversed(reversed: boolean): void {
    this.reversed = reversed;
    this.chase.setReversed(reversed);
  }

  update(bike: Bike, focus: THREE.Vector3, dtSeconds: number, context: CameraContext): void {
    const mode: CameraMode = !context.riding || this.reversed ? "chase" : this._mode;
    if (mode !== this.applied) this.enter(mode);
    // The helmet is hidden in the helmet view, so the camera is not inside it.
    bike.setRiderHeadVisible(mode !== "helmet");

    switch (mode) {
      case "chase":
        this.chase.update(bike, focus, dtSeconds);
        break;
      case "high":
        this.high.update(bike, focus, dtSeconds);
        break;
      case "helmet":
        this.firstPerson(bike, dtSeconds, true);
        break;
      case "bumper":
        this.firstPerson(bike, dtSeconds, false);
        break;
      case "trackside":
        this.trackside(bike, dtSeconds, context.distanceAlong);
        break;
    }
  }

  private enter(mode: CameraMode): void {
    this.applied = mode;
    const near = mode === "helmet" || mode === "bumper" ? FIRST_PERSON_NEAR : DEFAULT_NEAR;
    if (this.camera.near !== near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    this.camera.up.set(0, 1, 0);
    if (mode === "chase") this.chase.reset();
    if (mode === "high") this.high.reset();
    if (mode === "trackside") this.trackPlacedAt = Number.NaN;
    this.currentFov = this.camera.fov;
  }

  private setFov(target: number, dtSeconds: number, rate = 5): void {
    this.currentFov += (target - this.currentFov) * (1 - Math.exp(-rate * dtSeconds));
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Helmet cam (the rider's eyes, turning with his head — so reversing looks
   * over his shoulder) or bumper cam (low, ahead of the front wheel). Both
   * ride the bike's drawn transform, so they lean and pitch with it, scaled
   * back so the horizon does not swing all the way over.
   */
  private firstPerson(bike: Bike, dtSeconds: number, helmet: boolean): void {
    const group = bike.renderGroup;
    group.updateMatrixWorld(true);

    if (helmet) {
      const head = bike.riderHead;
      if (head) {
        head.getWorldPosition(this.eye);
        // Where the head points: the bike's heading, turned by the head's own yaw.
        this.yawQuat.setFromAxisAngle(this.world, head.rotation.y);
      } else {
        group.localToWorld(this.eye.set(0, 0.55, -0.1));
        this.yawQuat.identity();
      }
    } else {
      group.localToWorld(this.eye.copy(BUMPER_OFFSET));
      this.yawQuat.identity();
    }

    // Bike orientation, then the head's turn in the bike's own frame.
    this.tmpQuat.copy(group.quaternion).multiply(this.yawQuat);
    this.dir.set(0, 0, 1).applyQuaternion(this.tmpQuat);
    if (helmet) this.eye.addScaledVector(this.dir, HELMET_EYE_FORWARD);

    // On a loop the bike goes over; the camera goes with it rather than blending toward a world up it has turned away from.
    const onLoop = bike.controller.currentLoopRide !== null;
    this.up.set(0, 1, 0).applyQuaternion(group.quaternion);
    if (!onLoop) this.up.lerp(this.world, 1 - (helmet ? HELMET_ROLL : BUMPER_ROLL)).normalize();

    this.camera.position.copy(this.eye);
    this.camera.up.copy(this.up);
    this.look.copy(this.eye).add(this.dir);
    this.camera.lookAt(this.look);

    const speedRatio = THREE.MathUtils.clamp(Math.abs(bike.forwardSpeed) / bike.controller.tuning.topSpeedEstimate, 0, 1);
    const fov = helmet ? HELMET_FOV : BUMPER_FOV;
    this.setFov(THREE.MathUtils.lerp(fov.base, fov.atSpeed, speedRatio), dtSeconds);
  }

  /** A fixed camera beside the road ahead that follows the bike past, then picks the next spot. */
  private trackside(bike: Bike, dtSeconds: number, distanceAlong: number): void {
    const placed = this.trackPlacedAt;
    if (Number.isNaN(placed) || distanceAlong > placed + TRACKSIDE_PASSED || distanceAlong < placed - TRACKSIDE_LOST) {
      this.placeTrackside(distanceAlong);
      this.trackLook.copy(bike.worldPosition);
    }

    this.trackLook.lerp(bike.worldPosition, 1 - Math.exp(-dtSeconds / 0.07));
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(this.trackPos);
    this.look.copy(this.trackLook).y += 0.8;
    this.camera.lookAt(this.look);

    // Zoom to keep the bike the same size on screen whatever the distance.
    const distance = Math.max(this.trackPos.distanceTo(this.look), 1);
    const fov = THREE.MathUtils.clamp((2 * Math.atan(TRACKSIDE_SUBJECT / distance) * 180) / Math.PI, TRACKSIDE_MIN_FOV, TRACKSIDE_MAX_FOV);
    this.setFov(fov, dtSeconds, 8);
  }

  private placeTrackside(distanceAlong: number): void {
    const at = Math.min(distanceAlong + TRACKSIDE_AHEAD, this.track.finishDistance);
    const index = this.track.sampleIndexAt(at);
    this.trackPlacedAt = at;
    this.trackPos
      .copy(this.track.samplePoints[index])
      .addScaledVector(this.track.sampleRights[index], this.trackSide * TRACKSIDE_OFFSET);
    this.trackPos.y += TRACKSIDE_HEIGHT;
    this.trackSide = -this.trackSide;
  }
}
