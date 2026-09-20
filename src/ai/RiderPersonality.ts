/**
 * Per-bot driving personality.
 *
 * The point of these is variance, not difficulty. Five bots that all drive
 * the same optimal line finish nose-to-tail in the same order every race,
 * which reads as scripted; five bots with different corner confidence and
 * different preferred lines produce a shuffling pack, overtakes, and varied
 * finishing times from the same code.
 *
 * `aggression` drives `CombatBehavior`: how readily the bot goes for a rider
 * alongside, how long it chases, and how long it races clean afterwards.
 */
/** The player's bike colour, kept here so every rider's colour lives in one place. */
export const PLAYER_COLOR = 0x2266dd;

export interface RiderPersonality {
  name: string;
  /** Bike colour, so riders are tellable apart at a glance. */
  color: number;
  /**
   * Cornering acceleration this bot is willing to ask for, in m/s^2. The
   * bike delivers about 14.4 (measured — `npm run sim:skidpad`), so these all
   * sit below that: a bot that plans corner speeds it cannot hold simply
   * understeers off the outside. Bots nearer 14.4 commit harder. Rescale
   * these together if `maxLateralAccel` ever changes.
   */
  corneringConfidence: number;
  /** Fraction of the straight-line top speed this bot will chase, 0..1. */
  topSpeedFraction: number;
  /**
   * Preferred distance right of the centerline, in metres. Spreads the pack
   * across the road instead of stacking every bot on one racing line.
   */
  linePreference: number;
  /**
   * Small multiplier on the pure-pursuit steering command. Around 1.0 — the
   * steering geometry is computed, not tuned, so this is style (a shade of
   * over- or under-correction), not the thing making it work.
   */
  steerTrim: number;
  /**
   * Seconds of reaction lag on the throttle/brake decision. Small values
   * still meaningfully cost lap time at braking points, and stop every bot
   * hitting its brakes on exactly the same frame.
   */
  reactionTime: number;
  /**
   * How readily this bot throws a punch, 0..1. Scales the chance of going for
   * a rider alongside, how long it chases, and how long it then leaves
   * everyone alone — see `CombatBehavior`. 0 means it never fights.
   */
  aggression: number;
  /**
   * Whether this rider moves over for others (`AvoidanceBehavior`). Every
   * real bot does; leave it unset. `false` exists for the AI-combat sim,
   * whose stand-in for the human player must not auto-dodge every bot it
   * passes, or nothing could ever hit it and the sim would test nothing.
   */
  dodges?: boolean;
}

/**
 * The five opponents. Spread deliberately from "quick and committed" to
 * "cautious and wide" so the finishing order has room to vary, with line
 * preferences fanned across the 14 m road.
 */
export const OPPONENT_PERSONALITIES: readonly RiderPersonality[] = [
  {
    name: "Viper",
    color: 0xd0342f,
    corneringConfidence: 13.5,
    topSpeedFraction: 1.0,
    linePreference: -1.5,
    steerTrim: 1.05,
    reactionTime: 0.12,
    aggression: 0.8,
  },
  {
    name: "Slugger",
    color: 0xe08a1e,
    corneringConfidence: 12.8,
    topSpeedFraction: 0.97,
    linePreference: 2.6,
    steerTrim: 0.95,
    reactionTime: 0.18,
    aggression: 0.9,
  },
  {
    name: "Natasha",
    color: 0x9b4fd0,
    corneringConfidence: 13.2,
    topSpeedFraction: 0.99,
    linePreference: -3.4,
    steerTrim: 1.12,
    reactionTime: 0.14,
    aggression: 0.5,
  },
  {
    name: "Biff",
    color: 0x2f9b6a,
    corneringConfidence: 12.0,
    topSpeedFraction: 0.94,
    linePreference: 1.0,
    steerTrim: 0.92,
    reactionTime: 0.24,
    aggression: 0.7,
  },
  {
    name: "Axel",
    color: 0xcfc63a,
    corneringConfidence: 12.4,
    topSpeedFraction: 0.96,
    linePreference: -0.4,
    steerTrim: 1.0,
    reactionTime: 0.2,
    aggression: 0.6,
  },
];

/**
 * Used when the player hands their bike to the AI (the autopilot toggle).
 * That exists for this phase's own verification requirement — "run a race
 * with only AI" — which is otherwise impossible to watch from inside a game
 * that always has a human in it.
 */
export const AUTOPILOT_PERSONALITY: RiderPersonality = {
  name: "Autopilot",
  color: PLAYER_COLOR,
  corneringConfidence: 13.3,
  topSpeedFraction: 1.0,
  linePreference: 0,
  steerTrim: 1.02,
  reactionTime: 0.14,
  aggression: 0,
};
