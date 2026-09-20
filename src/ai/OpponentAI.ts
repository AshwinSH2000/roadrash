import * as THREE from "three";
import type { Driver, Racer } from "../entities/Racer";
import type { TrackDefinition } from "../track/TrackDefinition";
import { ROAD_HALF_WIDTH } from "../track/TrackDefinition";
import { LOCAL_FORWARD, LOCAL_RIGHT } from "../utils/Directions";
import type { RiderPersonality } from "./RiderPersonality";
import { computeAvoidanceBias } from "./AvoidanceBehavior";
import type { CombatBehavior, CombatIntent } from "./CombatBehavior";

/** Aim point distance: a floor, plus this many seconds of travel at current speed. */
const LOOKAHEAD_BASE = 9;
const LOOKAHEAD_SECONDS = 0.75;

/** How far up the road to scan for corners when deciding a speed, in metres. */
const CORNER_SCAN_DISTANCE = 160;

/**
 * Deceleration the bots plan their braking around, in m/s^2. Deliberately a
 * little under what the brakes can actually do, so a bot that misjudges still
 * has something in reserve rather than sailing straight off the outside.
 */
const PLANNED_BRAKE_DECEL = 6.5;

/** Bots keep this far inside the road edge, so a wobble doesn't put them on the grass. */
const LINE_MARGIN = 1.6;

/** Converts a speed error (m/s) into throttle. 0.5 means full brake at 2 m/s too fast. */
const THROTTLE_GAIN = 0.5;

/**
 * Opponent rider: follows the racing line, brakes for corners, and moves over
 * for other riders. Given a `CombatBehavior` it also, now and then, bends that
 * line toward a rival to throw a punch — see `CombatBehavior` for the rules.
 *
 * The structure is deliberately the same shape as the player's controller: it
 * decides a throttle and a steer value each fixed step and hands them to the
 * bike, using no privileged information and no forces the player can't also
 * generate. A bot is not faster because it cheats; it's faster because it
 * picks a better line and brakes at the right moment.
 */
export class OpponentAI implements Driver {
  /** Speed decision currently being acted on, held across the reaction delay. */
  private heldTargetSpeed = 0;
  private decisionTimer = 0;

  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpToTarget = new THREE.Vector3();

  constructor(
    private readonly self: Racer,
    private readonly track: TrackDefinition,
    private readonly field: readonly Racer[],
    private readonly personality: RiderPersonality,
    /** Optional: without one the bot only races, which is what the driving sims want. */
    private readonly combat: CombatBehavior | null = null,
  ) {}

  tick(dtSeconds: number): void {
    const intent = this.combat?.tick(dtSeconds) ?? null;
    const desiredLateral = this.chooseLine(intent);
    const steerInput = this.steerTowardLine(desiredLateral);
    const throttleInput = this.chooseThrottle(dtSeconds, intent);
    this.self.bike.setInput(throttleInput, steerInput);
  }

  /**
   * Preferred racing line, nudged sideways to avoid other riders, kept on the
   * tarmac. While hunting, the "preferred" line is the one that puts the bot
   * beside its target, and avoidance is switched off against that one rider.
   */
  private chooseLine(intent: CombatIntent | null): number {
    const target = intent?.target ?? null;
    const bias =
      this.personality.dodges === false ? 0 : computeAvoidanceBias(this.self, this.field, target);
    const preferred = target ? intent!.desiredLateral : this.personality.linePreference;
    const limit = ROAD_HALF_WIDTH - LINE_MARGIN;
    return THREE.MathUtils.clamp(preferred + bias, -limit, limit);
  }

