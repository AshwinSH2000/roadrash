import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";

/**
 * Verifies manual transmission does what it's supposed to, and — the more
 * important check — that it changes nothing about automatic mode, which
 * every bot and (by default) the player still use. On a flat plate, like
 * `brake-probe.ts`: geometry/track behaviour isn't what's under test here.
 *
 * Run with: npm run sim:manual
 */

// The gear table this file's expectations are written against — kept in
// sync with Transmission.ts by eye (it isn't exported; these are the
// numbers documented in that file's own comment).
const GEAR_TOP_SPEEDS = [8, 14, 20, 27, 33, 40];

function makePlate(): { physics: Promise<PhysicsWorld>; surfaces: SurfaceRegistry; scene: THREE.Scene } {
  const surfaces = new SurfaceRegistry();
  const scene = new THREE.Scene();
  return { physics: PhysicsWorld.create(), surfaces, scene };
}

async function buildBike(): Promise<{ physics: PhysicsWorld; bike: Bike }> {
  const { physics: physicsPromise, surfaces, scene } = makePlate();
  const physics = await physicsPromise;
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(60, 1, 6000).setTranslation(0, -1, 0).setFriction(1.0),
    ground,
  );
  surfaces.register(groundCollider, ROAD_SURFACE);
  const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1, 0));
  return { physics, bike };
}

function step(bike: Bike, physics: PhysicsWorld, throttle: number): void {
  bike.setInput(throttle, 0);
  bike.prePhysicsStep(FIXED_DT);
  physics.step();
  bike.postPhysicsStep();
}

