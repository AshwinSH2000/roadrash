import * as THREE from "three";
import type { Racer } from "../entities/Racer";
import type { CombatSystem } from "../combat/CombatSystem";
import { AttackPhase } from "../combat/CombatSystem";
import { ATTACKS, AttackKind, type AttackDefinition } from "../combat/AttackDefinitions";
import { ROAD_HALF_WIDTH } from "../track/TrackDefinition";
import { LOCAL_RIGHT } from "../utils/Directions";
import type { RiderPersonality } from "./RiderPersonality";

/**
 * Opportunistic AI combat.
 *
 * A bot is a racer first. Every quarter second it glances at whoever is
 * alongside; if someone is close enough to be worth it, it rolls against its
 * `aggression` and — sometimes — decides to go for them. That opens a short
 * *engagement*: for a few seconds the bot's racing line is bent toward the
 * target's side and its speed is matched to theirs, so it pulls alongside
 * instead of past. It does not swing the moment it draws level, though:
 * once truly alongside (`STRIKE_GAP`), it has to accumulate a fresh random
 * 2-5 s stand-off (`STRIKE_DELAY_MIN`/`MAX`) before a strike is even allowed
 * to be attempted — requested directly, so the target has a real window to
 * notice and pull away rather than eating a hit the instant someone draws
 * level. Only once that wait is up, and only if the geometry still says a
 * strike will connect, does it throw one — through the very same
 * `CombatSystem.request()` the player's P and K keys use, since a bot has
 * no reach, timing or force the player lacks.
 *
 * Whether the swing lands or not, the engagement ends with it and the bot
 * goes back to racing for a cooldown. That single rule is what keeps fights
 * occasional rather than constant, and what makes an infinite fight loop
 * impossible: a bot that has just swung is not allowed to want to swing again
 * for several seconds, by which time the road has usually separated them.
 *
 * Who may be attacked is a *setting*, not a personality trait: by default the
 * bots fight each other and leave the human alone. The switch that lets them
 * come for the player lives on screen (see `Game.createSettingsPanel`).
 */

export interface AiCombatSettings {
  /** May bots attack the human player? Off by default — an opt-in on the screen. */
  botsAttackPlayer: boolean;
  /** May bots attack each other? On by default; the pack fighting is the point. */
  botsAttackBots: boolean;
}

export const DEFAULT_AI_COMBAT_SETTINGS: Readonly<AiCombatSettings> = {
  botsAttackPlayer: false,
  botsAttackBots: true,
};

/** What the bot wants from its driving this tick, as a result of its combat state. */
export interface CombatIntent {
  /** The rider being hunted, or null when the bot is simply racing. */
  target: Racer | null;
  /** Where to be across the road while hunting, in metres right of centre. */
  desiredLateral: number;
  /** Speed to hold while hunting, in m/s, so the bot draws level rather than driving past. */
  desiredSpeed: number;
}

/** How often a bot re-evaluates whether anyone is worth a fight, in seconds. */
const DECISION_INTERVAL = 0.25;

/**
 * Chance, per decision with a candidate alongside, that a bot with aggression
 * 1.0 decides to go for them. Slugger (0.9) commits within about a second of
 * someone appearing beside him; Natasha (0.5) usually lets them pass.
 */
const ENGAGE_CHANCE = 0.3;

/**
 * No fights below this speed, in m/s (about 30 km/h). A punch-up on the grid
 * at walking pace looks silly, costs the victim a fortune for no skill on
 * the attacker's part, and leaves a knocked-off rider standing next to a
 * bike that hasn't gone anywhere. Fights are for the road.
 */
const MIN_ENGAGE_SPEED = 8;

/**
 * The player bias the plan asks for, "so fights actually happen": with the
 * switch on, a bot picks the player over a bot at up to this ratio of the
 * distance, and rolls to engage them this much more keenly. Six riders on
 * one road would otherwise mostly fight among themselves, and the human
 * who opted in to being attacked would rarely see it.
 */
const PLAYER_DISTANCE_WEIGHT = 0.6;
const PLAYER_ENGAGE_BONUS = 1.6;

/** A rider this far ahead or behind along the road (metres) is a possible target. */
const HUNT_GAP = 9;
/** ...and this far across the road. Wider than the road is pointless. */
const HUNT_WIDTH = 7;

