import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD, LOCAL_RIGHT, WORLD_UP } from "../src/utils/Directions";

/**
 * Knocks the rider off at a set speed and prints the bike's height, speed and
 * the rider's height every 0.1 s, to compare against a telemetry log of the
 * debug knockdown at full speed.
 *
 *   npm run sim:jump -- 245          knockdown at 245 km/h
 *   npm run sim:jump -- 130 launch   the J-key jump at 130 km/h
 */
const KNOCK_IMPULSE = 250;
const targetKph = Number(process.argv[3] ?? 245);

const physics = await PhysicsWorld.create();
const surfaces = new SurfaceRegistry();
const track = new TrackDefinition();
const scene = new THREE.Scene();
buildTrack(physics, scene, track, surfaces);
const bike = new Bike(
  physics, surfaces, scene,
  track.spawnPoint(track.startDistance, 0, 1.0),
  track.spawnRotation(track.startDistance),
);
const rider = new RiderStateMachine(physics, scene, bike, 0x2266dd);

const step = (throttle: number): void => {
  rider.tick(FIXED_DT);
  if (rider.isRiding) bike.setInput(throttle, 0);
  else bike.setInput(0, 0);
  bike.prePhysicsStep(FIXED_DT);
  physics.step();
  bike.postPhysicsStep();
};

// Held at the target speed by setting the chassis velocity, so any speed can be tried on this track.
const forward = new THREE.Vector3();
for (let i = 0; i < 60; i++) {
  step(1);
  forward.copy(LOCAL_FORWARD).applyQuaternion(bike.worldQuaternion).multiplyScalar(targetKph / 3.6);
  const v = bike.controller.chassisBody.linvel();
  bike.controller.chassisBody.setLinvel({ x: forward.x, y: v.y, z: forward.z }, true);
}
console.log(`knock at ${(bike.forwardSpeed * 3.6).toFixed(0)} km/h`);
const impulse = new THREE.Vector3()
  .copy(LOCAL_RIGHT)
  .applyQuaternion(bike.worldQuaternion)
  .multiplyScalar(KNOCK_IMPULSE)
  .addScaledVector(WORLD_UP, KNOCK_IMPULSE * 0.35);
const startPos = bike.worldPosition.clone();
if (process.argv[4] === "launch") {
  // The J-key jump: straight up at 13 m/s, forward speed kept.
  const v = bike.controller.chassisBody.linvel();
  bike.controller.chassisBody.setLinvel({ x: v.x, y: 13, z: v.z }, true);
} else rider.knockOff(impulse);
for (let i = 0; i < 90; i++) {
  step(0);
  if (i % 6 === 5) {
    console.log(
      `${((i + 1) * FIXED_DT).toFixed(1)}s  bike speed ${(bike.forwardSpeed * 3.6).toFixed(0)} km/h  ` +
        `bike y ${bike.worldPosition.y.toFixed(2)}  fwd ${bike.worldPosition.distanceTo(startPos).toFixed(0)} m  ` +
        `rider y ${rider.cameraPosition.y.toFixed(2)}`,
    );
  }
}
