import * as THREE from "three";
import { WORLD_UP, rightOf } from "../utils/Directions";

/**
 * Stunt features that sit on a course: a sand pit, a river gap to jump, a
 * vertical loop. A layout lists them (`TrackLayout.features`) by control-point
 * index; `TrackDefinition` resolves them to sample indices and distances.
 *
 * What the spline does inside a feature:
 *  - sand: nothing special. It is ordinary road with a different surface.
 *  - river: ordinary road with a hole in it. The spline carries on across the
 *    gap, so project/AI/minimap are undisturbed; the builder just leaves the
 *    road out and puts water underneath.
 *  - loop: the spline is the loop's *shadow* on the ground, a gentle jog from
 *    where the loop starts to where it ends. Everything that reads the spline
 *    (projection, minimap, scenery, AI aim) sees a simple jog, never a
 *    vertical road. The real 3D path lives in `LoopGeometry`.
 */
export type TrackFeatureKind = "sand" | "river" | "loop";

/** Authored loop parameters; the 3D geometry is derived from these and where the turtle stood. */
export interface LoopSpec {
  radius: number;
  /** Metres the exit lies beyond the entry, along the heading. */
  advance: number;
  /** Metres the exit lies beside the entry, so the two ends of the ribbon clear each other. */
  shift: number;
  /** +1 shifts to the track's right, -1 to its left. */
  side: 1 | -1;
  origin: THREE.Vector3;
  /** Radians, 0 = +Z, increasing toward +X — the same convention as `TrackRecipe`. */
  heading: number;
}

/** A feature as a layout describes it: which control points bound it. */
export interface TrackFeatureSpec {
  kind: TrackFeatureKind;
  startPoint: number;
  endPoint: number;
  loop?: LoopSpec;
}

/** A feature resolved against the sampled course. */
export interface TrackFeature {
  kind: TrackFeatureKind;
  /** Sample indices the feature runs between. */
  startIndex: number;
  endIndex: number;
  startDistance: number;
  endDistance: number;
  /** Road segments (`i` joins sample `i` to `i + 1`) left out of the road. */
  skipFromSegment: number;
  skipToSegment: number;
  /**
   * Segments left out of everything alongside the road (off-road bands,
   * cliff skirt, walls, scenery). A loop's last segment is included: the
   * ground shadow bends too sharply there for a band 30 m wide to be drawn
   * around it without folding.
   */
  sideSkipFromSegment: number;
  sideSkipToSegment: number;
  loop?: LoopGeometry;
}

/** What a point on the loop looks like to a rider travelling it. */
export interface LoopFrame {
  position: THREE.Vector3;
  /** Unit direction of travel. */
  tangent: THREE.Vector3;
  /** Unit, toward the centre of curvature: the rider's "up" on the ribbon. */
  normal: THREE.Vector3;
  /** Curvature, 1/m. */
  curvature: number;
  /** Metres of path per radian of loop angle. */
  speedFactor: number;
}

const TWO_PI = Math.PI * 2;

/**
 * The real path of a loop-the-loop: a circle standing in the vertical plane
 * along the heading, drifting forward by `advance` and sideways by `shift`
 * over the turn so that the exit is clear of the entry.
 *
 *   P(t) = origin + T*(R sin t + F d(t)) + Y*R(1 - cos t) + S*(W d(t)),
 *   d(x) = 3x^2 - 2x^3,  x = t / 2pi
 *
 * with `T` the heading, `S` the shift direction, t from 0 (entry, on the
 * ground) to 2pi (exit, on the ground). `d` runs 0 to 1 and has no slope at
 * either end, so the bike enters and leaves pointing exactly along the road
 * instead of cutting in at an angle. The drift is also what makes the path
 * tighter at the top than at the bottom, as a real loop is: the rider is
 * slowest there, so it keeps the g-force from falling away. Exact derivatives give the tangent,
 * curvature and normal, so the physics (`LoopRide`) never differences samples.
 */
export class LoopGeometry {
  readonly radius: number;
  readonly advance: number;
  readonly shift: number;
  readonly origin: THREE.Vector3;
  /** Horizontal unit heading at entry and exit. */
  readonly heading = new THREE.Vector3();
  /** Horizontal unit vector across the road (the track's right). */
  readonly across = new THREE.Vector3();
  /** Horizontal unit direction the exit is displaced toward. */
  readonly shiftDirection = new THREE.Vector3();
  readonly exit = new THREE.Vector3();

  private readonly a1 = new THREE.Vector3();
  private readonly a2 = new THREE.Vector3();

  constructor(spec: LoopSpec) {
    this.radius = spec.radius;
    this.advance = spec.advance;
    this.shift = spec.shift;
    this.origin = spec.origin.clone();
    this.heading.set(Math.sin(spec.heading), 0, Math.cos(spec.heading));
    rightOf(this.heading, this.across);
    this.shiftDirection.copy(this.across).multiplyScalar(spec.side);
    this.at(TWO_PI, this.exit);
  }

  at(t: number, out: THREE.Vector3): THREE.Vector3 {
    const R = this.radius;
    out.copy(this.origin);
    const x = t / TWO_PI;
    const d = 3 * x * x - 2 * x * x * x;
    out.addScaledVector(this.heading, R * Math.sin(t) + this.advance * d);
    out.addScaledVector(WORLD_UP, R * (1 - Math.cos(t)));
    out.addScaledVector(this.shiftDirection, this.shift * d);
    return out;
  }

  /** Position, tangent, curvature and normal at loop angle `t`. */
  frame(t: number, out: LoopFrame): LoopFrame {
    const R = this.radius;
    const x = t / TWO_PI;
    const dd = (6 * x * (1 - x)) / TWO_PI;
    const ddd = (6 * (1 - 2 * x)) / (TWO_PI * TWO_PI);
    this.a1
      .copy(this.heading)
      .multiplyScalar(R * Math.cos(t) + this.advance * dd)
      .addScaledVector(WORLD_UP, R * Math.sin(t))
      .addScaledVector(this.shiftDirection, this.shift * dd);
    this.a2
      .copy(this.heading)
      .multiplyScalar(-R * Math.sin(t) + this.advance * ddd)
      .addScaledVector(WORLD_UP, R * Math.cos(t))
      .addScaledVector(this.shiftDirection, this.shift * ddd);

    const speedFactor = this.a1.length();
    out.tangent.copy(this.a1).divideScalar(speedFactor);
    // dT/ds = (A'' - T (T . A'')) / |A'|^2
    out.normal.copy(this.a2).addScaledVector(out.tangent, -out.tangent.dot(this.a2)).divideScalar(speedFactor * speedFactor);
    out.curvature = out.normal.length();
    if (out.curvature > 1e-9) out.normal.divideScalar(out.curvature);
    else out.normal.copy(WORLD_UP);
    out.speedFactor = speedFactor;
    this.at(t, out.position);
    return out;
  }

  static createFrame(): LoopFrame {
    return {
      position: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      curvature: 0,
      speedFactor: 1,
    };
  }

  /** Total path length, metres, by midpoint integration. */
  get pathLength(): number {
    const frame = LoopGeometry.createFrame();
    const steps = 360;
    let length = 0;
    for (let i = 0; i < steps; i++) {
      this.frame(((i + 0.5) / steps) * TWO_PI, frame);
      length += (frame.speedFactor * TWO_PI) / steps;
    }
    return length;
  }
}

export const LOOP_FULL_TURN = TWO_PI;
