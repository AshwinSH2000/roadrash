import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";

/**
 * Settles, from ground truth rather than derivation, which world axis is the
 * bike's right. Drives with steerInput = +1, which the user has confirmed in
 * the browser turns the bike RIGHT, and reports which way it actually goes in
 * its own starting frame.
 */
async function main(): Promise<void> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition();
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);

  const spawnRot = track.spawnRotation(track.startDistance);
  const bike = new Bike(physics, surfaces, scene,
    track.spawnPoint(track.startDistance, 0, 1.0), spawnRot);

  // The starting body frame, in world coordinates.
  const startFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(spawnRot).setY(0).normalize();
  const plusX = new THREE.Vector3(1, 0, 0).applyQuaternion(spawnRot).setY(0).normalize();
  const startPos = bike.worldPosition.clone();
  const disp = new THREE.Vector3();

  console.log(" t   yawRate   along-fwd   along-(+X)   <- steerInput = +1 (turns RIGHT)");
  for (let step = 0; step <= 60 * 5; step++) {
    bike.setInput(1, 1);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
    if (step % 30 === 0 && step > 0) {
      disp.subVectors(bike.worldPosition, startPos).setY(0);
      const yaw = bike.controller.yawRate;
      console.log(
        `${(step / 60).toFixed(1).padStart(4)}  ${yaw.toFixed(3).padStart(7)}   ` +
        `${disp.dot(startFwd).toFixed(1).padStart(8)}   ${disp.dot(plusX).toFixed(1).padStart(9)}`);
    }
  }
  console.log("\nIf 'along-(+X)' goes POSITIVE, local +X is the bike's RIGHT.");
  console.log("If it goes NEGATIVE, local -X is the bike's right.");
}
void main();
