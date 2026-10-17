import * as THREE from "three";
import type { LoopSpec, TrackFeatureSpec } from "./TrackFeatures";

/**
 * A course is a list of spline control points. Writing eighty of them by hand
 * is how the first track was made, and the spacing rules that keep a
 * Catmull-Rom faithful to the corner it was drawn from (dense through
 * corners, tightening just before and after them) made it fiddly to author
 * and impossible to reproduce. `TrackRecipe` generates the points instead,
 * from a description a person can read: a straight, a constant-radius corner,
 * a climb. Every layout goes through the same validator, so a new track is a
 * few lines and a check, not an afternoon.
 */
/**
 * What roadside scenery reads as along a stretch of course — see
 * `track/Scenery.ts` for what each biome actually scatters.
 */
export type SceneryBiome = "forest" | "farm" | "mountain" | "city";

/** One stretch of a course, as a fraction (0..1) of its total length, that reads as `biome`. */
export interface SceneryZoneSpec {
  readonly biome: SceneryBiome;
  readonly startFraction: number;
  readonly endFraction: number;
}

export interface TrackLayout {
  readonly name: string;
  readonly description: string;
  readonly points: readonly THREE.Vector3[];
  /**
   * Optional roadside-scenery zones, authored as fractions of the course's
   * eventual length so they don't need the exact spline length up front.
   * Zones need not cover the whole course — anywhere uncovered defaults to
   * `"forest"` (`TrackDefinition.biomeAt`). Omitting this entirely is the
   * same as leaving the whole course `"forest"`, today's scenery.
   */
  readonly sceneryZones?: readonly SceneryZoneSpec[];
  /**
   * False only for a course built with no cornering at all by design (a
   * drag strip) — skips `TrackValidator`'s "needs at least 4 real braking
   * zones" rule, which every cornered circuit must still pass. Defaults to
   * true; every existing course relies on that default and is unaffected.
   */
  readonly requiresCornering?: boolean;
  /** Sand pits, river gaps and loops, by control-point index — see `TrackFeatures.ts`. Omitted on every plain course. */
  readonly features?: readonly TrackFeatureSpec[];
}

/** Metres between control points on a straight. */
const STRAIGHT_SPACING = 35;
/** Metres between control points through a corner. */
const ARC_SPACING = 12;
/**
 * A control point this far into and out of every straight. A spline
 * overshoots where its point spacing changes abruptly, pinching the corner
 * that follows; a point close to each junction takes the change up gradually.
 */
const JUNCTION_LEAD = 15;

/**
 * Turtle-style course builder. Heading 0 is +Z (the bike's forward at spawn);
 * positive turn angles are LEFT turns, negative RIGHT — the same sense as the
 * steering input, so a recipe reads the way the rider experiences it.
 */
export class TrackRecipe {
  private readonly points: THREE.Vector3[] = [];
  private x = 0;
  private y = 0;
  private z = 0;
  /** Radians; 0 faces +Z, increasing turns toward +X, which is the rider's left (see utils/Directions). */
  private heading = 0;
  private readonly features: TrackFeatureSpec[] = [];

  constructor() {
    this.emit();
  }

  private emit(): void {
    this.points.push(new THREE.Vector3(this.x, this.y, this.z));
  }

  private advance(distance: number, rise: number): void {
    this.x += Math.sin(this.heading) * distance;
    this.z += Math.cos(this.heading) * distance;
    this.y += rise;
  }

  /** A straight of `length` metres, climbing (or descending) `rise` metres over it. */
  straight(length: number, rise = 0): this {
    const marks: number[] = [];
    if (length > JUNCTION_LEAD * 2.5) marks.push(JUNCTION_LEAD);
    for (let d = JUNCTION_LEAD + STRAIGHT_SPACING; d < length - JUNCTION_LEAD * 1.5; d += STRAIGHT_SPACING) marks.push(d);
    if (length > JUNCTION_LEAD * 2.5) marks.push(length - JUNCTION_LEAD);
    marks.push(length);

    let covered = 0;
    for (const mark of marks) {
      const step = mark - covered;
      this.advance(step, (rise * step) / length);
      covered = mark;
      this.emit();
    }
    return this;
  }