/**
 * How long a bot stays *alongside* a target before giving up, in seconds,
 * from timid to keen. The clock only runs while the target is within
 * `STRIKE_GAP` along the road; while they are still approaching the bot is
 * merely waiting for them, and waiting costs nothing. Without that
 * distinction a bot that picked a rider 9 m behind would give up on them at
 * the exact moment they drew level. A bot that could chase forever, on the
 * other hand, would follow a faster rider all the way down the road — hence
 * the hard ceiling on the whole affair, `MAX_CHASE_SECONDS`.
 */
const ENGAGE_SECONDS_MIN = 3.0;
const ENGAGE_SECONDS_MAX = 7.0;
/** Along-road gap within which a strike is geometrically possible at all, so the engage clock runs. */
const STRIKE_GAP = 3.5;
/**
 * Ceiling on one chase from start to finish, whatever the target does.
 * Raised alongside `ENGAGE_SECONDS_MAX`/`STRIKE_DELAY_MAX` below — an
 * aggressive bot now needs room for the approach plus a full 5 s stand-off,
 * not just the old instant-swing window.
 */
const MAX_CHASE_SECONDS = 12;

/**
 * Requested directly: bots were throwing a punch or kick the instant they
 * drew level, giving the target no chance to see it coming and pull away.
 * Once alongside (`STRIKE_GAP`), a bot now has to accumulate a fresh random
 * 2-5 s of *cumulative* time spent there before it's allowed to swing at
 * all — geometry (`tryStrike`) still gates the actual hit, this just delays
 * when it's first allowed to try. The clock pauses (doesn't reset) if the
 * gap briefly wobbles back outside `STRIKE_GAP`, since that happens
 * constantly in a real race through corners and speed changes; it only
 * clears fully if the target is genuinely dropped (see `tick`).
 */
const STRIKE_DELAY_MIN = 2.0;
const STRIKE_DELAY_MAX = 5.0;

/**
 * Seconds of plain racing after a swing or an abandoned chase, from keen to
 * timid. This, not the engage chance, is the main knob on how often the pack
 * fights: at 0.9 aggression a bot swings at most once every ~3 s of being
 * next to someone; at 0.5, once every ~6.
 */
const COOLDOWN_MIN = 2.5;
const COOLDOWN_MAX = 8;

/**
 * Lateral separation the bot aims for while hunting, in metres. Inside the
 * punch's 1.6 m reach with a little room to spare, but not so close that the
 * two chassis boxes trade paint before the strike goes out.
 */
const STRIKE_LATERAL = 1.3;

/** Speed correction per metre of along-road gap while pulling alongside, in 1/s. */
const GAP_GAIN = 1.2;
/**
 * Cap on that correction, in m/s. A bot waiting for a rider 9 m behind would
 * otherwise back off by 40 km/h on a straight, which reads as a breakdown,
 * not an ambush.
 */
const MAX_GAP_CORRECTION = 4;
/** Never crawl for a target; a bot that slows to nothing just gets passed by everyone. */
const MIN_HUNT_SPEED = 8;

/** Bots keep this far inside the road edge — same margin the racing line uses. */
const LINE_MARGIN = 1.6;

/** When both attacks would connect, how often the bot picks the quick one over the heavy one. */
const PUNCH_PREFERENCE = 0.65;

export class CombatBehavior {
  private target: Racer | null = null;
  /** Seconds of alongside-time left in the current engagement. */
  private engageTimer = 0;
  /** Seconds since the current engagement began, against `MAX_CHASE_SECONDS`. */
  private chaseElapsed = 0;
  private cooldownTimer = 0;
  private decisionTimer = 0;
  /**
   * Seconds still to wait, alongside, before a strike may be attempted at
   * all — `null` while not currently alongside (see `STRIKE_DELAY_MIN`/`MAX`
   * above). Rolled fresh each time the bot becomes alongside its target.
   */
  private strikeDelay: number | null = null;

  /**
   * For sims and tuning: how often this bot went hunting, how often it swung,
   * and how the chases that didn't end in a swing ended — `expired` ran out
   * of patience alongside or hit the chase ceiling, `lost` had the target
   * leave the hunting window (or fall, or finish) first.
   */
  readonly stats = { engagements: 0, attacks: 0, expired: 0, lost: 0 };

  private readonly intent: CombatIntent = { target: null, desiredLateral: 0, desiredSpeed: 0 };

  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpRelative = new THREE.Vector3();
  private readonly tmpPredicted = new THREE.Vector3();

