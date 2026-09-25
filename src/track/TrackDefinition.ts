import * as THREE from "three";
import { WORLD_UP, rightOf } from "../utils/Directions";
import type { SceneryBiome, TrackLayout } from "./TrackLayout";
import { DEFAULT_TRACK } from "./tracks";

/** A resolved scenery zone, in absolute track distance rather than the layout's authored fractions. */
export interface SceneryZone {
  readonly biome: SceneryBiome;
  readonly startDistance: number;
  readonly endDistance: number;
}

/**
 * A point-to-point course: a Catmull-Rom spline through a layout's control
 * points (see `tracks.ts` for the courses and `TrackLayout.ts` for how they
 * are written), plus the queries every other system needs against it (how far
 * along the track a rider is, how far sideways from the centerline, which way
 * the track faces there).
 *
 * Deliberately not a closed loop — it starts at one place and finishes at
 * another, per the confirmed design.
 */

/** Half-width of the drivable road surface, in metres. */
export const ROAD_HALF_WIDTH = 7;
/** Half-width of the low-grip terrain flanking the road, in metres. */
export const OFFROAD_HALF_WIDTH = 30;

/**
 * Hand-authored centerline, laid out as a sequence of straights and constant-
 * radius corners so the course has a real brake-turn-accelerate rhythm rather
 * than one continuous flat-out sweep. Six corners are tight enough to force
 * braking from the ~144 km/h top speed down to 84-88 km/h; the rest are fast
 * sweepers taken at full throttle. `npm run check:track` measures the corner
 * profile the spline actually produces and fails if that rhythm is lost.
 *
 * Three constraints bound the layout, all enforced by that script:
 *
 *  - **The course never runs close to itself.** `project()` treats the nearest
 *    spline point as the meaningful one, and overlapping road ribbons would
 *    render as a mess.
 *  - **No corner tighter than about 39 m radius.** The off-road band extends
 *    `OFFROAD_HALF_WIDTH` (30 m) from the centerline, so on the *inside* of a
 *    corner tighter than that the band's outer edge passes through the centre
 *    of curvature and the geometry folds through itself. This, not grip, is
 *    what sets the slowest corner on the course.
 *  - **Grades stay near 10%.** The physics chassis has its pitch axis locked
 *    (see VehicleController), so it stays level while the road slopes beneath
 *    it and the suspension absorbs the difference across the wheelbase.
 *
 * The points are dense (~16-56 m apart, tightening through corners) because
 * uneven spacing makes a Catmull-Rom overshoot at straight-to-corner
 * junctions, pinching corners up to 25% tighter than intended. Spacing that
 * tightens *before* a corner as well as inside it is what keeps the spline
 * faithful to the radius it was drawn from.
 */

/** Roughly how far apart consecutive centerline samples are, in metres. */
const SAMPLE_SPACING = 3;

/** Half-span, in samples, used to measure corner radius. 5 samples ~= 15 m each side. */
const CURVATURE_STRIDE = 5;

/** How far back from the very end of the spline the finish line sits, leaving run-out room. */
const FINISH_RUNOUT = 50;

/**
 * How far into the spline the start line sits, leaving road *behind* the
 * riders.
 *
 * This is not cosmetic. A rider spawned exactly at distance 0 has its rear
 * wheel about 0.7 m behind the chassis centre — which is behind the start of
 * the road surface, hanging over nothing. That wheel never finds ground, and
 * because the rear wheel is the driven one, the bike cannot move at all.
 * The lead-in is also what makes room for a staggered 6-rider starting grid
 * in Phase 4, where riders behind the front row sit several metres back.
 */
const START_LEAD_IN = 25;

export interface TrackProjection {
  /** Distance along the centerline from the start, in metres. */
  distanceAlong: number;
  /** Signed sideways offset from the centerline; positive is track-right (see utils/Directions). */
  lateralOffset: number;
  /** Nearest point on the centerline. */
  centerPoint: THREE.Vector3;
  /** Unit forward direction of the track at that point. */
  tangent: THREE.Vector3;
  /** Index into the sample table — pass back as `hintIndex` next query to make it cheap. */
  sampleIndex: number;
}

export class TrackDefinition {
  readonly name: string;
  readonly curve: THREE.CatmullRomCurve3;
  readonly totalLength: number;
  /** Distance along the centerline at which the start line sits — riders spawn here, not at 0. */
  readonly startDistance: number;
  /** Distance along the centerline at which the finish line sits. */
  readonly finishDistance: number;

  readonly samplePoints: THREE.Vector3[] = [];
  readonly sampleTangents: THREE.Vector3[] = [];
  readonly sampleRights: THREE.Vector3[] = [];
  readonly sampleDistances: number[] = [];
  /** Horizontal corner radius at each sample, in metres; `Infinity` on a straight. */
  readonly sampleRadii: number[] = [];
  /** Actual distance between consecutive samples, in metres. */
  readonly sampleSpacing: number;
  /** Roadside-scenery zones, resolved from the layout's authored fractions. Always covers 0..totalLength. */
  readonly sceneryZones: SceneryZone[] = [];

