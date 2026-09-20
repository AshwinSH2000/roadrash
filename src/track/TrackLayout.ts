import * as THREE from "three";

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
export interface TrackLayout {
  readonly name: string;
  readonly description: string;
  readonly points: readonly THREE.Vector3[];
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

  build(name: string, description: string): TrackLayout {
    return { name, description, points: this.points.map((p) => p.clone()) };
  }

  /** Where the turtle is now — handy when tuning a recipe against the validator. */
  get position(): { x: number; y: number; z: number; headingDeg: number } {
    return { x: this.x, y: this.y, z: this.z, headingDeg: THREE.MathUtils.radToDeg(this.heading) };
  }
}
