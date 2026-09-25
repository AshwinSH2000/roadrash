/**
 * Simulated gearbox and tachometer — and, in manual mode, the actual
 * drivetrain physics.
 *
 * In **automatic** mode nothing here feeds back into the physics — drive
 * force still comes from `VehicleController`'s continuous torque curve, and
 * every bot always drives this way. This exists so the bike *sounds* and
 * *reads* like a motorcycle: engine note rising through a gear, dropping at
 * each upshift, settling to an idle when stopped. That per-gear sawtooth is
 * the single strongest cue that a vehicle is accelerating, and a siren-like
 * pitch that only ever rises with speed sounds like a toy.
 *
 * In **manual** mode (requested directly, player-only — bots never use it)
 * gear stops being cosmetic: `manualDrive()` is what `VehicleController`
 * calls instead of the continuous curve, so redline in a gear genuinely caps
 * speed until the player shifts up, and a downshift too far below current
 * speed genuinely fights back with engine braking rather than just being
 * clamped away. See that method's comment for the model.
 *
 * The gear index has always been kept as real state rather than derived on
 * the fly, for exactly this: manual mode needs something to actually shift.
 */

export type TransmissionMode = "automatic" | "manual";

export function isTransmissionMode(value: string | null | undefined): value is TransmissionMode {
  return value === "automatic" || value === "manual";
}

export const IDLE_RPM = 1200;
export const REDLINE_RPM = 11000;

/**
 * Road speed, in m/s, at which each gear reaches the redline. Ratios are
 * expressed this way rather than as gear/final-drive numbers because it makes
 * the one property that matters — where the shifts land relative to the
 * bike's ~40 m/s top speed — directly readable and directly tunable.
 */
const GEAR_TOP_SPEEDS = [8, 14, 20, 27, 33, 40];

const UPSHIFT_RPM = 9800;
const DOWNSHIFT_RPM = 4200;

/**
 * Minimum seconds between shifts. Without it the box hunts audibly at a ratio
 * boundary, since crossing a shift point immediately moves the rpm toward the
 * *other* threshold. Manual shifts obey the same cooldown (a player mashing
 * the shift key shouldn't be able to skip gears faster than a real box can
 * physically move), plus their own, shorter `MANUAL_SHIFT_LOCKOUT` below.
 */
const SHIFT_COOLDOWN = 0.35;

/** How quickly the audible rpm chases the computed one (per second, exponential). */
const RPM_SMOOTHING = 22;

/**
 * Manual mode only, below. All tuned for feel against this game's arcade-sim
 * hybrid physics (see VehicleController's own header comment) — not dyno-
 * matched to a real bike, just shaped the way one behaves.
 */

/** Seconds after a manual shift during which drive force eases back in rather than snapping — a believable shift "kick", and stops shift-spam. */
const MANUAL_SHIFT_LOCKOUT = 0.18;
/** RPM fraction (of idle..redline) below which torque ramps up from nothing — no real engine pulls flat from idle. */
const TORQUE_RAMP_END = 0.12;
/** RPM fraction above which torque falls off hard toward redline — a rev limiter cutting in, not a soft taper. */
const TORQUE_FALLOFF_START = 0.82;
/** Peak per-gear force multiplier, at 1st gear, falling linearly to 1.0 at 6th — so manual and automatic peak the same in top gear, and lower gears genuinely pull harder at the cost of top speed. */
const LOW_GEAR_FORCE_BONUS = 1.4;
/** How far past redline (as a ratio) a mismatched-gear speed has to be before the engine stops merely refusing to pull and starts actively fighting the rider instead. */
const OVER_REV_THRESHOLD = 1.08;
/** Engine-braking strength per unit of ratio past `OVER_REV_THRESHOLD` — how hard a too-low downshift at speed fights back. */
const OVER_REV_BRAKE_SCALE = 3;

/** Smoothstep without a THREE dependency — this file has never needed one. */
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** What `VehicleController.applyDrivetrain()` applies in manual mode — see `manualDrive()`. */
export interface ManualDrive {
  /** Multiplies `cfg.maxEngineForce` alongside throttle — 0 when off the torque band or badly over-revved. */
  forceMultiplier: number;
  /** >0 only when badly over-revved (too low a gear for the current speed) — an extra brake force on top of the normal one. */
  overRevBrakeMultiplier: number;
}

export class Transmission {
  private currentGear = 0;
  private currentRpm = IDLE_RPM;
  private shiftCooldown = 0;
  private mode: TransmissionMode = "automatic";
  /** Counts down after a manual shift — see `MANUAL_SHIFT_LOCKOUT`. */
  private shiftLockout = 0;

  get transmissionMode(): TransmissionMode {
    return this.mode;
  }

  /** Switching mid-race needs no re-sync: automatic keeps the gear matched to speed at every step, so whatever gear is current is already the right one to inherit. */
  setMode(mode: TransmissionMode): void {
    this.mode = mode;
  }

  /** 1-based gear number, for display. */
  get gear(): number {
    return this.currentGear + 1;
  }

  get gearCount(): number {
    return GEAR_TOP_SPEEDS.length;
  }

  get rpm(): number {
    return this.currentRpm;
  }

  /** Engine speed as 0..1 between idle and redline — the form the audio (and HUD) wants. */
  get rpmNormalized(): number {
    return Math.min(1, Math.max(0, (this.currentRpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)));
  }

