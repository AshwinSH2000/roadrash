import { TrackDefinition, OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import { DEFAULT_VEHICLE_CONFIG } from "../physics/VehicleController";

/**
 * The geometric properties a course must have for the rest of the game to
 * work, checked against the real `TrackDefinition` — the same samples and
 * corner radii the AI drives by. Formerly `scripts/check-track.mjs`, which
 * parsed the source file with regular expressions; that could only ever check
 * one track, and only if the file kept its exact shape.
 *
 *  1. The course never runs close to itself. `project()` takes the nearest
 *     centreline point to be the meaningful one, and overlapping ribbons
 *     would render as a mess.
 *  2. No grade steeper than the suspension can absorb across the wheelbase.
 *  3. No corner tighter than the off-road band can be drawn around.
 *  4. The course still demands braking: a minimum number of corners that
 *     cannot be held near top speed.
 */
export interface Corner {
  distance: number;
  radius: number;
  holdableKph: number;
  braking: boolean;
}

export interface TrackReport {
  name: string;
  controlPoints: number;
  length: number;
  closestApproach: { distance: number; a: number; b: number };
  requiredClearance: number;
  steepest: { grade: number; distance: number };
  maxGrade: number;
  corners: Corner[];
  brakingZones: number;
  minBrakingZones: number;
  tightest: Corner | null;
  minCornerRadius: number;
  problems: string[];
}

/** Two sections only need to stay apart if they are far apart *along* the road. */
const MIN_ARC_SEPARATION = 120;
/**
 * Was 12% when the chassis simply sat level on a slope. With the suspension
 * following the grade (VehicleController.applyGradeFollowing) the bike keeps
 * both wheels loaded much further; `sim:climb` measures where it gives up.
 */
const MAX_GRADE = 0.4;
/**
 * The bike delivers a flat 90% of the cornering acceleration the steering
 * asks for, at every speed and regardless of grip — measured with
 * `npm run sim:skidpad`. Corner speeds are computed from the delivered figure.
 */
const GRIP_DELIVERY = 0.9;
/** A corner is a local minimum of radius; minima closer than this are one corner read twice. */
const CORNER_MERGE_DISTANCE = 60;
const CORNER_RADIUS_CEILING = 220;
const MIN_BRAKING_ZONES = 4;
const MIN_CORNER_SPEED_KPH = 45;

export function validateTrack(track: TrackDefinition): TrackReport {
  const cfg = DEFAULT_VEHICLE_CONFIG;
  const points = track.samplePoints;
  const distances = track.sampleDistances;
  const problems: string[] = [];

  // 1. Self-clearance
  const requiredClearance = OFFROAD_HALF_WIDTH * 2 + 10;
  let closest = { distance: Infinity, a: 0, b: 0 };
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (distances[j] - distances[i] < MIN_ARC_SEPARATION) continue;
      const d = points[i].distanceTo(points[j]);
      if (d < closest.distance) closest = { distance: d, a: distances[i], b: distances[j] };
    }
  }
  if (closest.distance < requiredClearance) {
    problems.push(
      `runs too close to itself: ${closest.distance.toFixed(0)} m between ${closest.a.toFixed(0)} m and ${closest.b.toFixed(0)} m along (need ${requiredClearance.toFixed(0)} m).`,
    );
  }

  // 2. Grade
  let steepest = { grade: 0, distance: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const horizontal = Math.hypot(b.x - a.x, b.z - a.z);
    if (horizontal < 1e-6) continue;
    const grade = Math.abs(b.y - a.y) / horizontal;
    if (grade > steepest.grade) steepest = { grade, distance: distances[i] };
  }
  if (steepest.grade > MAX_GRADE) {
    problems.push(`grade of ${(steepest.grade * 100).toFixed(1)}% at ${steepest.distance.toFixed(0)} m exceeds ${MAX_GRADE * 100}%.`);
  }

  // 3./4. Corner profile, from the same radii the AI uses.
  const deliveredAccel = cfg.maxLateralAccel * GRIP_DELIVERY;
  const holdable = (radius: number): number => Math.sqrt(deliveredAccel * radius);
  const brakingThreshold = cfg.topSpeedEstimate * 0.85;
  const radii = track.sampleRadii;
  const corners: Corner[] = [];
  for (let i = 1; i < radii.length - 1; i++) {
    if (radii[i] >= CORNER_RADIUS_CEILING) continue;
    if (radii[i] > radii[i - 1] || radii[i] >= radii[i + 1]) continue;
    const previous = corners[corners.length - 1];
    if (previous && distances[i] - previous.distance < CORNER_MERGE_DISTANCE) {
      if (radii[i] < previous.radius) {
        previous.radius = radii[i];
        previous.distance = distances[i];
        previous.holdableKph = holdable(radii[i]) * 3.6;
        previous.braking = holdable(radii[i]) < brakingThreshold;
      }
      continue;
    }
    corners.push({
      distance: distances[i],
      radius: radii[i],
      holdableKph: holdable(radii[i]) * 3.6,
      braking: holdable(radii[i]) < brakingThreshold,
    });
  }
  const minCornerRadius = OFFROAD_HALF_WIDTH * 1.3;
  const tightest = corners.reduce<Corner | null>((best, c) => (!best || c.radius < best.radius ? c : best), null);
  if (tightest && tightest.radius < minCornerRadius) {
    problems.push(`corner at ${tightest.distance.toFixed(0)} m is ${tightest.radius.toFixed(0)} m radius; the off-road band needs ${minCornerRadius.toFixed(0)} m.`);
  }
  if (tightest && tightest.holdableKph < MIN_CORNER_SPEED_KPH) {
    problems.push(`corner at ${tightest.distance.toFixed(0)} m can only be taken at ${tightest.holdableKph.toFixed(0)} km/h; want ${MIN_CORNER_SPEED_KPH}+.`);
  }
  const brakingZones = corners.filter((c) => c.braking).length;
  if (brakingZones < MIN_BRAKING_ZONES) {
    problems.push(`only ${brakingZones} corner(s) need real braking; want at least ${MIN_BRAKING_ZONES}.`);
  }

  return {
    name: track.name,
    controlPoints: track.curve.points.length,
    length: track.totalLength,
    closestApproach: closest,
    requiredClearance,
    steepest,
    maxGrade: MAX_GRADE,
    corners,
    brakingZones,
    minBrakingZones: MIN_BRAKING_ZONES,
    tightest,
    minCornerRadius,
    problems,
  };
}