  /**
   * Pure-pursuit steering: fits a circular arc from where the bike is now to
   * a point further up the racing line, and commands exactly the steering
   * angle that arc requires.
   *
   * The obvious approach — proportional gain on the angle to the target —
   * was tried and does not work here, because the relationship between "how
   * far off-line am I" and "how much lock do I need" changes completely with
   * speed. At 130 km/h the bike has only about 0.7 degrees of steering lock
   * available (the cornering-acceleration cap divides by v squared), and a
   * 185 m sweeper needs roughly 70% of it while presenting an aim angle of
   * only ~5 degrees. A gain tuned to feel right at 60 km/h therefore
   * commands about a fifth of the lock needed at 130, and the bot understeers
   * off the outside of every fast corner. Measured with `npm run sim:corner`.
   *
   * Pure pursuit has no such gain to mistune: the arc through the aim point
   * has curvature `2*sin(alpha)/d`, the bicycle model turns that into a
   * steering angle via `atan(wheelbase * curvature)`, and dividing by the
   * lock currently available converts it to a -1..1 input. It self-adjusts
   * across the whole speed range, and `steerTrim` is left as a small
   * per-rider stylistic multiplier rather than the thing holding it together.
   *
   * Aiming ahead rather than at the nearest point on the line also stops the
   * bot weaving — by the time it has corrected toward the nearest point it is
   * already somewhere else — and the aim distance grows with speed so it
   * doesn't turn in far too early when quick.
   */
  private steerTowardLine(desiredLateral: number): number {
    const bike = this.self.bike;
    const cfg = bike.controller.tuning;
    const speed = Math.abs(bike.forwardSpeed);
    const lookahead = LOOKAHEAD_BASE + LOOKAHEAD_SECONDS * speed;

    const targetDistance = Math.min(
      this.self.distanceAlong + lookahead,
      this.track.totalLength,
    );
    const target = this.track.spawnPoint(targetDistance, desiredLateral, 0);

    this.tmpForward.copy(LOCAL_FORWARD).applyQuaternion(bike.worldQuaternion);
    this.tmpForward.y = 0;
    this.tmpForward.normalize();

    this.tmpRight.copy(LOCAL_RIGHT).applyQuaternion(bike.worldQuaternion);
    this.tmpRight.y = 0;
    this.tmpRight.normalize();

    this.tmpToTarget.subVectors(target, bike.worldPosition);
    this.tmpToTarget.y = 0;
    const distance = this.tmpToTarget.length();
    if (distance < 1e-3) return 0;

    // Signed angle to the aim point: positive means it lies to the bike's
    // right, matching the sign convention of the bike's steer input.
    const alpha = Math.atan2(
      this.tmpToTarget.dot(this.tmpRight),
      this.tmpToTarget.dot(this.tmpForward),
    );

    const curvature = (2 * Math.sin(alpha)) / distance;
    const requiredAngle = Math.atan(cfg.wheelBase * curvature);

    // `steerLimit` is last tick's value, and is zero on the very first step
    // before any steering has been applied.
    const available = bike.controller.steerLimit || cfg.maxSteerAngle;
    const input = (requiredAngle / available) * this.personality.steerTrim;

    return THREE.MathUtils.clamp(input, -1, 1);
  }

  /**
   * Picks a speed from the corners ahead, then drives the throttle toward it.
   *
   * `speedLimitAhead` already answers "how fast may I be going here to still
   * make everything in the next 160 m", so all this has to do is chase that
   * number. The reaction delay makes the bot commit to a decision for a
   * fraction of a second rather than re-deciding every frame — that costs
   * real time at a braking point, which is most of what separates a quick bot
   * from a slow one, and stops all five braking on the identical frame.
   *
   * A hunting bot additionally caps its speed at what draws it level with
   * its target. The corner limit still wins: nobody rides off the outside of
   * a bend for the sake of a punch.
   */
  private chooseThrottle(dtSeconds: number, intent: CombatIntent | null): number {
    const bike = this.self.bike;
    const cfg = bike.controller.tuning;

    this.decisionTimer -= dtSeconds;
    if (this.decisionTimer <= 0) {
      const cornerLimit = this.track.speedLimitAhead(
        this.self.distanceAlong,
        this.personality.corneringConfidence,
        PLANNED_BRAKE_DECEL,
        CORNER_SCAN_DISTANCE,
      );
      this.heldTargetSpeed = Math.min(
        cfg.topSpeedEstimate * this.personality.topSpeedFraction,
        cornerLimit,
        intent?.target ? intent.desiredSpeed : Infinity,
      );
      this.decisionTimer = this.personality.reactionTime;
    }

    const error = this.heldTargetSpeed - bike.forwardSpeed;
    return THREE.MathUtils.clamp(error * THROTTLE_GAIN, -1, 1);
  }
}