  private readonly tmpToPos = new THREE.Vector3();
  private readonly tmpSeg = new THREE.Vector3();
  private readonly tmpClosest = new THREE.Vector3();

  /** Builds the course from a layout; the default is the first entry in `TRACKS`, which every headless script uses. */
  constructor(layout: TrackLayout = DEFAULT_TRACK) {
    this.name = layout.name;
    this.curve = new THREE.CatmullRomCurve3(
      layout.points.map((p) => p.clone()),
      false,
      "catmullrom",
      0.5,
    );
    // The default (200) is far too coarse for a ~2km spline; this keeps
    // arc-length parameterisation accurate enough that evenly-spaced samples
    // really are evenly spaced.
    this.curve.arcLengthDivisions = 4000;

    this.totalLength = this.curve.getLength();
    this.startDistance = Math.min(START_LEAD_IN, this.totalLength * 0.1);
    this.finishDistance = Math.max(this.startDistance, this.totalLength - FINISH_RUNOUT);

    const divisions = Math.max(2, Math.ceil(this.totalLength / SAMPLE_SPACING));
    for (let i = 0; i <= divisions; i++) {
      const u = i / divisions;
      const point = this.curve.getPointAt(u);
      const tangent = this.curve.getTangentAt(u).normalize();
      // `forward x up`, not `up x forward` — see utils/Directions for why the
      // obvious-looking version points the wrong way.
      const right = rightOf(tangent, new THREE.Vector3());

      this.samplePoints.push(point);
      this.sampleTangents.push(tangent);
      this.sampleRights.push(right);
      this.sampleDistances.push(u * this.totalLength);
    }

    this.sampleSpacing = this.totalLength / divisions;
    this.computeCurvature();

    for (const zone of layout.sceneryZones ?? []) {
      this.sceneryZones.push({
        biome: zone.biome,
        startDistance: zone.startFraction * this.totalLength,
        endDistance: zone.endFraction * this.totalLength,
      });
    }
  }

  /**
   * What a stretch of roadside scenery at `distanceAlong` should read as.
   * Defaults to `"forest"` — today's scenery — wherever the layout didn't
   * author a zone covering that distance. Zones are few (a handful per
   * course), so a linear scan is simpler than anything sorted/binary-searched.
   */
  biomeAt(distanceAlong: number): SceneryBiome {
    for (const zone of this.sceneryZones) {
      if (distanceAlong >= zone.startDistance && distanceAlong < zone.endDistance) return zone.biome;
    }
    return "forest";
  }

  /**
   * Corner radius at every sample, as the circumradius of the triangle
   * through the samples `CURVATURE_STRIDE` either side, projected onto the
   * horizontal plane. Measured over a ~30 m span rather than between adjacent
   * 3 m samples, which sit too close together for the circumradius to be
   * numerically meaningful — three nearly-collinear points give a radius
   * dominated by floating-point noise.
   *
   * This mirrors what `scripts/check-track.mjs` measures offline; the AI
   * needs the same numbers at runtime to know where to brake.
   */
  private computeCurvature(): void {
    const count = this.samplePoints.length;
    const stride = CURVATURE_STRIDE;
    for (let i = 0; i < count; i++) {
      if (i < stride || i >= count - stride) {
        this.sampleRadii.push(Infinity);
        continue;
      }
      const p = this.samplePoints[i - stride];
      const q = this.samplePoints[i];
      const r = this.samplePoints[i + stride];
      const ax = p.x - q.x;
      const az = p.z - q.z;
      const bx = r.x - q.x;
      const bz = r.z - q.z;
      const cross = ax * bz - az * bx;
      if (Math.abs(cross) < 1e-9) {
        this.sampleRadii.push(Infinity);
        continue;
      }
      const a = Math.hypot(ax, az);
      const b = Math.hypot(bx, bz);
      const c = Math.hypot(p.x - r.x, p.z - r.z);
      this.sampleRadii.push((a * b * c) / (2 * Math.abs(cross)));
    }
  }

  /** Sample index nearest a given distance along the centerline. */
  sampleIndexAt(distanceAlong: number): number {
    const raw = Math.round(distanceAlong / this.sampleSpacing);
    return THREE.MathUtils.clamp(raw, 0, this.samplePoints.length - 1);
  }

  /** Corner radius at a distance along the track, in metres. */
  cornerRadiusAt(distanceAlong: number): number {
    return this.sampleRadii[this.sampleIndexAt(distanceAlong)];
  }

  /**
   * The fastest a rider at `distanceAlong` can be going and still make every
   * corner in the next `lookahead` metres.
   *
   * For each point ahead this asks "what speed must I be at *there*, and how
   * fast may I be going *here* to still shed the difference by then" —
   * `v_here = sqrt(v_there^2 + 2 * decel * gap)` — and takes the tightest
   * answer. That is what produces a braking point: the limit stays at top
   * speed until a corner comes within braking distance, then falls smoothly.
   */
  speedLimitAhead(
    distanceAlong: number,
    lateralAccel: number,
    brakeDecel: number,
    lookahead: number,
  ): number {
    let limit = Infinity;
    const step = Math.max(this.sampleSpacing, 3);
    for (let gap = 0; gap <= lookahead; gap += step) {
      const radius = this.cornerRadiusAt(distanceAlong + gap);
      if (!Number.isFinite(radius)) continue;
      const cornerSpeed = Math.sqrt(lateralAccel * radius);
      limit = Math.min(limit, Math.sqrt(cornerSpeed * cornerSpeed + 2 * brakeDecel * gap));
    }
    return limit;
  }

