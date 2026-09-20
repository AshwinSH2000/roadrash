import * as THREE from "three";
import type { Racer } from "../entities/Racer";
import { LOCAL_FORWARD, LOCAL_RIGHT, WORLD_UP } from "../utils/Directions";
import {
  ATTACKS,
  AttackKind,
  attackDuration,
  type AttackDefinition,
} from "./AttackDefinitions";

/**
 * Hit detection and knockback, shared by every rider.
 *
 * This is the single path the design requires: `PlayerController` calls
 * `request()` from the P and K keys, and next phase the AI's combat behaviour
 * will call the identical method. There is no separate "AI hits player" code
 * to drift out of sync, and a bot has no reach, timing or force the player
 * doesn't also have.
 *
 * Knockback feeds straight into the fall system built last phase — the
 * impulse goes to `RiderStateMachine.knockOff`, and the resulting tumble
 * comes from the victim's own momentum plus that impulse, not from anything
 * scripted here.
 */

export enum AttackPhase {
  IDLE = "idle",
  WINDUP = "windup",
  ACTIVE = "active",
  RECOVERY = "recovery",
}

interface AttackState {
  definition: AttackDefinition | null;
  phase: AttackPhase;
  elapsed: number;
  /** An attack connects at most once, however many steps its window spans. */
  hasConnected: boolean;
  /** Which side the strike went out on: -1 left, +1 right, 0 while winding up. */
  side: number;
  /** Who this attack may land on; null means anyone. See `request`. */
  canHit: ((victim: Racer) => boolean) | null;
}

export interface CombatSnapshot {
  phase: AttackPhase;
  kind: AttackKind | null;
  side: number;
  /** Seconds until another attack may be started. */
  cooldown: number;
}

/** A landed hit, reported so callers can play sounds or log it. */
export interface HitEvent {
  attacker: Racer;
  victim: Racer;
  kind: AttackKind;
  impulse: number;
  closingSpeed: number;
}

export class CombatSystem {
  private readonly states = new Map<Racer, AttackState>();

  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpToTarget = new THREE.Vector3();
  private readonly tmpImpulse = new THREE.Vector3();
  private readonly tmpRelative = new THREE.Vector3();

  constructor(
    private readonly field: readonly Racer[],
    private readonly onHit?: (hit: HitEvent) => void,
  ) {
    for (const racer of field) {
      this.states.set(racer, {
        definition: null,
        phase: AttackPhase.IDLE,
        elapsed: 0,
        hasConnected: false,
        side: 0,
        canHit: null,
      });
    }
  }

  /**
   * Starts an attack. Returns false if the rider can't — already mid-attack,
   * or not on their bike. Deliberately silent about why; callers just retry.
   *
   * `canHit` restricts who the strike may land on. A strike auto-targets the
   * nearest rider in its cone, and a bot swinging at one rival with the
   * player closer on the same side would otherwise hit the player — which is
   * exactly what the "bots attack you" switch promises won't happen. The
   * player's own attacks pass nothing and hit anyone.
   */
  request(racer: Racer, kind: AttackKind, canHit?: (victim: Racer) => boolean): boolean {
    const state = this.states.get(racer);
    if (!state) return false;
    if (state.phase !== AttackPhase.IDLE) return false;
    if (!racer.rider.isRiding || racer.hasFinished) return false;

    state.definition = ATTACKS[kind];
    state.phase = AttackPhase.WINDUP;
    state.elapsed = 0;
    state.hasConnected = false;
    state.side = 0;
    state.canHit = canHit ?? null;
    return true;
  }

  snapshot(racer: Racer): CombatSnapshot {
    const state = this.states.get(racer);
    if (!state || !state.definition) {
      return { phase: AttackPhase.IDLE, kind: null, side: 0, cooldown: 0 };
    }
    return {
      phase: state.phase,
      kind: state.definition.kind,
      side: state.side,
      cooldown: Math.max(0, attackDuration(state.definition) - state.elapsed),
    };
  }

