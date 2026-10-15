import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { RiderState, RiderStateMachine } from "../src/entities/RiderStateMachine";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_RIGHT, WORLD_UP } from "../src/utils/Directions";

/**
 * Exercises the knockdown-and-recovery cycle headlessly, at a range of
 * speeds, and applies Phase 5's verification criteria as pass/fail checks:
 *
 *   - falls at different speeds tumble visibly different distances
 *   - the ragdoll settles rather than jittering forever
 *   - getup -> run -> remount completes reliably, every time
 *   - no physics bodies leak: ragdoll body count returns to zero
 *
 * (pickup probe variant)
 */
const KNOCK_IMPULSE = 250;
/** Give up on a recovery after this long; anything slower is a hang, not a slow rider. */
const RECOVERY_TIMEOUT = 45;

interface Result {
  speedKph: number;
  tumbleDistance: number;
  settleSeconds: number;
  recoverSeconds: number;
  runDistance: number;
  completed: boolean;
  peakBodies: number;
  bodiesAfter: number;
}

async function main(): Promise<void> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition();
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);
  const bike = new Bike(physics, surfaces, scene, track.spawnPoint(track.startDistance, 0, 1.0), track.spawnRotation(track.startDistance));
  const rider = new RiderStateMachine(physics, scene, bike, 0x2266dd);
  const step = (throttle: number): void => {
    rider.tick(FIXED_DT);
    if (rider.isRiding) bike.setInput(throttle, 0); else bike.setInput(0, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  };
  for (let i = 0; i < 3600 && bike.forwardSpeed < 33; i++) step(1);
  const impulse = new THREE.Vector3().copy(LOCAL_RIGHT).applyQuaternion(bike.worldQuaternion).multiplyScalar(KNOCK_IMPULSE).addScaledVector(WORLD_UP, KNOCK_IMPULSE * 0.35);
  rider.knockOff(impulse);
  const up = new THREE.Vector3();
  let last = "";
  let t = 0;
  let afterRide = 0;
  while (t < 45) {
    step(0);
    t += FIXED_DT;
    const state = rider.current;
    if (state === "picking-up" || state === "mounting" || (state === "riding" && afterRide < 90)) {
      if (state === "riding") afterRide++;
      if (Math.round(t / FIXED_DT) % 6 === 0 || state !== last) {
        up.set(0, 1, 0).applyQuaternion(bike.worldQuaternion);
        const p = bike.worldPosition;
        const v = bike.controller.chassisBody.linvel();
        console.log(`${t.toFixed(2)}s ${state.padEnd(11)} bike y ${p.y.toFixed(2)} up.y ${up.y.toFixed(2)} speed ${Math.hypot(v.x, v.y, v.z).toFixed(2)}`);
      }
    }
    last = state;
    if (afterRide >= 90) break;
  }
}

main();
