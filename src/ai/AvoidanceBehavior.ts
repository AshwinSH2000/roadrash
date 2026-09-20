import * as THREE from "three";
import type { Racer } from "../entities/Racer";

/**
 * How far ahead a rider is worth reacting to, in metres. Beyond this the gap
 * will have changed completely by the time you get there.
 */
const AVOID_LOOKAHEAD = 22;
/** Riders further behind than this are no longer a reason to move over. */
const AVOID_BEHIND = 3;
/** Lateral separation, in metres, beyond which another rider isn't in the way. */
const AVOID_WIDTH = 3.2;
/** Metres of sideways bias a single rider directly ahead produces. */
const AVOID_STRENGTH = 3.5;
/** Total bias is capped so a crowd can't shove a bot clean off the road. */
const MAX_BIAS = 5;

/**
 * How far sideways this rider should move to avoid the others, in metres.
 * Positive is track-right.
 *
 * Deliberately a *bias on the desired line* rather than a steering override:
 * it feeds into the same target-point calculation the bot uses normally, so
 * avoidance and cornering blend instead of fighting each other for control of
 * the bars. A bot dodging a rival mid-corner still tracks the corner.
 *
 * `ignore` is the rider this bot is currently hunting, if any: avoidance is
 * suppressed against them, or the bot could never get close enough to swing.
 * Everyone else is still avoided as usual, so a fight doesn't cause a pile-up.
 */
export function computeAvoidanceBias(
  self: Racer,
  field: readonly Racer[],
  ignore: Racer | null = null,
): number {
  let bias = 0;

  for (const other of field) {
    if (other === self || other === ignore || other.hasFinished) continue;

    const gap = other.distanceAlong - self.distanceAlong;
    if (gap < -AVOID_BEHIND || gap > AVOID_LOOKAHEAD) continue;

    const lateralGap = other.lateralOffset - self.lateralOffset;
    if (Math.abs(lateralGap) > AVOID_WIDTH) continue;

    // Closer riders matter more; one 20 m ahead barely registers.
    const urgency = 1 - THREE.MathUtils.clamp(gap / AVOID_LOOKAHEAD, 0, 1);

    // Move away from where they are. When two riders are exactly abreast the
    // sign is ambiguous, and defaulting it would send every bot the same way
    // and cause the pile-up it's meant to prevent — so the tie is broken by
    // which side of the road this rider already prefers.
    const direction =
      Math.abs(lateralGap) < 0.05
        ? Math.sign(self.lateralOffset) || 1
        : -Math.sign(lateralGap);

    bias += direction * AVOID_STRENGTH * urgency;
  }

  return THREE.MathUtils.clamp(bias, -MAX_BIAS, MAX_BIAS);
}