  /** Manual only: shifts up if a gear remains and the last shift's lockout has cleared. No-op otherwise. */
  shiftUp(): void {
    if (this.mode !== "manual" || this.shiftCooldown > 0) return;
    if (this.currentGear >= GEAR_TOP_SPEEDS.length - 1) return;
    this.currentGear++;
    this.shiftCooldown = SHIFT_COOLDOWN;
    this.shiftLockout = MANUAL_SHIFT_LOCKOUT;
  }

  /** Manual only: shifts down if a gear remains and the last shift's lockout has cleared. No-op otherwise. */
  shiftDown(): void {
    if (this.mode !== "manual" || this.shiftCooldown > 0) return;
    if (this.currentGear <= 0) return;
    this.currentGear--;
    this.shiftCooldown = SHIFT_COOLDOWN;
    this.shiftLockout = MANUAL_SHIFT_LOCKOUT;
  }

  update(forwardSpeed: number, dt: number): void {
    const speed = Math.abs(forwardSpeed);
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    this.shiftLockout = Math.max(0, this.shiftLockout - dt);

    if (this.mode === "automatic") {
      const rawRpm = this.rpmForGear(speed, this.currentGear);
      if (this.shiftCooldown === 0) {
        if (rawRpm > UPSHIFT_RPM && this.currentGear < GEAR_TOP_SPEEDS.length - 1) {
          this.currentGear++;
          this.shiftCooldown = SHIFT_COOLDOWN;
        } else if (rawRpm < DOWNSHIFT_RPM && this.currentGear > 0) {
          this.currentGear--;
          this.shiftCooldown = SHIFT_COOLDOWN;
        }
      }
    }
    // Manual mode: gear only ever moves via shiftUp()/shiftDown() above.

    const target = this.rpmForGear(speed, this.currentGear);
    // Smoothed rather than snapped: the drop at an upshift should still be
    // clearly audible, but an instantaneous jump in oscillator frequency
    // produces a click.
    const blend = 1 - Math.exp(-RPM_SMOOTHING * dt);
    this.currentRpm += (target - this.currentRpm) * blend;
  }

  /** Resets to a standing start — used on respawn so the box doesn't stay in 6th. Mode itself is a driver preference, not standing-start state, and is left alone. */
  reset(): void {
    this.currentGear = 0;
    this.currentRpm = IDLE_RPM;
    this.shiftCooldown = 0;
    this.shiftLockout = 0;
  }

  private rpmForGear(speed: number, gear: number): number {
    const topSpeed = GEAR_TOP_SPEEDS[gear];
    const rpm = (speed / topSpeed) * REDLINE_RPM;
    // Idle is a floor, not an offset: below it the clutch is slipping and the
    // engine is turning at its own pace rather than the wheel's.
    return Math.min(REDLINE_RPM * 1.02, Math.max(IDLE_RPM, rpm));
  }

  /**
   * Manual-mode drive force, as multipliers `VehicleController` applies on
   * top of `cfg.maxEngineForce` — this is the actual physics manual mode
   * adds, not cosmetics. `topSpeedScale` is `(topSpeedEstimate + boost) /
   * topSpeedEstimate`: nitro extends the automatic curve's one top speed, so
   * it needs to extend every gear's effective top speed by the same factor,
   * or boosting in top gear would do nothing once that gear's own redline
   * already caps speed at the un-boosted top speed.
   *
   * Unlike `rpmForGear` (used for display, which clamps at redline), the
   * ratio here is read unclamped: physics needs to see *past* redline to
   * tell "just hit the limiter" (ratio ~1, force tapers to zero) apart from
   * "badly mismatched downshift" (ratio well past 1, the engine should
   * actively fight back — see `OVER_REV_THRESHOLD`).
   */
  manualDrive(forwardSpeed: number, topSpeedScale: number): ManualDrive {
    const speed = Math.abs(forwardSpeed);
    const gearTopSpeed = GEAR_TOP_SPEEDS[this.currentGear] * topSpeedScale;
    const rpmRatio = speed / gearTopSpeed;

    if (rpmRatio > OVER_REV_THRESHOLD) {
      return { forceMultiplier: 0, overRevBrakeMultiplier: (rpmRatio - OVER_REV_THRESHOLD) * OVER_REV_BRAKE_SCALE };
    }

    const clampedRatio = Math.min(1, rpmRatio);
    // Quick climb off idle, flat-ish through the midrange, hard falloff at
    // the top — a rev limiter, not the automatic's smooth asymptote. Floored
    // rather than truly zero at a dead stop: `rpmRatio` is exactly 0 at
    // exactly 0 speed, and a real launch (off the grid, or switching into
    // manual while stationary) can't be left waiting on physics jitter to
    // nudge it off that exact fixed point.
    const rampUp = Math.max(0.05, Math.min(1, clampedRatio / TORQUE_RAMP_END));
    const fallOff = 1 - smoothstep01(TORQUE_FALLOFF_START, 1.0, clampedRatio);
    const torque = rampUp * fallOff;

    // 1.0 at the top gear, rising toward LOW_GEAR_FORCE_BONUS at 1st.
    const gearBonus =
      LOW_GEAR_FORCE_BONUS - (LOW_GEAR_FORCE_BONUS - 1) * (this.currentGear / (GEAR_TOP_SPEEDS.length - 1));

    const lockoutEase = this.shiftLockout > 0 ? 1 - this.shiftLockout / MANUAL_SHIFT_LOCKOUT : 1;

    return { forceMultiplier: torque * gearBonus * lockoutEase, overRevBrakeMultiplier: 0 };
  }
}
