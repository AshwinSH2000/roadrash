import type * as THREE from "three";
import type { TrackDefinition } from "../track/TrackDefinition";
import type { Bike } from "./Bike";
import type { RiderStateMachine } from "./RiderStateMachine";

/**
 * Anything that can decide what a bike does this step. The player's keyboard
 * controller and the opponent AI both implement it, which is what lets the
 * rest of the game treat all six riders identically — the design calls for a
 * single shared code path for player and AI, and this is where that starts.
 */
export interface Driver {
  tick(dtSeconds: number): void;
}

/**
 * Driver used once a rider has crossed the line: brake, hands off the bars.
 *
 * Without it a finished rider carries on at racing speed and runs off the end
 * of the spline into the void a second and a half later, which the recovery
 * system then rescues in a loop. Braking to a stop on the run-out is both the
 * correct behaviour and the reason the run-out exists — and it uses the
 * dedicated `finishBrakeForce` rather than a normal full-throttle-off brake,
 * which at racing speed wouldn't reliably stop the bike within the 10 m a
 * finish is meant to.
 */
export class BrakeToStopDriver implements Driver {
  constructor(private readonly bike: Bike) {
    this.bike.controller.setFinishBrake(true);
  }

  tick(): void {
    this.bike.setInput(0, 0);
  }
}

/** How slowly (m/s) a rider must be going, and for how long, to count as stuck. */
const STUCK_SPEED = 1.5;
const STUCK_SECONDS = 4;

/**
 * One rider in the race: a bike, whoever is driving it, and where they are on
 * the course. Track position is recomputed once per physics step and cached
 * here, because several systems want it (AI targeting, avoidance, standings,
 * the HUD) and projecting onto the spline is the expensive part.
 */
export class Racer {
  /** Whoever is driving right now — the base driver, or the brake-to-stop one after the line. */
  driver: Driver | null = null;
  /** The rider's real driver (keyboard or AI), restored by `restart()` after a finish swapped it out. */
  baseDriver: Driver | null = null;

  distanceAlong = 0;
  lateralOffset = 0;
  private projectionHint = -1;

  hasFinished = false;
  /** Elapsed race time when they crossed the line, in seconds. */
  raceTime = 0;
  /** 1-based finishing position, set when they cross the line. */
  finishPosition = 0;

  private stuckSeconds = 0;

  constructor(
    readonly bike: Bike,
    readonly name: string,
    readonly isPlayer: boolean,
    readonly color: number,
    readonly rider: RiderStateMachine,
  ) {}

  /**
   * Advances the rider, then the driver — but only lets the driver touch the
   * controls while the rider is actually on the bike. A knocked-off rider's
   * AI would otherwise keep steering a bike it isn't sitting on.
   */
  tickDriver(dtSeconds: number): void {
    this.rider.tick(dtSeconds);
    if (this.rider.isRiding) {
      this.driver?.tick(dtSeconds);
    } else {
      this.bike.setInput(0, 0);
    }
  }

  updateTrackPosition(track: TrackDefinition): void {
    const projection = track.project(this.bike.worldPosition, this.projectionHint);
    this.projectionHint = projection.sampleIndex;
    this.distanceAlong = projection.distanceAlong;
    this.lateralOffset = projection.lateralOffset;
  }

  /**
   * Tracks how long this rider has been going nowhere. Returns true once they
   * have been stuck long enough to need rescuing — a bot wedged against the
   * terrain lip or spun to a halt facing backwards would otherwise sit there
   * for the rest of the race, which the phase's own verification forbids.
   */
  updateStuck(dtSeconds: number, graceElapsed: boolean): boolean {
    // A rider who is off the bike is *supposed* to be stationary; counting
    // that as stuck would rescue them mid-fall and abort the recovery.
    if (this.hasFinished || !graceElapsed || !this.rider.isRiding) {
      this.stuckSeconds = 0;
      return false;
    }
    if (Math.abs(this.bike.forwardSpeed) > STUCK_SPEED) {
      this.stuckSeconds = 0;
      return false;
    }
    this.stuckSeconds += dtSeconds;
    if (this.stuckSeconds >= STUCK_SECONDS) {
      this.stuckSeconds = 0;
      return true;
    }
    return false;
  }

  /** Call after teleporting the bike, so the windowed spline search re-acquires from scratch. */
  resetProjection(): void {
    this.projectionHint = -1;
    this.stuckSeconds = 0;
  }

  /** Crossed the line: record it and hand the bike over to brake to a stop on the run-out. */
  finishRace(raceTime: number, position: number): void {
    this.hasFinished = true;
    this.raceTime = raceTime;
    this.finishPosition = position;
    this.driver = new BrakeToStopDriver(this.bike);
  }

  /**
   * Back to the start line for "Race Again": on the bike, at the given
   * pose, with the real driver back in charge and nothing remembered from
   * the last race. The bike's own state (velocity, gear, steering) is reset
   * by the teleport.
   */
  restart(position: THREE.Vector3, rotation: THREE.Quaternion, track: TrackDefinition): void {
    if (!this.rider.isRiding) this.rider.forceRemount();
    this.bike.teleport(position, rotation);
    this.bike.controller.setBoost(false);
    this.bike.controller.setFinishBrake(false);
    this.bike.setInput(0, 0);
    this.hasFinished = false;
    this.raceTime = 0;
    this.finishPosition = 0;
    this.driver = this.baseDriver;
    this.resetProjection();
    this.updateTrackPosition(track);
  }
}
