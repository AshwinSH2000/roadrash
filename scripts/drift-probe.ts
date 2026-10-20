import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD } from "../src/utils/Directions";

/**
 * Brake plus a direction, at speed: does the bike drift, turn toward that
 * side, slide to a stop, and stay upright? Also checks that braking with a
 * driver that never asked for a drift (a bot) does not drift.
 *
 * Run with: npm run sim:drift
 */
async function run(kph: number, steer: number, allowed = true, hold = 6): Promise<string> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const scene = new THREE.Scene();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  surfaces.register(
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(400, 1, 400).setTranslation(0, -1, 0).setFriction(1.0), ground),
    ROAD_SURFACE,
  );
  const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1, -300));
  const c = bike.controller;
  const heading = () => {
    const f = LOCAL_FORWARD.clone().applyQuaternion(bike.worldQuaternion);
    return (Math.atan2(f.x, f.z) * 180) / Math.PI;
  };
  const stepOnce = (thr: number, st: number) => {
    bike.setInput(thr, st);
    c.setDriftAllowed(allowed);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  };
  for (let i = 0; i < 60 * 30 && bike.forwardSpeed < kph / 3.6; i++) stepOnce(1, 0);
  const startKph = bike.forwardSpeed * 3.6;
  const start = bike.worldPosition.clone();
  const h0 = heading();
  let peakSlip = 0, driftSteps = 0, peakRoll = 0, stopT = -1;
  for (let i = 0; i < 60 * hold; i++) {
    stepOnce(-1, steer);
    if (c.isDrifting) driftSteps++;
    peakSlip = Math.max(peakSlip, Math.abs(c.slipAngle));
    const v = c.chassisBody.linvel();
    if (stopT < 0 && Math.hypot(v.x, v.z) < 0.5) stopT = i * FIXED_DT;
  }
  const turned = ((heading() - h0 + 540) % 360) - 180;
  const d = bike.worldPosition.clone().sub(start);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(bike.worldQuaternion).y;
  return (
    `  ${startKph.toFixed(0)} km/h, steer ${steer > 0 ? "right" : "left "}${allowed ? "" : " (bot)"}: drift ${(driftSteps * FIXED_DT).toFixed(1)} s, ` +
    `peak slip ${((peakSlip * 180) / Math.PI).toFixed(0)} deg, nose turned ${turned.toFixed(0)} deg, ` +
    `slid ${Math.hypot(d.x, d.z).toFixed(0)} m, stopped ${stopT < 0 ? "no" : "at " + stopT.toFixed(1) + " s"}, up ${up.toFixed(2)}`
  );
}

console.log("DRIFT — full brake then a direction:");
for (const kph of [50, 90, 130]) {
  console.log(await run(kph, 1));
  console.log(await run(kph, -1));
}
console.log("a bot braking and steering must not drift:");
console.log(await run(90, 1, false));
console.log("too slow to drift (under 9 m/s):");
console.log(await run(25, 1));

console.log("REVERSE — stopped, hold the brake:");
{
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  surfaces.register(
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(400, 1, 400).setTranslation(0, -1, 0).setFriction(1.0), ground),
    ROAD_SURFACE,
  );
  const bike = new Bike(physics, surfaces, new THREE.Scene(), new THREE.Vector3(0, 1, 0));
  const c = bike.controller;
  const stepOnce = (thr: number) => { bike.setInput(thr, 0); bike.prePhysicsStep(FIXED_DT); physics.step(); bike.postPhysicsStep(); };
  for (let i = 0; i < 60; i++) stepOnce(0);
  let first = -1, peak = 0;
  for (let i = 0; i < 60 * 6; i++) {
    stepOnce(-1);
    const kph = -bike.forwardSpeed * 3.6;
    peak = Math.max(peak, kph);
    if (first < 0 && kph > 0.5) first = i * FIXED_DT;
  }
  console.log(`  held S from rest: starts moving back after ${first.toFixed(2)} s, peak ${peak.toFixed(2)} km/h, moved back ${(-bike.worldPosition.z).toFixed(1) } m (z)`);
  // stationary flag
  for (let i = 0; i < 30; i++) stepOnce(0);
  for (let i = 0; i < 90; i++) stepOnce(0);
  console.log(`  released: stationary ${c.stationary}, reversing ${c.reversing}`);
  // braking to a stop from speed must not roll straight into reverse
  const b2 = new Bike(physics, surfaces, new THREE.Scene(), new THREE.Vector3(50, 1, -300));
  const s2 = (thr: number) => { b2.setInput(thr, 0); b2.prePhysicsStep(FIXED_DT); physics.step(); b2.postPhysicsStep(); };
  for (let i = 0; i < 60 * 8; i++) s2(1);
  let minSpeed = 99, stopped = -1;
  for (let i = 0; i < 60 * 6; i++) { s2(-1); minSpeed = Math.min(minSpeed, b2.forwardSpeed); if (stopped < 0 && b2.forwardSpeed < 0.1) stopped = i * FIXED_DT; }
  console.log(`  braked from ${"speed"} to a stop at ${stopped.toFixed(1)} s then held S: slowest ${(minSpeed * 3.6).toFixed(2)} km/h`);
}
