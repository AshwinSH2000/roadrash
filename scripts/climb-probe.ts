import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { Racer } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { OpponentAI } from "../src/ai/OpponentAI";
import { OPPONENT_PERSONALITIES } from "../src/ai/RiderPersonality";
import { hillclimbLayout, WALL_GRADE } from "../src/track/tracks";
import { validateTrack } from "../src/track/TrackValidator";
import { FIXED_DT } from "../src/core/Clock";
import { DEFAULT_VEHICLE_CONFIG } from "../src/physics/VehicleController";
import { ROAD_HALF_WIDTH } from "../src/track/TrackDefinition";
import { LOCAL_FORWARD } from "../src/utils/Directions";

/**
 * Drives the Wall on Hillclimb three ways and reports what the bike did:
 *   1. a bot at racing speed — does it clear the crest, fly, land, keep going?
 *   2. a full-throttle run from a STANDSTILL at the foot — can it climb at all?
 *   3. a player's nitro run — 130 km/h into the foot with the boost lit, which
 *      turns the crest hop and the drop into one 3 s flight that lands two
 *      thirds of the way down the far slope. Logged by the user as a bounce
 *      and a fit of "nonsense handling" that cost them the lead: the landing
 *      must be smooth, the nose must stay pointed down the road while
 *      airborne, and the bike must still be on the tarmac at the bottom.
 *
 * Run with: npm run sim:climb
 */
const detail = process.env.DETAIL ? process.env.DETAIL.split(",").map(Number) : null;
const WALL_FROM = 560;
const WALL_TO = 1150;

interface Result {
  minSpeed: number; maxSpeed: number; airborneSeconds: number; stalled: boolean; finished: boolean; log: string[];
  /** Most speed lost in the 0.3 s after a touchdown, m/s — a landing that hits like a wall shows up here. */
  landingLoss: number;
  /** Fastest the bike yawed with both wheels off the ground, rad/s. */
  peakAirborneYaw: number;
  /** Largest slip angle on the wall, degrees. */
  peakSlipDeg: number;
  /** Furthest off the road centre after the crest, metres. */
  maxLateralAfterCrest: number;
  /** Speed on the flat after the drop, m/s. */
  exitSpeed: number;
}

type Mode = "bot" | "rest" | "nitro";
/** Where the player in the logged incident lit the nitro: 10 m before the foot of the wall. */
const NITRO_AT = 770;
const NITRO_SECONDS = 5;
/** The logged approach speed, m/s (130 km/h). */
const NITRO_APPROACH_SPEED = 36;