/** Full throttle, spamming shiftUp() every step (cooldown paces the actual shifts) until `targetGear` (1-based) is reached or `maxSeconds` runs out. */
function runUpToGear(bike: Bike, physics: PhysicsWorld, targetGear: number, maxSeconds: number): void {
  const maxSteps = Math.ceil(maxSeconds / FIXED_DT);
  for (let i = 0; i < maxSteps && bike.controller.gear < targetGear; i++) {
    bike.controller.shiftUp();
    step(bike, physics, 1);
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];

  // --- 1. Each gear plateaus at its own top speed, not the bike's overall one ---
  console.log("Gear plateau — full throttle, no further shifts once in gear:\n");
  console.log("gear   expected top speed   speed at 20s   speed at 29s   plateaued?");
  for (let gear = 1; gear <= GEAR_TOP_SPEEDS.length; gear++) {
    const { physics, bike } = await buildBike();
    bike.controller.setTransmissionMode("manual");
    runUpToGear(bike, physics, gear, gear * 0.5 + 1);

    let speedAt20 = 0;
    for (let i = 0; i < 60 * 29; i++) {
      step(bike, physics, 1);
      if (i === 60 * 20) speedAt20 = bike.forwardSpeed;
    }
    const speedAt29 = bike.forwardSpeed;
    const expected = GEAR_TOP_SPEEDS[gear - 1];
    // "Plateaued" = essentially stopped climbing, and didn't creep past this
    // gear's own ceiling toward the bike's overall ~40 m/s.
    const stillClimbing = speedAt29 - speedAt20 > 0.3;
    const overshootsGear = speedAt29 > expected + 1.5;
    const ok = !stillClimbing && !overshootsGear;
    console.log(
      `${gear.toString().padStart(4)}   ${expected.toString().padStart(6)} m/s (${(expected * 3.6).toFixed(0)} km/h)      ` +
        `${speedAt20.toFixed(1).padStart(5)} m/s      ${speedAt29.toFixed(1).padStart(5)} m/s      ${ok ? "yes" : "NO"}`,
    );
    if (!ok) {
      failures.push(
        `Gear ${gear} did not plateau near ${expected} m/s (20s: ${speedAt20.toFixed(1)}, 29s: ${speedAt29.toFixed(1)}).`,
      );
    }
  }

  // --- 2. Shifting up unlocks further acceleration -------------------------
  {
    const { physics, bike } = await buildBike();
    bike.controller.setTransmissionMode("manual");
    runUpToGear(bike, physics, 3, 3);
    for (let i = 0; i < 60 * 15; i++) step(bike, physics, 1); // let gear 3 plateau
    const plateauSpeed = bike.forwardSpeed;
    bike.controller.shiftUp();
    for (let i = 0; i < 60 * 8; i++) step(bike, physics, 1);
    const afterShiftSpeed = bike.forwardSpeed;
    const resumed = afterShiftSpeed > plateauSpeed + 1.0;
    console.log(
      `\nShift-up unlocks more speed: gear 3 plateau ${plateauSpeed.toFixed(1)} m/s -> ` +
        `after shifting to 4, ${afterShiftSpeed.toFixed(1)} m/s (${resumed ? "resumed accelerating" : "DID NOT RESUME"})`,
    );
    if (!resumed) failures.push("Shifting up out of a plateaued gear did not let the bike accelerate further.");
  }

  // --- 3. A badly mismatched downshift fights back, not helps --------------
  {
    const { physics, bike } = await buildBike();
    bike.controller.setTransmissionMode("manual");
    runUpToGear(bike, physics, 6, 6);
    for (let i = 0; i < 60 * 15; i++) step(bike, physics, 1); // build real speed in top gear
    const beforeDownshift = bike.forwardSpeed;
    for (let i = 0; i < 60 * 3; i++) {
      bike.controller.shiftDown();
      step(bike, physics, 1);
    }
    const gearAfter = bike.controller.gear;
    // Keep holding throttle through the mismatch, as a panicked downshift would.
    for (let i = 0; i < 60 * 2; i++) step(bike, physics, 1);
    const afterOverRev = bike.forwardSpeed;
    const foughtBack = afterOverRev < beforeDownshift - 3;
    console.log(
      `\nOver-rev on a too-low downshift: ${beforeDownshift.toFixed(1)} m/s in 6th -> shifted down to gear ` +
        `${gearAfter} -> ${afterOverRev.toFixed(1)} m/s (${foughtBack ? "engine braking, correctly" : "DID NOT SLOW DOWN"})`,
    );
    if (gearAfter !== 1) failures.push(`Expected 3s of downshifting to reach gear 1, got gear ${gearAfter}.`);
    if (!foughtBack) failures.push("A badly mismatched downshift did not produce engine braking.");
  }

  // --- 4. Automatic mode is a true no-op path for manual calls --------------
  {
    const { physics: physicsA, bike: bikeA } = await buildBike(); // untouched baseline
    const { physics: physicsB, bike: bikeB } = await buildBike(); // same throttle, but spammed with manual calls
    const gearsA: number[] = [];
    const gearsB: number[] = [];
    for (let i = 0; i < 60 * 25; i++) {
      step(bikeA, physicsA, 1);
      bikeB.controller.shiftUp();
      bikeB.controller.shiftDown();
      step(bikeB, physicsB, 1);
      gearsA.push(bikeA.controller.gear);
      gearsB.push(bikeB.controller.gear);
    }
    const identical = gearsA.every((g, i) => g === gearsB[i]);
    const speedIdentical = Math.abs(bikeA.forwardSpeed - bikeB.forwardSpeed) < 1e-6;
    console.log(
      `\nAutomatic mode ignores shiftUp()/shiftDown(): gear sequence ${identical ? "identical" : "DIVERGED"}, ` +
        `final speed ${speedIdentical ? "identical" : "DIVERGED"} (${bikeA.forwardSpeed.toFixed(4)} vs ${bikeB.forwardSpeed.toFixed(4)} m/s).`,
    );
    if (!identical) failures.push("Calling shiftUp()/shiftDown() in automatic mode changed the automatic gear sequence.");
    if (!speedIdentical) failures.push("Calling shiftUp()/shiftDown() in automatic mode changed automatic drive force.");
  }

  // --- 5. Launches cleanly from an exact standstill (not just near-zero) ---
  // rpmRatio is exactly 0 at exactly 0 speed — a real scenario (the grid,
  // or switching into manual while stopped), not just a theoretical one.
  {
    const { physics, bike } = await buildBike();
    bike.controller.setTransmissionMode("manual");
    bike.controller.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    for (let i = 0; i < 60 * 3; i++) step(bike, physics, 1);
    const launched = bike.forwardSpeed > 1.0;
    console.log(`\nLaunch from an exact standstill: ${bike.forwardSpeed.toFixed(2)} m/s after 3 s (${launched ? "launched" : "STUCK"})`);
    if (!launched) failures.push("A manual-mode bike did not launch from an exact standing start.");
  }

  console.log("");
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log("PASS  manual transmission behaves as specified, automatic mode is untouched.");
}
void main();
