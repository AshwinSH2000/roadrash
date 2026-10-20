import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Bike } from "../entities/Bike";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import { LOCAL_BACK, LOCAL_FORWARD } from "../utils/Directions";



export interface ChaseCameraConfig {
  /** Distance behind the bike at a standstill, in metres. */
  followDistance: number;
  /** Extra distance added at top speed. */
  extraDistanceAtSpeed: number;
  followHeight: number;
  extraHeightAtSpeed: number;
  /** Height above the bike's origin that the camera aims at. */
  lookHeight: number;
  /** How far ahead of the bike the aim point slides at top speed, in metres. */
  lookAheadAtSpeed: number;
  /** Seconds for the camera position to close most of the gap to its target. */
  positionSmoothTime: number;
  /** Seconds for the aim point to catch up. Larger than the position's, so the camera settles before the framing does. */
  targetSmoothTime: number;
  baseFov: number;
  fovAtSpeed: number;
  /** Fraction of the bike's lean the camera copies as roll. 0 = level horizon. */
  rollFraction: number;
  /** Gap left between the camera and anything it would otherwise clip into. */
  collisionMargin: number;
  /** The camera never pulls closer than this, even if something is in the way. */
  minDistance: number;
}

export const DEFAULT_CHASE_CAMERA_CONFIG: ChaseCameraConfig = {
  followDistance: 5.5,
  extraDistanceAtSpeed: 2.2,
  followHeight: 2.4,
  extraHeightAtSpeed: 0.5,
  lookHeight: 0.9,
  lookAheadAtSpeed: 7,
  positionSmoothTime: 0.18,
  targetSmoothTime: 0.28,
  baseFov: 60,
  fovAtSpeed: 78,
  rollFraction: 0.35,
  collisionMargin: 0.4,
  minDistance: 1.8,
};

/** Seconds for the camera to move onto the travel direction when a drift starts, and back off it when it ends. */
const DRIFT_BLEND_IN = 0.15;
const DRIFT_BLEND_OUT = 0.8;

/**
 * Spring-arm third-person chase camera.
 *
 * Four things happen here, and each one is doing a specific job:
 *
 *  - **Critically damped smoothing** on both the camera position and its aim
 *    point, so the camera trails the bike instead of being welded to it. It's
 *    a second-order spring rather than an exponential lerp because the
 *    velocity term is what produces the slight lag-then-settle that reads as
 *    weight; a first-order filter just feels mushy.
 *  - **Speed pullback**: distance, height and field of view all open up with
 *    speed. The FOV change does most of the work — widening the frame is the
 *    strongest cue of speed available without post-processing.
 *  - **Collision pullback**: a ray from the bike out to where the camera
 *    wants to be, pulling it in if the terrain is in the way. On a 10% crest
 *    the camera would otherwise sink through the road behind you.
 *  - **Roll**, a fraction of the bike's lean, applied through the camera's up
 *    vector. Full lean would be nauseating and would hide the lean itself;
 *    a third of it registers as commitment to the corner.
 */
export class ChaseCamera {
  private readonly config: ChaseCameraConfig;

  private readonly position = new THREE.Vector3();
  private readonly positionVelocity = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly lookVelocity = new THREE.Vector3();
  private currentFov: number;
  private initialised = false;
  /** True once the player has finished — the rig sits ahead of the bike instead of behind it, looking back at the finish line, so the player can watch who finishes next. See `setReversed`. */
  private reversed = false;