  tick(dtSeconds: number): void {
    for (const racer of this.field) {
      const state = this.states.get(racer);
      if (!state || !state.definition) continue;

      // Being knocked off cancels whatever you were throwing — you no longer
      // have a bike to throw it from.
      if (state.phase !== AttackPhase.IDLE && !racer.rider.isRiding) {
        this.reset(state);
        continue;
      }

      if (state.phase === AttackPhase.IDLE) continue;

      state.elapsed += dtSeconds;
      const { windup, active } = state.definition;

      if (state.elapsed < windup) {
        state.phase = AttackPhase.WINDUP;
      } else if (state.elapsed < windup + active) {
        state.phase = AttackPhase.ACTIVE;
        if (!state.hasConnected) this.resolveStrike(racer, state);
      } else if (state.elapsed < attackDuration(state.definition)) {
        state.phase = AttackPhase.RECOVERY;
      } else {
        this.reset(state);
      }
    }
  }

  /** Cancels every attack in progress — for a race restart. */
  resetAll(): void {
    for (const state of this.states.values()) this.reset(state);
  }

  private reset(state: AttackState): void {
    state.definition = null;
    state.phase = AttackPhase.IDLE;
    state.elapsed = 0;
    state.hasConnected = false;
    state.side = 0;
    state.canHit = null;
  }

  /**
   * Looks for a rider inside the strike's cone and knocks them off.
   *
   * A strike hits at most one rider — the nearest valid one — however many
   * physics steps its active window covers. A whiff genuinely does nothing:
   * the attacker still pays the recovery, which is what makes range and
   * timing matter rather than making attacks free to spam.
   */
  private resolveStrike(attacker: Racer, state: AttackState): void {
    const definition = state.definition;
    if (!definition) return;

    const bike = attacker.bike;
    this.tmpForward.copy(LOCAL_FORWARD).applyQuaternion(bike.worldQuaternion).setY(0).normalize();
    this.tmpRight.copy(LOCAL_RIGHT).applyQuaternion(bike.worldQuaternion).setY(0).normalize();

    let best: Racer | null = null;
    let bestDistance = Infinity;
    let bestSide = 0;

    for (const victim of this.field) {
      if (victim === attacker || !victim.rider.isRiding || victim.hasFinished) continue;
      if (state.canHit && !state.canHit(victim)) continue;

      this.tmpToTarget.subVectors(victim.bike.worldPosition, bike.worldPosition).setY(0);
      const distance = this.tmpToTarget.length();
      if (distance > definition.range || distance < 1e-3) continue;

      this.tmpToTarget.multiplyScalar(1 / distance);

      // Measured from the attacker's sideways axis, so a rider directly ahead
      // or behind is out of reach however close they are. You swing sideways.
      const alongRight = this.tmpToTarget.dot(this.tmpRight);
      const side = alongRight >= 0 ? 1 : -1;
      const angleFromSide = Math.acos(THREE.MathUtils.clamp(Math.abs(alongRight), -1, 1));
      if (angleFromSide > definition.arc) continue;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = victim;
        bestSide = side;
      }
    }

    state.side = bestSide;
    if (!best) return;
    state.hasConnected = true;

    // Closing speed along the line between them: positive when converging.
    const attackerVelocity = bike.controller.chassisBody.linvel();
    const victimVelocity = best.bike.controller.chassisBody.linvel();
    this.tmpRelative.set(
      attackerVelocity.x - victimVelocity.x,
      0,
      attackerVelocity.z - victimVelocity.z,
    );
    this.tmpToTarget.subVectors(best.bike.worldPosition, bike.worldPosition).setY(0).normalize();
    const closingSpeed = Math.max(0, this.tmpRelative.dot(this.tmpToTarget));

    const strength = definition.knockback * (1 + closingSpeed * definition.closingSpeedBonus);

    // Sideways away from the attacker, with a little lift so the victim comes
    // off the bike rather than being shoved along the road.
    this.tmpImpulse
      .copy(this.tmpToTarget)
      .multiplyScalar(strength)
      .addScaledVector(WORLD_UP, strength * 0.3);

    best.rider.knockOff(this.tmpImpulse);
    this.onHit?.({
      attacker,
      victim: best,
      kind: definition.kind,
      impulse: strength,
      closingSpeed,
    });
  }
}
