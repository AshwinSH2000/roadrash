import * as THREE from "three";

/**
 * The two attacks, defined as data.
 *
 * Everything that distinguishes a punch from a kick lives here — reach,
 * width, timing, force — so the combat code itself has no idea which is
 * which. That matters because the AI will be choosing between them next
 * phase, and it should be choosing on numbers rather than on a branch.
 *
 * The trade is the classic one and it needs to be legible while riding: the
 * punch is quick, short and light; the kick is slow, long and heavy. A kick
 * that misses leaves you flailing for more than half a second, which is the
 * cost that makes throwing one a decision.
 */

export enum AttackKind {
  PUNCH = "punch",
  KICK = "kick",
}

export interface AttackDefinition {
  kind: AttackKind;
  /** Seconds of wind-up before the strike can connect. */
  windup: number;
  /** Seconds the strike is live and can connect. */
  active: number;
  /** Seconds afterwards during which no new attack may start. */
  recovery: number;
  /** How far the strike reaches, in metres, measured between chassis centres. */
  range: number;
  /**
   * Half-angle of the strike's cone, in radians, measured from the attacker's
   * sideways axis. A rider must be beside you, not in front or behind.
   */
  arc: number;
  /** Base knockback impulse, in newton-seconds. */
  knockback: number;
  /**
   * How much the closing speed between the two riders adds to the knockback,
   * as a multiplier per m/s. Small on purpose — the victim's ragdoll already
   * inherits their own velocity, so a hit at speed throws them a long way
   * without any help here. This is the extra bite of being caught while
   * closing, not the main effect.
   */
  closingSpeedBonus: number;
}

export const PUNCH: AttackDefinition = {
  kind: AttackKind.PUNCH,
  windup: 0.1,
  active: 0.1,
  recovery: 0.32,
  range: 2.3,
  arc: THREE.MathUtils.degToRad(58),
  knockback: 240,
  closingSpeedBonus: 0.02,
};

export const KICK: AttackDefinition = {
  kind: AttackKind.KICK,
  windup: 0.2,
  active: 0.13,
  recovery: 0.6,
  range: 3.0,
  arc: THREE.MathUtils.degToRad(44),
  knockback: 420,
  closingSpeedBonus: 0.03,
};

export const ATTACKS: Record<AttackKind, AttackDefinition> = {
  [AttackKind.PUNCH]: PUNCH,
  [AttackKind.KICK]: KICK,
};

/** Total time an attack occupies, from input to being able to act again. */
export function attackDuration(definition: AttackDefinition): number {
  return definition.windup + definition.active + definition.recovery;
}