  get sampleCount(): number {
    return this.samplePoints.length;
  }

  /** Length of the actual race, start line to finish line. */
  get raceLength(): number {
    return this.finishDistance - this.startDistance;
  }

  /** World-space position `metresAlong` down the track and `lateral` metres right of the centreline. */
  spawnPoint(metresAlong: number, lateral: number, heightAboveRoad: number): THREE.Vector3 {
    const u = THREE.MathUtils.clamp(metresAlong / this.totalLength, 0, 1);
    const point = this.curve.getPointAt(u);
    const tangent = this.curve.getTangentAt(u).normalize();
    const right = rightOf(tangent, new THREE.Vector3());
    return point.addScaledVector(right, lateral).addScaledVector(WORLD_UP, heightAboveRoad);
  }

  /** Rotation that faces a rider down the track at `metresAlong`, assuming local +Z is forward. */
  spawnRotation(metresAlong: number): THREE.Quaternion {
    const u = THREE.MathUtils.clamp(metresAlong / this.totalLength, 0, 1);
    const tangent = this.curve.getTangentAt(u).normalize();
    // Flatten to horizontal so riders start upright rather than pitched into a slope.
    tangent.y = 0;
    tangent.normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
  }

  /**
   * Finds where `position` sits relative to the centerline.
   *
   * Pass the previous result's `sampleIndex` as `hintIndex` to restrict the
   * search to a window around where the rider was last frame — riders move a
   * couple of metres per step, so this turns an O(samples) scan into a fixed
   * small one. The window is abandoned in favour of a full scan if the best
   * match lands on its edge, so a teleport or respawn can't leave a rider
   * permanently locked onto the wrong part of the track.
   */
  project(position: THREE.Vector3, hintIndex = -1): TrackProjection {
    const count = this.samplePoints.length;
    const WINDOW = 40;

    let searchStart = 0;
    let searchEnd = count - 1;
    let windowed = false;
    if (hintIndex >= 0 && hintIndex < count) {
      searchStart = Math.max(0, hintIndex - WINDOW);
      searchEnd = Math.min(count - 1, hintIndex + WINDOW);
      windowed = true;
    }

    let best = this.nearestSampleIn(position, searchStart, searchEnd);
    if (windowed) {
      const onLowEdge = best === searchStart && searchStart > 0;
      const onHighEdge = best === searchEnd && searchEnd < count - 1;
      if (onLowEdge || onHighEdge) {
        best = this.nearestSampleIn(position, 0, count - 1);
      }
    }

    // Refine against the two segments adjoining the nearest sample, so the
    // result is continuous rather than quantised to sample positions.
    let bestDistSq = Infinity;
    let bestIndex = best;
    let bestT = 0;
    for (const start of [best - 1, best]) {
      if (start < 0 || start + 1 >= count) continue;
      const t = this.projectOntoSegment(position, start);
      const distSq = this.tmpClosest.distanceToSquared(position);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestIndex = start;
        bestT = t;
      }
    }

    const a = this.samplePoints[bestIndex];
    const b = this.samplePoints[bestIndex + 1] ?? a;
    const centerPoint = new THREE.Vector3().lerpVectors(a, b, bestT);
    const tangent = this.sampleTangents[bestIndex].clone();
    const right = this.sampleRights[bestIndex];

    const distanceAlong = THREE.MathUtils.lerp(
      this.sampleDistances[bestIndex],
      this.sampleDistances[Math.min(bestIndex + 1, count - 1)],
      bestT,
    );

    this.tmpToPos.subVectors(position, centerPoint);
    const lateralOffset = this.tmpToPos.dot(right);

    return { distanceAlong, lateralOffset, centerPoint, tangent, sampleIndex: bestIndex };
  }

  private nearestSampleIn(position: THREE.Vector3, start: number, end: number): number {
    let bestIndex = start;
    let bestDistSq = Infinity;
    for (let i = start; i <= end; i++) {
      const distSq = this.samplePoints[i].distanceToSquared(position);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  /** Projects onto segment [index, index+1], writing the closest point to `tmpClosest` and returning its 0..1 parameter. */
  private projectOntoSegment(position: THREE.Vector3, index: number): number {
    const a = this.samplePoints[index];
    const b = this.samplePoints[index + 1];
    this.tmpSeg.subVectors(b, a);
    const segLenSq = this.tmpSeg.lengthSq();
    if (segLenSq < 1e-9) {
      this.tmpClosest.copy(a);
      return 0;
    }
    this.tmpToPos.subVectors(position, a);
    const t = THREE.MathUtils.clamp(this.tmpToPos.dot(this.tmpSeg) / segLenSq, 0, 1);
    this.tmpClosest.copy(a).addScaledVector(this.tmpSeg, t);
    return t;
  }
}
