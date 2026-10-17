import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { Racer } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { StuntSystem } from "../src/entities/StuntSystem";
import { OpponentAI } from "../src/ai/OpponentAI";
import { OPPONENT_PERSONALITIES } from "../src/ai/RiderPersonality";
import { TRACKS } from "../src/track/tracks";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD } from "../src/utils/Directions";

/**
 * Exercises the Daredevil Run's three stunts headlessly:
 *
 *   loop   — enters the loop at a range of speeds and reports what the physics
 *            did: speed at the top, peak g at the bottom, whether it held the
 *            road, and where it left it if it did not. Compared with the
 *            energy-conservation figure, since that is the whole point.
 *   sand   — crosses the pit straight and turning, reports speed lost and
 *            how far the bike slid sideways.
 *   river  — launches off the kicker at a range of speeds: does it clear the
 *            gap, and what does it land on.
 *   bots   — a full bot field through the course.
 *
 * Run with: npm run sim:stunt
 */
const layout = TRACKS.find((t) => t.name === "Daredevil Run")!;

interface Rig {
  physics: PhysicsWorld;
  track: TrackDefinition;
  bike: Bike;
  racer: Racer;
  stunts: StuntSystem;
}

async function rig(distance: number, speed: number): Promise<Rig> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition(layout);
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);
  const p = OPPONENT_PERSONALITIES[0];
  const rotation = track.spawnRotation(distance);
  const bike = new Bike(physics, surfaces, scene, track.spawnPoint(distance, 0, 1.0), rotation, p.color);
  const rider = new RiderStateMachine(physics, scene, bike, p.color);
  const racer = new Racer(bike, p.name, false, p.color, rider);
  racer.updateTrackPosition(track);
  const dir = LOCAL_FORWARD.clone().applyQuaternion(rotation).multiplyScalar(speed);
  bike.controller.chassisBody.setLinvel({ x: dir.x, y: dir.y, z: dir.z }, true);
  return { physics, track, bike, racer, stunts: new StuntSystem(track) };
}

function step(r: Rig, throttle: number, steer = 0): void {
  r.bike.setInput(throttle, steer);
  r.racer.rider.tick(FIXED_DT);
  r.bike.prePhysicsStep(FIXED_DT);
  r.physics.step();
  r.bike.postPhysicsStep();
  r.stunts.update([r.racer]);
  r.racer.updateTrackPosition(r.track);
}

