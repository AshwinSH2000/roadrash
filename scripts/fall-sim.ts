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
 * Run with: npm run sim:falls
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

async function runOne(targetSpeed: number): Promise<Result> {
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

  const step = (throttle: number, steer: number): void => {
    rider.tick(FIXED_DT);
    if (rider.isRiding) bike.setInput(throttle, steer);
    else bike.setInput(0, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  };

  // Accelerate to the test speed on the opening straight.
  for (let i = 0; i < 60 * 60 && bike.forwardSpeed < targetSpeed; i++) step(1, 0);
  const speedKph = Math.abs(bike.forwardSpeed) * 3.6;

  const knockPoint = bike.worldPosition.clone();
  const impulse = new THREE.Vector3()
    .copy(LOCAL_RIGHT)
    .applyQuaternion(bike.worldQuaternion)
    .multiplyScalar(KNOCK_IMPULSE)
    .addScaledVector(WORLD_UP, KNOCK_IMPULSE * 0.35);
  rider.knockOff(impulse);

  let elapsed = 0;
  let settleSeconds = 0;
  let peakBodies = 0;
  let tumbleDistance = 0;
  let standUpPoint: THREE.Vector3 | null = null;
  let runDistance = 0;
  let completed = false;
  let diagStep = 0;

  while (elapsed < RECOVERY_TIMEOUT) {
    step(0, 0);
    elapsed += FIXED_DT;
    peakBodies = Math.max(peakBodies, rider.ragdollBodyCount);

    if (rider.current === RiderState.RAGDOLL) {
      tumbleDistance = rider.cameraPosition.distanceTo(knockPoint);
      settleSeconds = elapsed;
      diagStep++;
      if (process.env.DIAG && diagStep % 30 === 0) {
        const p = rider.ragdollPeakSpeeds;
        console.log(`    [diag] t=${elapsed.toFixed(1)}s  maxLin=${p.linear.toFixed(2)} m/s  maxAng=${p.angular.toFixed(2)} rad/s`);
      }
    } else if (standUpPoint === null && rider.current === RiderState.GETTING_UP) {
      standUpPoint = rider.cameraPosition.clone();
    }

    if (rider.current === RiderState.RIDING) {
      if (standUpPoint) runDistance = standUpPoint.distanceTo(bike.worldPosition);
      completed = true;
      break;
    }
  }

  return {
    speedKph,
    tumbleDistance,
    settleSeconds,
    recoverSeconds: elapsed,
    runDistance,
    completed,
    peakBodies,
    bodiesAfter: rider.ragdollBodyCount,
  };
}

async function main(): Promise<void> {
  console.log("Knockdown and recovery, on the open road, at a range of speeds.\n");
  console.log("speed     tumble    settle    run to bike   total recovery   bodies (peak/after)");

  const results: Result[] = [];
  for (const kph of [30, 60, 90, 120, 131]) {
    const r = await runOne(kph / 3.6);
    results.push(r);
    console.log(
      `${r.speedKph.toFixed(0).padStart(3)} km/h  ` +
        `${r.tumbleDistance.toFixed(1).padStart(6)} m  ` +
        `${r.settleSeconds.toFixed(1).padStart(6)} s  ` +
        `${r.runDistance.toFixed(1).padStart(9)} m  ` +
        `${(r.completed ? `${r.recoverSeconds.toFixed(1)} s` : "DID NOT RECOVER").padStart(14)}   ` +
        `${r.peakBodies}/${r.bodiesAfter}`,
    );
  }

  const failures: string[] = [];

  const stalled = results.filter((r) => !r.completed);
  if (stalled.length > 0) {
    failures.push(
      `${stalled.length} rider(s) never got back on: ` +
        stalled.map((r) => `${r.speedKph.toFixed(0)} km/h`).join(", "),
    );
  }

  const leaked = results.filter((r) => r.bodiesAfter !== 0);
  if (leaked.length > 0) failures.push(`Ragdoll bodies leaked after teardown in ${leaked.length} run(s).`);

  const noBodies = results.filter((r) => r.peakBodies === 0);
  if (noBodies.length > 0) failures.push(`Ragdoll never spawned in ${noBodies.length} run(s).`);

  // The headline requirement: a fast fall must throw you visibly further.
  const slow = results[0];
  const fast = results[results.length - 1];
  const ratio = slow.tumbleDistance > 0.01 ? fast.tumbleDistance / slow.tumbleDistance : 0;
  console.log(
    `\ntumble at ${fast.speedKph.toFixed(0)} km/h vs ${slow.speedKph.toFixed(0)} km/h: ` +
      `${ratio.toFixed(1)}x further (want > 2x — speed must visibly matter)`,
  );
  if (ratio <= 2) {
    failures.push(`Fast falls only travel ${ratio.toFixed(1)}x as far as slow ones; speed isn't mattering enough.`);
  }

  console.log("");
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log("PASS  knockdown and recovery works at every speed tested.");
}
void main();