  constructor(
    private readonly self: Racer,
    private readonly field: readonly Racer[],
    private readonly combat: CombatSystem,
    private readonly personality: RiderPersonality,
    private readonly settings: Readonly<AiCombatSettings>,
    /** Injectable so headless sims can be seeded and repeatable. */
    private readonly random: () => number = Math.random,
  ) {}

  get currentTarget(): Racer | null {
    return this.target;
  }

  /** Forget the current chase and any cooldown — for a race restart. */
  reset(): void {
    this.target = null;
    this.engageTimer = 0;
    this.chaseElapsed = 0;
    this.cooldownTimer = 0;
    this.decisionTimer = 0;
    this.strikeDelay = null;
  }

  tick(dtSeconds: number): CombatIntent {
    this.cooldownTimer -= dtSeconds;
    this.decisionTimer -= dtSeconds;

    if (this.target && !this.isValidTarget(this.target)) {
      this.stats.lost++;
      this.dropTarget(false);
    }

    if (!this.target && this.cooldownTimer <= 0 && this.decisionTimer <= 0) {
      this.decisionTimer = DECISION_INTERVAL;
      this.considerEngaging();
    }

    if (this.target) {
      this.chaseElapsed += dtSeconds;
      const gap = Math.abs(this.target.distanceAlong - this.self.distanceAlong);
      const alongside = gap <= STRIKE_GAP;
      if (alongside) {
        this.engageTimer -= dtSeconds;
        if (this.strikeDelay === null) {
          this.strikeDelay = THREE.MathUtils.lerp(STRIKE_DELAY_MIN, STRIKE_DELAY_MAX, this.random());
        } else {
          this.strikeDelay -= dtSeconds;
        }
      }
      // Not alongside right now: patience isn't spent (as before), and the
      // stand-off clock *pauses* rather than resetting — a real race has
      // riders' gap wobbling in and out of STRIKE_GAP through corners and
      // speed changes, and the wait is meant to be cumulative time spent
      // near someone, not one unbroken window. A genuine escape still clears
      // it: `isValidTarget` dropping the target below, or patience/the chase
      // ceiling running out, both reset it via `dropTarget`.

      if (this.engageTimer <= 0 || this.chaseElapsed >= MAX_CHASE_SECONDS) {
        this.stats.expired++;
        this.dropTarget(true);
      } else if (this.strikeDelay !== null && this.strikeDelay <= 0) {
        this.tryStrike(this.target);
      }
    }

    return this.describeIntent();
  }

  /**
   * Who the settings allow this bot to hit at all. The player only when the
   * on-screen switch says so; the bot itself, riders already on the ground
   * and riders who have finished never. Also handed to `CombatSystem` with
   * every swing, so a strike aimed at one rider can't land on another this
   * bot isn't allowed to touch.
   */
  private readonly mayHit = (other: Racer): boolean => {
    if (other === this.self || !other.rider.isRiding || other.hasFinished) return false;
    return other.isPlayer ? this.settings.botsAttackPlayer : this.settings.botsAttackBots;
  };

  /** `mayHit`, plus: this bot is in a state to fight and the other rider is within the hunting window. */
  private isValidTarget(other: Racer): boolean {
    if (!this.mayHit(other)) return false;
    if (!this.self.rider.isRiding || this.self.hasFinished) return false;

    const gap = other.distanceAlong - this.self.distanceAlong;
    if (Math.abs(gap) > HUNT_GAP) return false;
    const lateralGap = other.lateralOffset - this.self.lateralOffset;
    return Math.abs(lateralGap) <= HUNT_WIDTH;
  }

  private considerEngaging(): void {
    if (this.personality.aggression <= 0) return;
    if (Math.abs(this.self.bike.forwardSpeed) < MIN_ENGAGE_SPEED) return;

    let nearest: Racer | null = null;
    let nearestScore = Infinity;
    for (const other of this.field) {
      if (!this.isValidTarget(other)) continue;
      const distance = other.bike.worldPosition.distanceTo(this.self.bike.worldPosition);
      const score = other.isPlayer ? distance * PLAYER_DISTANCE_WEIGHT : distance;
      if (score < nearestScore) {
        nearestScore = score;
        nearest = other;
      }
    }
    if (!nearest) return;

    const chance = this.personality.aggression * ENGAGE_CHANCE * (nearest.isPlayer ? PLAYER_ENGAGE_BONUS : 1);
    if (this.random() >= chance) return;

    this.target = nearest;
    this.chaseElapsed = 0;
    this.engageTimer = THREE.MathUtils.lerp(
      ENGAGE_SECONDS_MIN,
      ENGAGE_SECONDS_MAX,
      this.personality.aggression,
    );
    this.stats.engagements++;
  }