async function loopRun(kph: number, throttle: number, steer = 0): Promise<string> {
  const track0 = new TrackDefinition(layout);
  const loop = track0.featuresOfKind("loop")[0];
  const r = await rig(loop.startDistance - 40, kph / 3.6);
  const ride0 = () => r.bike.controller.currentLoopRide;
  let started = false, peakG = 0, minSpeed = Infinity, topSpeed = 0, entrySpeed = 0, failTheta = -1, finished = false;
  let maxHeight = 0;
  for (let i = 0; i < 60 * 14; i++) {
    step(r, throttle, r.bike.controller.currentLoopRide ? steer : 0);
    const ride = ride0();
    if (ride) {
      if (!started) { started = true; entrySpeed = ride.speed; }
      peakG = Math.max(peakG, ride.gForce);
      minSpeed = Math.min(minSpeed, ride.speed);
      if (Math.abs(ride.theta - Math.PI) < 0.05) topSpeed = ride.speed;
      maxHeight = Math.max(maxHeight, r.bike.worldPosition.y);
    } else if (started) {
      finished = true;
      if (!r.racer.rider.isRiding) failTheta = Math.max(failTheta, 0);
      break;
    }
  }
  // Carry on a few seconds: a completed loop must hand over to the road below.
  let afterNote = "";
  if (finished && r.racer.rider.isRiding) {
    const exitDistance = r.racer.distanceAlong;
    for (let i = 0; i < 60 * 4; i++) step(r, 0.4);
    const road = r.physics.world.castRay(
      new RAPIER.Ray({ x: r.bike.worldPosition.x, y: 100, z: r.bike.worldPosition.z }, { x: 0, y: -1, z: 0 }),
      200, true, undefined, undefined, undefined, r.bike.controller.chassisBody,
    );
    const above = road ? r.bike.worldPosition.y - (100 - road.timeOfImpact) : NaN;
    afterNote = `  +4s: ${(r.racer.distanceAlong - exitDistance).toFixed(0)} m on, ${above.toFixed(2)} m above road, lateral ${r.racer.lateralOffset.toFixed(1)}, ${r.racer.rider.isRiding ? "riding" : "DOWN"}`;
  }
  const fellOff = finished && !r.racer.rider.isRiding;
  if (fellOff) {
    // Let the fall play out: the rider must tumble, get up, remount and ride on.
    let seconds = 0;
    while (!r.racer.rider.isRiding && seconds < 40) {
      step(r, 1);
      seconds += FIXED_DT;
    }
    afterNote = `  recovered after ${seconds.toFixed(1)} s at ${r.racer.distanceAlong.toFixed(0)} m (loop ${loop.startDistance.toFixed(0)}-${loop.endDistance.toFixed(0)})${r.racer.rider.isRiding ? "" : " NOT RECOVERED"}`;
  }
  const ridden = r.racer.rider.isRiding;
  const exitKph = Math.abs(r.bike.forwardSpeed) * 3.6;
  // Let a failure play out and report where the bike ended up relative to the road.
  return (
    `  ${String(kph).padStart(4)} km/h in (thr ${throttle} steer ${steer})  entry ${(entrySpeed * 3.6).toFixed(0)}  ` +
    `top ${(topSpeed * 3.6).toFixed(0)} km/h  min ${(minSpeed * 3.6).toFixed(0)}  peak ${peakG.toFixed(1)} g  ` +
    `apex ${maxHeight.toFixed(1)} m  ` +
    (started ? (finished && !fellOff && ridden ? `COMPLETED, out at ${exitKph.toFixed(0)} km/h` : `FELL (rider ${r.racer.rider.current})`) : "never entered the loop") +
    afterNote
  );
}

/** Rides across the sand at a speed, optionally steering while in it, and reports what the pit did. */
async function sandRun(kph: number, steer: number): Promise<string> {
  const track0 = new TrackDefinition(layout);
  const sand = track0.featuresOfKind("sand")[0];
  const r = await rig(sand.startDistance - 60, kph / 3.6);
  const ctl = r.bike.controller;
  let speedIn = NaN, speedOut = NaN, peakSlip = 0, peakYaw = 0, lateral0 = 0, lateralEnd = 0, headingIn = 0, headingOut = 0;
  const heading = () => {
    const f = LOCAL_FORWARD.clone().applyQuaternion(r.bike.worldQuaternion);
    return Math.atan2(f.x, f.z);
  };
  for (let i = 0; i < 60 * 8; i++) {
    const d = r.racer.distanceAlong;
    const inSand = d >= sand.startDistance && d <= sand.endDistance;
    step(r, 1, inSand ? steer : 0);
    if (inSand) {
      if (Number.isNaN(speedIn)) { speedIn = ctl.forwardSpeed; headingIn = heading(); lateral0 = r.racer.lateralOffset; }
      peakSlip = Math.max(peakSlip, Math.abs((ctl as unknown as { currentSlipAngle: number }).currentSlipAngle));
      peakYaw = Math.max(peakYaw, Math.abs(ctl.yawRate));
    }
    if (d > sand.endDistance + 0.5 && Number.isNaN(speedOut)) {
      speedOut = ctl.forwardSpeed; headingOut = heading(); lateralEnd = r.racer.lateralOffset;
    }
    if (d > sand.endDistance + 25) break;
  }
  const turn = (((headingOut - headingIn) * 180) / Math.PI + 540) % 360 - 180;
  return (
    `  ${kph} km/h steer ${steer.toFixed(1)}: in ${(speedIn * 3.6).toFixed(0)} -> out ${(speedOut * 3.6).toFixed(0)} km/h ` +
    `(lost ${((speedIn - speedOut) * 3.6).toFixed(1)}), peak slip ${((peakSlip * 180) / Math.PI).toFixed(1)} deg, peak yaw ${peakYaw.toFixed(2)} rad/s, ` +
    `turned ${turn.toFixed(1)} deg, drifted ${(lateralEnd - lateral0).toFixed(1)} m sideways, ${r.racer.rider.isRiding ? "upright" : "DOWN"}`
  );
}