  /**
   * A constant-radius corner of `radius` metres turning through `degrees`
   * (positive = left), climbing `rise` metres over its length.
   */
  arc(radius: number, degrees: number, rise = 0): this {
    const total = THREE.MathUtils.degToRad(degrees);
    const length = Math.abs(total) * radius;
    const steps = Math.max(3, Math.round(length / ARC_SPACING));
    const dTheta = total / steps;
    const chord = 2 * radius * Math.sin(Math.abs(dTheta) / 2);
    for (let i = 0; i < steps; i++) {
      // Walk the chord at the mid-heading of this slice, so the points sit
      // exactly on the arc rather than spiralling off it.
      this.heading += dTheta / 2;
      this.advance(chord, rise / steps);
      this.heading += dTheta / 2;
      this.emit();
    }
    return this;
  }

  private lastPoint(): number {
    return this.points.length - 1;
  }

  /** A straight of `length` metres whose surface is sand. */
  sand(length: number): this {
    const startPoint = this.lastPoint();
    this.straight(length);
    this.features.push({ kind: "sand", startPoint, endPoint: this.lastPoint() });
    return this;
  }

  /**
   * A river to jump: a kicker climbing `rampRise` over `rampLength`, a gap of
   * `gap` metres with no road in it (water below), and a landing deck falling
   * away over `landingLength`. The gap keeps climbing `gapRise` so the launch
   * angle at the lip is the ramp's, not a flattened-out version of it.
   */
  river(rampLength: number, rampRise: number, gap: number, gapRise: number, landingLength: number): this {
    this.straight(rampLength, rampRise);
    const startPoint = this.lastPoint();
    this.straight(gap, gapRise);
    this.features.push({ kind: "river", startPoint, endPoint: this.lastPoint() });
    this.straight(landingLength, -(rampRise + gapRise));
    return this;
  }

  /**
   * A vertical loop. The spline gets only its ground shadow, a jog from the
   * entry to the exit; the real path is `LoopGeometry`. The ground stays at
   * this height all the way through.
   */
  loop(radius: number, advance: number, shift: number, side: 1 | -1 = 1): this {
    const startPoint = this.lastPoint();
    const spec: LoopSpec = {
      radius,
      advance,
      shift,
      side,
      origin: new THREE.Vector3(this.x, this.y, this.z),
      heading: this.heading,
    };
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const across = new THREE.Vector3(-forward.z, 0, forward.x);
    // A short stub along the heading at each end keeps the spline pointing
    // the way the bike does as it goes on and comes off the loop; without it
    // the diagonal between them tilts the road before the entry and after the exit.
    const place = (along: number, lateral: number): void => {
      this.x = spec.origin.x + forward.x * along + across.x * side * lateral;
      this.z = spec.origin.z + forward.z * along + across.z * side * lateral;
      this.emit();
    };
    const stub = 5;
    place(stub, 0);
    for (const t of [1 / 3, 2 / 3]) place(stub + (advance - stub) * t, shift * t);
    place(advance, shift);
    const endPoint = this.lastPoint();
    place(advance + stub, shift);
    this.features.push({ kind: "loop", startPoint, endPoint, loop: spec });
    return this;
  }

  build(
    name: string,
    description: string,
    sceneryZones?: readonly SceneryZoneSpec[],
    requiresCornering?: boolean,
  ): TrackLayout {
    return {
      name,
      description,
      points: this.points.map((p) => p.clone()),
      sceneryZones,
      requiresCornering,
      features: this.features.length > 0 ? this.features.map((f) => ({ ...f })) : undefined,
    };
  }

  /** Where the turtle is now — handy when tuning a recipe against the validator. */
  get position(): { x: number; y: number; z: number; headingDeg: number } {
    return { x: this.x, y: this.y, z: this.z, headingDeg: THREE.MathUtils.radToDeg(this.heading) };
  }
}