  /** Ends the engagement. A swing or an abandoned chase both cost a cooldown; losing the target to the road does not. */
  private dropTarget(startCooldown: boolean): void {
    this.target = null;
    this.engageTimer = 0;
    this.chaseElapsed = 0;
    this.strikeDelay = null;
    if (startCooldown) {
      this.cooldownTimer = THREE.MathUtils.lerp(
        COOLDOWN_MAX,
        COOLDOWN_MIN,
        this.personality.aggression,
      );
    }
  }

  /**
   * Throws an attack if one would connect. "Would connect" is judged where the
   * target will be when the strike goes live, not where they are now: a punch
   * has 0.1 s of wind-up and a kick 0.2 s, and at a 5 m/s closing speed that
   * is a metre — the difference between a hit and swinging at air.
   */
  private tryStrike(target: Racer): void {
    if (this.combat.snapshot(this.self).phase !== AttackPhase.IDLE) return;

    const punch = this.wouldConnect(target, ATTACKS[AttackKind.PUNCH]);
    const kick = this.wouldConnect(target, ATTACKS[AttackKind.KICK]);
    let kind: AttackKind | null = null;
    if (punch && kick) kind = this.random() < PUNCH_PREFERENCE ? AttackKind.PUNCH : AttackKind.KICK;
    else if (punch) kind = AttackKind.PUNCH;
    else if (kick) kind = AttackKind.KICK;
    if (kind === null) return;

    if (this.combat.request(this.self, kind, this.mayHit)) {
      this.stats.attacks++;
      // Win or whiff, that was the bot's shot. Back to racing.
      this.dropTarget(true);
    }
  }

  /** The same range-and-cone test `CombatSystem.resolveStrike` applies, run on the predicted position. */
  private wouldConnect(target: Racer, definition: AttackDefinition): boolean {
    const bike = this.self.bike;
    const selfVelocity = bike.controller.chassisBody.linvel();
    const targetVelocity = target.bike.controller.chassisBody.linvel();

    this.tmpRelative.subVectors(target.bike.worldPosition, bike.worldPosition).setY(0);
    this.tmpPredicted
      .set(targetVelocity.x - selfVelocity.x, 0, targetVelocity.z - selfVelocity.z)
      .multiplyScalar(definition.windup)
      .add(this.tmpRelative);

    const distance = this.tmpPredicted.length();
    if (distance > definition.range || distance < 1e-3) return false;

    this.tmpRight.copy(LOCAL_RIGHT).applyQuaternion(bike.worldQuaternion).setY(0).normalize();
    const alongRight = Math.abs(this.tmpPredicted.dot(this.tmpRight)) / distance;
    const angleFromSide = Math.acos(THREE.MathUtils.clamp(alongRight, 0, 1));
    return angleFromSide <= definition.arc;
  }

  private describeIntent(): CombatIntent {
    const intent = this.intent;
    const target = this.target;
    intent.target = target;
    if (!target) {
      intent.desiredLateral = 0;
      intent.desiredSpeed = 0;
      return intent;
    }

    // Stay on whichever side of the target this bot is already on — crossing
    // over would mean driving through them.
    const side = this.self.lateralOffset >= target.lateralOffset ? 1 : -1;
    const limit = ROAD_HALF_WIDTH - LINE_MARGIN;
    intent.desiredLateral = THREE.MathUtils.clamp(
      target.lateralOffset + side * STRIKE_LATERAL,
      -limit,
      limit,
    );

    // Match their speed, corrected by how far ahead or behind they are, so
    // the bot closes to abreast and then holds there.
    const gap = target.distanceAlong - this.self.distanceAlong;
    const correction = THREE.MathUtils.clamp(gap * GAP_GAIN, -MAX_GAP_CORRECTION, MAX_GAP_CORRECTION);
    intent.desiredSpeed = Math.max(MIN_HUNT_SPEED, Math.abs(target.bike.forwardSpeed) + correction);
    return intent;
  }
}