/** The kicker at a speed: clear or not, and what it lands on. */
async function riverRun(kph: number): Promise<string> {
  const track0 = new TrackDefinition(layout);
  const river = track0.featuresOfKind("river")[0];
  const r = await rig(river.startDistance - 30, kph / 3.6);
  let airborne = 0, wasAir = false, landedSurface = "", landSpeed = 0, outcome = "";
  let peakHeight = -Infinity;
  const startY = r.bike.worldPosition.y;
  const trace = process.env.TRACE_KPH && +process.env.TRACE_KPH === kph;
  for (let i = 0; i < 60 * 10; i++) {
    step(r, 0);
    if (trace && r.racer.distanceAlong > river.startDistance - 12 && r.racer.distanceAlong < river.endDistance + 25 && i % 3 === 0) {
      const c = r.bike.controller;
      console.log(`    d ${r.racer.distanceAlong.toFixed(1)}  y ${r.bike.worldPosition.y.toFixed(2)}  v ${(c.forwardSpeed * 3.6).toFixed(0)}  vy ${c.chassisBody.linvel().y.toFixed(1)}  F:${c.wheelSurfaceName(0)} R:${c.wheelSurfaceName(1)}`);
    }
    const ctl = r.bike.controller;
    const air = !ctl.wheelIsGrounded(0) && !ctl.wheelIsGrounded(1);
    if (air) airborne += FIXED_DT;
    peakHeight = Math.max(peakHeight, r.bike.worldPosition.y - startY);
    if (wasAir && !air && !landedSurface) { landedSurface = ctl.wheelSurfaceName(0) !== "air" ? ctl.wheelSurfaceName(0) : ctl.wheelSurfaceName(1); landSpeed = ctl.forwardSpeed; }
    wasAir = air;
    if (StuntSystem.inWater(r.racer)) { outcome = "FELL IN THE RIVER"; break; }
    if (r.racer.distanceAlong > river.endDistance + 40) { outcome = r.racer.rider.isRiding ? "CLEARED" : "cleared but fell"; break; }
  }
  return `  ${kph} km/h: ${outcome || "timed out"}  air ${airborne.toFixed(2)} s, landed on ${landedSurface || "-"} at ${(landSpeed * 3.6).toFixed(0)} km/h`;
}

async function main(): Promise<void> {
  const track = new TrackDefinition(layout);
  const loop = track.featuresOfKind("loop")[0];
  const geometry = loop.loop!;
  console.log(`Daredevil Run: ${track.totalLength.toFixed(0)} m, features: ${track.features.map((f) => `${f.kind}@${f.startDistance.toFixed(0)}-${f.endDistance.toFixed(0)}`).join("  ")}`);
  console.log(`loop: radius ${geometry.radius} m, path ${geometry.pathLength.toFixed(1)} m, top ${(2 * geometry.radius).toFixed(0)} m up`);
  const g = 9.81;
  const idealMin = Math.sqrt(5 * g * geometry.radius) * 3.6;
  console.log(`ideal minimum entry speed (point mass, no drag/engine): ${idealMin.toFixed(0)} km/h\n`);

  console.log("LOOP — coasting (throttle 0):");
  for (const kph of [70, 90, 100, 110, 125, 145]) console.log(await loopRun(kph, 0));
  console.log("LOOP — throttle on:");
  for (const kph of [90, 110, 145]) console.log(await loopRun(kph, 1));
  console.log("LOOP — steering across the ribbon (gentle completes; a committed lunge at the edge throws you off):");
  console.log(await loopRun(130, 1, 0.5));
  console.log(await loopRun(130, 1, -0.5));
  console.log(await loopRun(130, 1, 1));
  console.log(await loopRun(130, 1, -1));

  console.log("\nSAND — straight through, then trying to turn in it (full throttle):");
  for (const kph of [90, 130]) {
    console.log(await sandRun(kph, 0));
    console.log(await sandRun(kph, 0.25));
    console.log(await sandRun(kph, 0.6));
  }

  console.log("\nRIVER — kicker, coasting from 30 m out:");
  for (const kph of [60, 70, 80, 90, 100, 110, 130, 145]) console.log(await riverRun(kph));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