  private readonly tmpDesired = new THREE.Vector3();
  private readonly tmpAnchor = new THREE.Vector3();
  private readonly tmpBack = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  /** Where the arm actually extends from, and which way it looks — `tmpBack`/`tmpForward` themselves when not reversed, swapped when they are. Never used for roll, which always follows the bike's true heading. */
  private readonly tmpArmBack = new THREE.Vector3();
  private readonly tmpArmLook = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();
  /** The camera's up: straight up on the ground, the inside of the loop's path on a loop. */
  private readonly tmpBikeUp = new THREE.Vector3();
  /** 0 when the camera follows the nose, 1 when it follows the direction of travel (drifting). */
  private driftBlend = 0;
  private readonly travelDirection = new THREE.Vector3();
  private readonly tmpDesiredTarget = new THREE.Vector3();
  private readonly tmpFocus = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly physics: PhysicsWorld,
    config: ChaseCameraConfig = DEFAULT_CHASE_CAMERA_CONFIG,
  ) {
    this.config = config;
    this.currentFov = config.baseFov;
    this.camera.fov = config.baseFov;
    this.camera.updateProjectionMatrix();
  }

  get tuning(): ChaseCameraConfig {
    return this.config;
  }

  /**
   * Requested directly: once the player finishes, flip the rig to the
   * bike's front side looking back, so the finish line and any racer still
   * closing on it stay in frame instead of disappearing over the horizon
   * ahead. `restartRace` sets this back to `false` for the next race.
   */
  setReversed(reversed: boolean): void {
    this.reversed = reversed;
  }

  /**
   * @param bike   supplies heading, speed and lean — the shape of the arm.
   * @param focus  what to actually frame. Normally the bike's own position,
   *               but the rider's while they're tumbling or on foot, so a
   *               knockdown stays on screen instead of the camera chasing a
   *               riderless bike into the distance.
   */
  update(bike: Bike, focus: THREE.Vector3, dtSeconds: number): void {
    const cfg = this.config;
    const bikePosition = focus;
    const speedRatio = THREE.MathUtils.clamp(
      Math.abs(bike.forwardSpeed) / bike.controller.tuning.topSpeedEstimate,
      0,
      1,
    );

    // Built from the physics (yaw-only) orientation on purpose: hanging the
    // camera off the leaned/pitched visual transform would swing the whole
    // world every time the bike tips into a corner.
    // On a loop the camera is built from the loop's own smooth path (direction
    // of travel and the ribbon's inward normal), not from the bike's attitude:
    // it turns over with the loop but has no roll of its own, and any wobble in
    // the bike never reaches the picture. A world-up lock was tried and spun
    // the camera half a turn whenever the bike climbed straight up, where
    // "up" and the view direction coincide.
    const ride = bike.controller.currentLoopRide;
    if (ride) {
      this.tmpBikeUp.copy(ride.normal);
      this.tmpForward.copy(ride.tangent);
      this.tmpBack.copy(ride.tangent).negate();
    } else {
      this.tmpBikeUp.set(0, 1, 0);
      this.tmpBack.copy(LOCAL_BACK).applyQuaternion(bike.worldQuaternion).normalize();
      this.tmpForward.copy(LOCAL_FORWARD).applyQuaternion(bike.worldQuaternion).normalize();
      this.followTravelDirectionInDrift(bike, dtSeconds);
    }
    // Reversed: the rig sits on the bike's *front* side and looks back over
    // it — swapped here, and only here, so roll below still always follows
    // the bike's true heading rather than flipping sign when reversed.
    this.tmpArmBack.copy(this.reversed ? this.tmpForward : this.tmpBack);
    this.tmpArmLook.copy(this.reversed ? this.tmpBack : this.tmpForward);

    const distance = cfg.followDistance + cfg.extraDistanceAtSpeed * speedRatio;
    const height = cfg.followHeight + cfg.extraHeightAtSpeed * speedRatio;

    this.tmpAnchor.copy(bikePosition).addScaledVector(this.tmpBikeUp, cfg.lookHeight);
    this.tmpDesired
      .copy(bikePosition)
      .addScaledVector(this.tmpArmBack, distance)
      .addScaledVector(this.tmpBikeUp, height);

    this.tmpFocus.copy(focus);
    this.pullInIfBlocked(bike, distance, height);

    this.tmpDesiredTarget
      .copy(this.tmpAnchor)
      .addScaledVector(this.tmpArmLook, cfg.lookAheadAtSpeed * speedRatio);

    if (!this.initialised) {
      this.position.copy(this.tmpDesired);
      this.lookTarget.copy(this.tmpDesiredTarget);
      this.initialised = true;
    } else {
      springDamp(this.position, this.tmpDesired, this.positionVelocity, cfg.positionSmoothTime, dtSeconds);
      springDamp(this.lookTarget, this.tmpDesiredTarget, this.lookVelocity, cfg.targetSmoothTime, dtSeconds);
    }

    this.camera.position.copy(this.position);

    // Roll via the up vector rather than by rotating after lookAt, so lookAt
    // itself resolves the orientation and there's no order-of-operations trap.
    this.tmpUp
      .copy(this.tmpBikeUp)
      .applyAxisAngle(this.tmpForward, bike.leanAngle * cfg.rollFraction)
      .normalize();
    this.camera.up.copy(this.tmpUp);
    this.camera.lookAt(this.lookTarget);

    const targetFov = THREE.MathUtils.lerp(cfg.baseFov, cfg.fovAtSpeed, speedRatio);
    // Smoothed separately: FOV chasing an instantaneous speed reading pumps
    // visibly under throttle modulation.
    this.currentFov += (targetFov - this.currentFov) * (1 - Math.exp(-4 * dtSeconds));
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * In a drift the nose swings round to side-on in under a second; a camera
   * hung off it would swing with it and lose the bike. So while drifting the
   * camera's heading eases from the nose to the direction the bike is
   * actually travelling, and eases back after, slowly enough that a stopped
   * bike does not whip the view round.
   */
  private followTravelDirectionInDrift(bike: Bike, dtSeconds: number): void {
    const drifting = bike.controller.isDrifting;
    const v = bike.controller.chassisBody.linvel();
    if (drifting && Math.hypot(v.x, v.z) > 3) {
      this.travelDirection.set(v.x, 0, v.z).normalize();
    }
    const rate = drifting ? 1 / DRIFT_BLEND_IN : -1 / DRIFT_BLEND_OUT;
    this.driftBlend = THREE.MathUtils.clamp(this.driftBlend + rate * dtSeconds, 0, 1);
    if (this.driftBlend <= 0 || this.travelDirection.lengthSq() < 0.5) return;

    // The nose may be turned well past 90 degrees from the travel direction,
    // so blend the vectors, not the angles, and keep the camera's pitch flat.
    this.tmpForward.y = 0;
    this.tmpForward.normalize().lerp(this.travelDirection, this.driftBlend).normalize();
    this.tmpBack.copy(this.tmpForward).negate();
  }

  /**
   * Casts from just above the bike toward where the camera wants to sit, and
   * pulls the camera to the near side of anything solid in between. The
   * bike's own chassis is excluded (the ray starts inside it), as are sensors
   * — the finish-line trigger spans the full road and would otherwise yank
   * the camera into the rider's back as they cross it.
   */
  private pullInIfBlocked(bike: Bike, distance: number, height: number): void {
    const cfg = this.config;
    this.tmpDir.subVectors(this.tmpDesired, this.tmpAnchor);
    const fullLength = this.tmpDir.length();
    if (fullLength < 1e-4) return;
    this.tmpDir.multiplyScalar(1 / fullLength);

    const ray = new RAPIER.Ray(this.tmpAnchor, this.tmpDir);
    const hit = this.physics.world.castRay(
      ray,
      fullLength,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      bike.controller.chassisBody,
    );
    if (!hit) return;

    const allowed = Math.max(cfg.minDistance, hit.timeOfImpact - cfg.collisionMargin);
    if (allowed >= fullLength) return;

    // Scale distance and height together so the camera slides along the same
    // arm it was already on, rather than dropping to the bike's own height.
    const scale = allowed / fullLength;
    this.tmpDesired
      .copy(this.tmpFocus)
      .addScaledVector(this.tmpArmBack, distance * scale)
      .addScaledVector(this.tmpBikeUp, cfg.lookHeight + (height - cfg.lookHeight) * scale);
  }
}

/**
 * Critically damped spring step (the standard `SmoothDamp` formulation), run
 * per component. `smoothTime` is roughly how long it takes to close most of
 * the gap. The rational approximation of `exp` is the usual one — it's cheap
 * and stable for large `dt`, which matters because a dropped frame must not
 * make the camera overshoot.
 */
function springDamp(
  current: THREE.Vector3,
  target: THREE.Vector3,
  velocity: THREE.Vector3,
  smoothTime: number,
  dt: number,
): void {
  if (dt <= 0) return;
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  for (const axis of ["x", "y", "z"] as const) {
    const change = current[axis] - target[axis];
    const temp = (velocity[axis] + omega * change) * dt;
    velocity[axis] = (velocity[axis] - omega * temp) * decay;
    current[axis] = target[axis] + (change + temp) * decay;
  }
}