async function run(mode: Mode, grade: number): Promise<Result> {
  const fromRest = mode === "rest";
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition(hillclimbLayout(grade));
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);

  const p = OPPONENT_PERSONALITIES[0];
  const cfg = DEFAULT_VEHICLE_CONFIG;
  if (process.env.GRADE_FOLLOW) cfg.gradeFollowing = +process.env.GRADE_FOLLOW;
  if (process.env.SHIFT_CAP) cfg.gradeFollowingMaxShift = +process.env.SHIFT_CAP;
  if (process.env.SMOOTH) cfg.gradeFollowingSmoothing = +process.env.SMOOTH;
  // From rest: spawned a third of the way UP the wall, not on the approach.
  const startAt = fromRest ? 790 + 40 : mode === "nitro" ? WALL_FROM : track.startDistance;
  const spawnRot = track.spawnRotation(startAt);
  const bike = new Bike(physics, surfaces, scene, track.spawnPoint(startAt, 0, 1.0), spawnRot, p.color);
  const rider = new RiderStateMachine(physics, scene, bike, p.color);
  const racer = new Racer(bike, p.name, false, p.color, rider);
  racer.updateTrackPosition(track);
  racer.driver = new OpponentAI(racer, track, [racer], p);
  if (mode === "nitro") {
    const dir = LOCAL_FORWARD.clone().applyQuaternion(spawnRot).multiplyScalar(NITRO_APPROACH_SPEED);
    bike.controller.chassisBody.setLinvel({ x: dir.x, y: dir.y, z: dir.z }, true);
  }

  const log: string[] = [];
  let minSpeed = Infinity, maxSpeed = 0, airborne = 0, lastPrint = -1, t = 0;
  let stalled = false;
  let landingLoss = 0, peakAirborneYaw = 0, peakSlipDeg = 0, maxLateralAfterCrest = 0, exitSpeed = 0;
  let nitroLitAt = -1, wasAirborne = false, touchdownSpeed = 0, touchdownAt = -Infinity, lastSpeed = bike.forwardSpeed;
  for (let step = 0; step < 60 * 150; step++) {
    if (mode === "bot") racer.tickDriver(FIXED_DT); else bike.setInput(1, 0);
    if (fromRest) rider.tick(FIXED_DT);
    if (mode === "nitro") {
      if (nitroLitAt < 0 && racer.distanceAlong >= NITRO_AT) nitroLitAt = t;
      bike.controller.setBoost(nitroLitAt >= 0 && t - nitroLitAt < NITRO_SECONDS);
    }
    bike.prePhysicsStep(FIXED_DT); physics.step(); bike.postPhysicsStep();
    racer.updateTrackPosition(track);
    t += FIXED_DT;
    const d = racer.distanceAlong;
    if (detail && t >= detail[0] && t <= detail[1]) {
      const pos = bike.worldPosition;
      const body = bike.controller.chassisBody;
      const roadHit = physics.world.castRay(new RAPIER.Ray({ x: pos.x, y: 500, z: pos.z }, { x: 0, y: -1, z: 0 }), 1000, true, undefined, undefined, undefined, body);
      const roadY = roadHit ? 500 - roadHit.timeOfImpact : NaN;
      const veh = (bike.controller as unknown as { vehicle: RAPIER.DynamicRayCastVehicleController }).vehicle;
      const vy = body.linvel().y;
      log.push(
        `    step ${t.toFixed(3)}  xz (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})  dist ${d.toFixed(1)}  lateral ${racer.lateralOffset.toFixed(2)}  y ${pos.y.toFixed(2)}  road-at-xz ${roadY.toFixed(2)}  above-road ${(pos.y - roadY).toFixed(2)}  vy ${vy.toFixed(2)}  ` +
          `wheels ${bike.controller.wheelIsGrounded(0) ? "F" : "-"}${bike.controller.wheelIsGrounded(1) ? "R" : "-"}  ` +
          `susp F ${(veh.wheelSuspensionLength(0) ?? NaN).toFixed(2)} R ${(veh.wheelSuspensionLength(1) ?? NaN).toFixed(2)}  ` +
          `force F ${(veh.wheelSuspensionForce(0) ?? 0).toFixed(0)} R ${(veh.wheelSuspensionForce(1) ?? 0).toFixed(0)}`,
      );
    }
    if (d >= WALL_FROM && d <= WALL_TO) {
      const v = bike.forwardSpeed;
      minSpeed = Math.min(minSpeed, v);
      maxSpeed = Math.max(maxSpeed, v);
      const cF = bike.controller.wheelIsGrounded(0), cR = bike.controller.wheelIsGrounded(1);
      const isAirborne = !cF && !cR;
      if (isAirborne) {
        airborne += FIXED_DT;
        peakAirborneYaw = Math.max(peakAirborneYaw, Math.abs(bike.controller.yawRate));
      } else if (wasAirborne) {
        touchdownSpeed = lastSpeed;
        touchdownAt = t;
      }
      if (t - touchdownAt <= 0.3) landingLoss = Math.max(landingLoss, touchdownSpeed - v);
      wasAirborne = isAirborne;
      peakSlipDeg = Math.max(peakSlipDeg, Math.abs(THREE.MathUtils.radToDeg(bike.controller.slipAngle)));
      if (d > 900) maxLateralAfterCrest = Math.max(maxLateralAfterCrest, Math.abs(racer.lateralOffset));
      if (d > 1100) exitSpeed = v;
      if (t - lastPrint >= 0.25) {
        lastPrint = t;
        const pos = bike.worldPosition;
        const y = pos.y;
        const ahead = track.spawnPoint(Math.min(d + 3, track.totalLength), 0, 0).y - track.spawnPoint(d, 0, 0).y;
        // What is actually under (and over) the chassis centre, per the physics world.
        // Exclude the bike's own body, or the ray reports the chassis it starts inside.
        const body = bike.controller.chassisBody;
        const down = physics.world.castRay(new RAPIER.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: -1, z: 0 }), 300, true, undefined, undefined, undefined, body);
        const up = physics.world.castRay(new RAPIER.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: 1, z: 0 }), 300, true, undefined, undefined, undefined, body);
        const veh = (bike.controller as unknown as { vehicle: RAPIER.DynamicRayCastVehicleController }).vehicle;
        const sl = (i: number): string => (veh.wheelSuspensionLength(i) ?? NaN).toFixed(2);
        const rl = (i: number): string => (veh.wheelSuspensionRestLength(i) ?? NaN).toFixed(2);
        log.push(
          `${t.toFixed(2).padStart(6)}  ${d.toFixed(0).padStart(5)} m  ${(v * 3.6).toFixed(0).padStart(4)} km/h  y ${y.toFixed(1).padStart(6)}  road-centre ${track.spawnPoint(d, 0, 0).y.toFixed(1).padStart(6)}  ` +
            `ground below ${down ? (down.timeOfImpact).toFixed(2).padStart(6) + " m" : "   none"}  above ${up ? up.timeOfImpact.toFixed(2) + " m" : "none"}  ` +
            `grade ${(ahead / 3 * 100).toFixed(0).padStart(4)}%  wheels ${cF ? "F" : "-"}${cR ? "R" : "-"}  susp F ${sl(0)}/${rl(0)} R ${sl(1)}/${rl(1)}` +
            (mode === "nitro" ? `  lat ${racer.lateralOffset.toFixed(1).padStart(5)}  yaw ${bike.controller.yawRate.toFixed(2).padStart(5)}  slip ${THREE.MathUtils.radToDeg(bike.controller.slipAngle).toFixed(0).padStart(3)}${bike.controller.isBoosting ? "  NITRO" : ""}` : ""),
        );
      }
      if (fromRest && t > 3 && v < 0.5) { stalled = true; break; }
    }
    lastSpeed = bike.forwardSpeed;
    if (d > WALL_TO) break;
    if (bike.worldPosition.y < -60) { log.push("  FELL OFF THE WORLD"); break; }
  }
  return {
    minSpeed, maxSpeed, airborneSeconds: airborne, stalled, finished: racer.distanceAlong > WALL_TO, log,
    landingLoss, peakAirborneYaw, peakSlipDeg, maxLateralAfterCrest, exitSpeed,
  };
}

