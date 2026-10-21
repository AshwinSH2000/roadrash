import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { pickTrack } from "../src/track/tracks";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { Racer } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { Traffic, CRASH_CLOSING_KPH } from "../src/entities/Traffic";
import { FIXED_DT } from "../src/core/Clock";

/**
 * Rides the player's bike down the drag strip into the first vehicle in its
 * lane at a range of speeds, and reports what the traffic does: whether the
 * rider is thrown, how far the vehicle takes to stop, and what speed the bike
 * is left with after a shunt.
 *
 *   npm run sim:traffic
 */
const speeds = process.env.TRIALS ? Array<number>(Number(process.env.TRIALS)).fill(130) : [60, 80, 100, 130, 180, 245];

for (const kph of speeds) {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition(pickTrack("Drag Race"));
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);
  const traffic = new Traffic(physics, scene, track);

  // Start well back from the first vehicle in lane 3, at the speed under test.
  const lateral = 5.25;
  const startAt = track.startDistance + 100;
  const bike = new Bike(physics, surfaces, scene, track.spawnPoint(startAt, lateral, 1.0), track.spawnRotation(startAt));
  const rider = new RiderStateMachine(physics, scene, bike, 0x2266dd);
  const racer = new Racer(bike, "You", true, 0x2266dd, rider);

  const step = (): void => {
    racer.updateTrackPosition(track);
    const impact = traffic.resolvePlayerImpact(racer, FIXED_DT);
    if (impact) report = impact;
    traffic.update(FIXED_DT);
    rider.tick(FIXED_DT);
    if (rider.isRiding) {
      // Hold the speed and the lane, so the test is about the collision.
      bike.setInput(bike.forwardSpeed * 3.6 < kph ? 1 : 0, Math.max(-1, Math.min(1, (lateral - racer.lateralOffset) * -0.05)));
    } else bike.setInput(0, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  };
  let report: ReturnType<Traffic["resolvePlayerImpact"]> = null;

  for (let i = 0; i < 60 * 120 && !report; i++) {
    step();
    if (i < 60 * 30 && bike.forwardSpeed * 3.6 < kph - 1) continue;
  }
  if (!report) {
    console.log(`${kph} km/h: no collision within the run (first vehicle in lane 3 not reached)`);
    continue;
  }
  const hit = report as NonNullable<typeof report>;
  const speedAtHit = bike.forwardSpeed * 3.6;
  for (let i = 0; i < 60 * 3; i++) step();
  let recoverSeconds = -1;
  if (hit.crashed) {
    for (let i = 0; i < 60 * 40; i++) {
      step();
      if (rider.isRiding) {
        recoverSeconds = 3 + (i + 1) * FIXED_DT;
        break;
      }
    }
  }
  console.log(
    `${kph} km/h  hit a ${hit.vehicle} at ${hit.closingKph.toFixed(0)} km/h closing (bike ${speedAtHit.toFixed(0)}): ` +
      `${hit.crashed ? "THROWN" : "stayed on"}; rider ${rider.current}; bike 3 s later ${(bike.forwardSpeed * 3.6).toFixed(0)} km/h` +
      ` (threshold ${CRASH_CLOSING_KPH}); ${hit.crashed ? 'back on the bike after ' + (recoverSeconds < 0 ? 'NEVER (40 s)' : recoverSeconds.toFixed(1) + ' s') : ''}`,
  );
}
