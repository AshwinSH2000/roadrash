/**
 * The race's own state machine, kept free of DOM and physics so the whole
 * loop — countdown, racing, the end conditions, and back again for "Race
 * Again" — can be run headlessly (`npm run sim:flow`) as well as on screen.
 *
 *   COUNTDOWN --(3 s)--> RACING --(player finishes, or timeout)--> FINISHED
 *        ^                                                            |
 *        +------------------------- restart() -------------------------+
 *
 * The end conditions are the confirmed ones: the race is live until the
 * player finishes, or a generous timeout elapses — three times the winning
 * bot's time, or a hard cap of six minutes, whichever comes first. A player
 * who times out is ranked last with a DNF rather than a Win/Lose.
 *
 * `Game` feeds it facts each step (has the player finished, in what
 * position, when did the first rider finish) and reads back the phase; it
 * decides nothing about bikes and knows nothing about seconds beyond the
 * ones it is handed.
 */

export enum RacePhase {
  COUNTDOWN = "countdown",
  RACING = "racing",
  FINISHED = "finished",
}

export enum RaceResult {
  WIN = "win",
  LOSE = "lose",
  DNF = "dnf",
}

/** Seconds of "3, 2, 1" before the lights go out. */
export const COUNTDOWN_SECONDS = 3;
/** Nobody waits six minutes for a race that has already been won. */
export const HARD_CAP_SECONDS = 360;
/** Once someone has finished, the player gets this many times their time. */
export const TIMEOUT_MULTIPLIER = 3;

export interface RaceFacts {
  playerFinished: boolean;
  /** 1-based position of the player in the current standings. */
  playerPosition: number;
  /** Race time of the first rider across the line, or null if nobody has yet. */
  firstFinishTime: number | null;
  /** How many riders there are, so a DNF can be ranked last. */
  fieldSize: number;
}

export class RaceFlow {
  private phase = RacePhase.COUNTDOWN;
  private countdownRemaining = COUNTDOWN_SECONDS;
  private elapsed = 0;
  private result: RaceResult | null = null;
  private finalPosition = 0;

  get current(): RacePhase {
    return this.phase;
  }

  /** Seconds left on the countdown; 0 once racing. */
  get countdown(): number {
    return this.countdownRemaining;
  }

  /** Race clock: seconds since the lights went out. Frozen once finished. */
  get raceElapsed(): number {
    return this.elapsed;
  }

  get isRacing(): boolean {
    return this.phase === RacePhase.RACING;
  }

  get outcome(): RaceResult | null {
    return this.result;
  }

  /** The player's final position, once finished — last place for a DNF. */
  get position(): number {
    return this.finalPosition;
  }

  /** Seconds the player has left before a DNF, given the facts so far. */
  deadline(firstFinishTime: number | null): number {
    if (firstFinishTime === null) return HARD_CAP_SECONDS;
    return Math.min(HARD_CAP_SECONDS, firstFinishTime * TIMEOUT_MULTIPLIER);
  }

  /**
   * Advances by one fixed step. Returns true on the step the race ends, so
   * the caller can react exactly once.
   */
  tick(dtSeconds: number, facts: RaceFacts): boolean {
    switch (this.phase) {
      case RacePhase.COUNTDOWN:
        this.countdownRemaining -= dtSeconds;
        if (this.countdownRemaining <= 0) {
          this.countdownRemaining = 0;
          this.phase = RacePhase.RACING;
        }
        return false;

      case RacePhase.RACING:
        this.elapsed += dtSeconds;
        if (facts.playerFinished) {
          this.finish(facts.playerPosition === 1 ? RaceResult.WIN : RaceResult.LOSE, facts.playerPosition);
          return true;
        }
        if (this.elapsed >= this.deadline(facts.firstFinishTime)) {
          this.finish(RaceResult.DNF, facts.fieldSize);
          return true;
        }
        return false;

      case RacePhase.FINISHED:
        return false;
    }
  }

  private finish(result: RaceResult, position: number): void {
    this.phase = RacePhase.FINISHED;
    this.result = result;
    this.finalPosition = position;
  }

  /** Back to the countdown, for "Race Again". */
  restart(): void {
    this.phase = RacePhase.COUNTDOWN;
    this.countdownRemaining = COUNTDOWN_SECONDS;
    this.elapsed = 0;
    this.result = null;
    this.finalPosition = 0;
  }
}