async function main(): Promise<void> {
  const grades = process.env.GRADES ? process.env.GRADES.split(",").map(Number) : [WALL_GRADE];
  const verbose = grades.length === 1;
  let failed = false;
  for (const grade of grades) {
    const deg = THREE.MathUtils.radToDeg(Math.atan(grade));
    console.log(`\n===== The Wall at ${(grade * 100).toFixed(0)}% grade (${deg.toFixed(1)} deg), ${(90 * grade).toFixed(0)} m tall =====`);
    const report = validateTrack(new TrackDefinition(hillclimbLayout(grade)));
    const problems: string[] = [...report.problems];

    const bot = await run("bot", grade);
    if (verbose) { console.log("--- bot at racing speed ---"); for (const l of bot.log) console.log(l); }
    console.log(`bot:        min speed ${(bot.minSpeed * 3.6).toFixed(0)} km/h, max on the drop ${(bot.maxSpeed * 3.6).toFixed(0)} km/h, airborne ${bot.airborneSeconds.toFixed(2)} s total, ${bot.finished ? "cleared it" : "DID NOT clear it"}`);
    if (!bot.finished) problems.push("A bot at racing speed did not get over the wall.");
    // The crest is a ~1 s jump and the top of the drop another ~2 s of
    // flight before the bike meets the slope again — both intended.
    if (bot.airborneSeconds > 3.5) problems.push(`Airborne ${bot.airborneSeconds.toFixed(1)} s in total — a launch, not a jump.`);

    const rest = await run("rest", grade);
    if (verbose) { console.log("\n--- full throttle from a standstill ON the wall ---"); for (const l of rest.log) console.log(l); }
    console.log(`standstill: ${rest.stalled ? "STALLED" : rest.finished ? "climbed it" : "did not finish"}${rest.finished ? `, crest speed ${(rest.minSpeed * 3.6).toFixed(0)}+ km/h` : ""}`);
    if (rest.stalled || !rest.finished) problems.push("The bike cannot climb the wall from a standstill — a player who slows on it is stuck.");

    const nitro = await run("nitro", grade);
    if (verbose) { console.log("\n--- player at 130 km/h with nitro lit at the foot ---"); for (const l of nitro.log) console.log(l); }
    console.log(
      `nitro:      airborne ${nitro.airborneSeconds.toFixed(2)} s, landing cost ${(nitro.landingLoss * 3.6).toFixed(0)} km/h, airborne yaw peak ${nitro.peakAirborneYaw.toFixed(2)} rad/s, ` +
        `slip peak ${nitro.peakSlipDeg.toFixed(0)} deg, off centre after the crest ${nitro.maxLateralAfterCrest.toFixed(1)} m, exit ${(nitro.exitSpeed * 3.6).toFixed(0)} km/h, ${nitro.finished ? "cleared it" : "DID NOT clear it"}`,
    );
    // The recorded incident: 50 km/h lost on touchdown, 3.4 rad/s of yaw in
    // the air, 41 deg of slip on the second landing, 11 m off the road.
    if (!nitro.finished) problems.push("The nitro run did not get over the wall.");
    if (nitro.landingLoss * 3.6 > 15) problems.push(`Nitro landing cost ${(nitro.landingLoss * 3.6).toFixed(0)} km/h — it hit, not landed.`);
    if (nitro.peakAirborneYaw > 0.5) problems.push(`Nose swung at ${nitro.peakAirborneYaw.toFixed(2)} rad/s while airborne — the bike is steering itself in the air.`);
    if (nitro.peakSlipDeg > 10) problems.push(`Slip reached ${nitro.peakSlipDeg.toFixed(0)} deg on the wall — landed crooked.`);
    if (nitro.maxLateralAfterCrest > ROAD_HALF_WIDTH) problems.push(`Ended up ${nitro.maxLateralAfterCrest.toFixed(1)} m off centre after the crest — off the road.`);

    if (problems.length) { failed = grade === WALL_GRADE || failed; console.log("PROBLEMS:"); for (const p of problems) console.log("  - " + p); }
    else console.log("ok");
  }
  if (grades.length === 1) console.log(failed ? "\nFAIL" : "\nPASS  the wall is climbable, the crest is a jump, not a launch, and a nitro flight lands straight.");
  process.exit(failed ? 1 : 0);
}
void main();
