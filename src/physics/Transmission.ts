/**
 * Simulated gearbox and tachometer.
 *
 * Nothing here feeds back into the physics — drive force comes from
 * `VehicleController`'s continuous torque curve, and the design specifies a
 * fully automatic transmission for v1. This exists so the bike *sounds* and
 * *reads* like a motorcycle: engine note rising through a gear, dropping at
 * each upshift, settling to an idle when stopped. That per-gear sawtooth is
 * the single strongest cue that a vehicle is accelerating, and a siren-like
 * pitch that only ever rises with speed sounds like a toy.
 *
 * The gear index is kept as real state rather than being derived on the fly,
 * because a manual-transmission mode (a named future cycle) needs something
 * to actually shift.
 */

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
 * *other* threshold.
 */
const SHIFT_COOLDOWN = 0.35;

/** How quickly the audible rpm chases the computed one (per second, exponential). */
const RPM_SMOOTHING = 22;

export class Transmission {
  private currentGear = 0;
  private currentRpm = IDLE_RPM;
  private shiftCooldown = 0;

  /** 1-based gear number, for display. */
  get gear(): number {
    return this.currentGear + 1;
  }

  get rpm(): number {
    return this.currentRpm;
  }

  /** Engine speed as 0..1 between idle and redline — the form the audio wants. */
  get rpmNormalized(): number {
    return Math.min(1, Math.max(0, (this.currentRpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)));
  }

  update(forwardSpeed: number, dt: number): void {
    const speed = Math.abs(forwardSpeed);
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);

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

    const target = this.rpmForGear(speed, this.currentGear);
    // Smoothed rather than snapped: the drop at an upshift should still be
    // clearly audible, but an instantaneous jump in oscillator frequency
    // produces a click.
    const blend = 1 - Math.exp(-RPM_SMOOTHING * dt);
    this.currentRpm += (target - this.currentRpm) * blend;
  }

  /** Resets to a standing start — used on respawn so the box doesn't stay in 6th. */
  reset(): void {
    this.currentGear = 0;
    this.currentRpm = IDLE_RPM;
    this.shiftCooldown = 0;
  }

  private rpmForGear(speed: number, gear: number): number {
    const topSpeed = GEAR_TOP_SPEEDS[gear];
    const rpm = (speed / topSpeed) * REDLINE_RPM;
    // Idle is a floor, not an offset: below it the clutch is slipping and the
    // engine is turning at its own pace rather than the wheel's.
    return Math.min(REDLINE_RPM * 1.02, Math.max(IDLE_RPM, rpm));
  }
}
