import * as THREE from "three";
import type { Racer } from "./Racer";
import type { TrackDefinition } from "../track/TrackDefinition";
import { ROAD_HALF_WIDTH } from "../track/TrackDefinition";
import type { TrackFeature } from "../track/TrackFeatures";
import { LOCAL_FORWARD } from "../utils/Directions";

/** Slower than this at the line and the bike is not taken onto the loop at all (it is just rolling). */
const MIN_ENTRY_SPEED = 3;
/** How far above the road a chassis centre may be and still count as being on it, metres. */
const ON_ROAD_HEIGHT = 2.4;
/** Seconds a wheel must sit in the river before the rider is put back on the road. */
export const DROWN_SECONDS = 0.9;

/**
 * Runs the stunt features that need the game's attention each step: taking a
 * bike onto a loop as it crosses the loop's start line, and dealing with how
 * the ride ended. The loop's physics is `LoopRide`, inside the bike's
 * controller; this is the part that knows about tracks and riders.
 */
export class StuntSystem {
  private readonly lastU = new WeakMap<Racer, Map<TrackFeature, number>>();
  private readonly tmpOffset = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpKnock = new THREE.Vector3();

  /** Told how every loop ride ends — the headless sims count them. */
  onLoopOutcome: ((racer: Racer, outcome: "completed" | "failed") => void) | null = null;

  constructor(private readonly track: TrackDefinition) {}

  /** Call once per fixed step, after the physics step and before the track positions are read. */
  update(racers: readonly Racer[]): void {
    for (const racer of racers) {
      this.handleOutcome(racer);
      this.checkEntry(racer);
    }
  }

  private handleOutcome(racer: Racer): void {
    const outcome = racer.bike.controller.takeLoopOutcome();
    if (!outcome) return;
    racer.loopFeature = null;
    this.onLoopOutcome?.(racer, outcome);
    if (outcome === "failed") {
      // The controller has already handed the bike back to the physics, moving
      // on the path it was on. The rider goes off it the ordinary way.
      this.tmpKnock.set(0, 0, 0);
      racer.rider.knockOff(this.tmpKnock);
    }
  }

  private checkEntry(racer: Racer): void {
    const controller = racer.bike.controller;
    let seen = this.lastU.get(racer);
    if (!seen) {
      seen = new Map();
      this.lastU.set(racer, seen);
    }
    for (const feature of this.track.features) {
      const loop = feature.loop;
      if (feature.kind !== "loop" || !loop) continue;

      const position = racer.bike.worldPosition;
      this.tmpOffset.subVectors(position, loop.origin);
      const along = this.tmpOffset.dot(loop.heading);
      const across = this.tmpOffset.dot(loop.across);
      const previous = seen.get(feature);
      seen.set(feature, along);

      if (previous === undefined || !(previous < 0 && along >= 0)) continue;
      if (controller.currentLoopRide || !racer.rider.isRiding || racer.hasFinished) continue;
      if (Math.abs(across) > ROAD_HALF_WIDTH + 1.5) continue;
      if (Math.abs(position.y - (loop.origin.y + 1.1)) > ON_ROAD_HEIGHT) continue;
      if (controller.forwardSpeed < MIN_ENTRY_SPEED) continue;
      this.tmpForward.copy(LOCAL_FORWARD).applyQuaternion(racer.bike.worldQuaternion);
      if (this.tmpForward.dot(loop.heading) < 0.5) continue;

      controller.beginLoopRide(loop, controller.forwardSpeed, THREE.MathUtils.clamp(across, -ROAD_HALF_WIDTH + 1, ROAD_HALF_WIDTH - 1));
      racer.loopFeature = feature;
    }
  }

  /** True while this racer's chassis is in a river bed. */
  static inWater(racer: Racer): boolean {
    return racer.bike.controller.wheelSurfaceName(0) === "water" || racer.bike.controller.wheelSurfaceName(1) === "water";
  }
}
