import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { Nitro, NitroState, NITRO_DRAIN_SECONDS, NITRO_RECHARGE_SECONDS } from "../src/entities/Nitro";
import { FIXED_DT } from "../src/core/Clock";

/**
 * Checks the nitro boost against its spec, headlessly.
 *
 *  1. Physics: from flat-out top speed, firing nitro must gain about 20 km/h,
 *     and get most of the way there well inside the 5 s it lasts.
 *  2. Timing: full -> fires -> empty after 5 s -> full again 20 s later.
 *  3. Rules: N does nothing until full; braking mid-boost neither stops the
 *     drain nor keeps the boost.
 *
 * Run with: npm run sim:nitro
 */
async function makeBike(): Promise<{ bike: Bike; physics: PhysicsWorld }> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  surfaces.register(
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 1, 6000).setTranslation(0, -1, 0).setFriction(1.0), ground),
    ROAD_SURFACE,
  );
  return { bike: new Bike(physics, surfaces, new THREE.Scene(), new THREE.Vector3(0, 1, 0)), physics };
}

function stepFor(bike: Bike, physics: PhysicsWorld, seconds: number, throttle: number, boost: boolean, onStep?: (t: number) => void): void {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) {
    bike.controller.setBoost(boost);
    bike.setInput(throttle, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
    onStep?.((i + 1) * FIXED_DT);
  }
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const kmh = (v: number): string => (v * 3.6).toFixed(1);

  // --- 1. physics ---
  {
    const { bike, physics } = await makeBike();
    stepFor(bike, physics, 40, 1, false);
    const base = bike.forwardSpeed;
    let peak = base;
    let timeToPlus15 = Infinity;
    let timeToPlus18 = Infinity;
    stepFor(bike, physics, NITRO_DRAIN_SECONDS, 1, true, (t) => {
      const v = bike.forwardSpeed;
      peak = Math.max(peak, v);
      if (v - base >= 15 / 3.6 && timeToPlus15 === Infinity) timeToPlus15 = t;
      if (v - base >= 18 / 3.6 && timeToPlus18 === Infinity) timeToPlus18 = t;
    });
    const boosted = bike.forwardSpeed;
    stepFor(bike, physics, 8, 1, false);
    const after = bike.forwardSpeed;

    console.log(`flat-out top speed        ${kmh(base)} km/h`);
    console.log(`after 5 s of nitro        ${kmh(boosted)} km/h  (+${kmh(boosted - base)}), peak ${kmh(peak)}`);
    console.log(`+15 km/h reached at       ${Number.isFinite(timeToPlus15) ? timeToPlus15.toFixed(1) + " s" : "never"}`);
    console.log(`+18 km/h reached at       ${Number.isFinite(timeToPlus18) ? timeToPlus18.toFixed(1) + " s" : "never"}`);
    console.log(`8 s after it ends         ${kmh(after)} km/h  (back toward ${kmh(base)})`);

    const gain = (boosted - base) * 3.6;
    if (gain < 17 || gain > 24) problems.push(`Nitro gained ${gain.toFixed(1)} km/h at top speed; want about 20.`);
    if (timeToPlus15 > 3.5) problems.push(`Took ${timeToPlus15.toFixed(1)} s to gain 15 km/h; the boost should be felt well inside its 5 s.`);
    if (after - base > 3 / 3.6) problems.push(`Speed ${kmh(after)} km/h stayed high after the boost ended.`);

    // From a slow roll: the kick should be obvious.
    const slow = await makeBike();
    stepFor(slow.bike, slow.physics, 6, 1, false);
    const s0 = slow.bike.forwardSpeed;
    const plain = await makeBike();
    stepFor(plain.bike, plain.physics, 6, 1, false);
    stepFor(slow.bike, slow.physics, 2, 1, true);
    stepFor(plain.bike, plain.physics, 2, 1, false);
    console.log(`\nfrom ${kmh(s0)} km/h, 2 s later:   plain ${kmh(plain.bike.forwardSpeed)} km/h   nitro ${kmh(slow.bike.forwardSpeed)} km/h`);
    if (slow.bike.forwardSpeed - plain.bike.forwardSpeed < 8 / 3.6) {
      problems.push("Nitro from a slow roll barely out-accelerates no nitro; the force multiplier is too low to feel.");
    }
  }

  // --- 2 & 3. timing and rules ---
  {
    const nitro = new Nitro();
    const step = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) nitro.tick(FIXED_DT);
    };
    const line: string[] = [];
    if (!nitro.isReady) problems.push("Nitro should start full and ready.");
    line.push(`start: ${nitro.current} ${(nitro.charge * 100).toFixed(0)}%`);

    if (!nitro.tryActivate()) problems.push("A full bar refused to fire.");
    step(2.5);
    line.push(`2.5 s: ${nitro.current} ${(nitro.charge * 100).toFixed(0)}%`);
    if (nitro.current !== NitroState.ACTIVE || Math.abs(nitro.charge - 0.5) > 0.02) problems.push(`Half way through the drain the bar reads ${(nitro.charge * 100).toFixed(0)}%, want 50%.`);
    // "Brake" here is a no-op to the bar by design; pressing N again must do nothing.
    if (nitro.tryActivate()) problems.push("N fired again mid-boost.");
    step(2.5 + FIXED_DT);
    line.push(`5.0 s: ${nitro.current} ${(nitro.charge * 100).toFixed(0)}%`);
    if (nitro.current !== NitroState.RECHARGING || nitro.charge !== 0) problems.push(`After ${NITRO_DRAIN_SECONDS} s the bar should be empty and recharging; it is ${nitro.current} at ${(nitro.charge * 100).toFixed(0)}%.`);
    step(10);
    line.push(`15 s: ${nitro.current} ${(nitro.charge * 100).toFixed(0)}%`);
    if (nitro.tryActivate()) problems.push("N fired on a half-full bar.");
    if (Math.abs(nitro.charge - 0.5) > 0.02) problems.push(`Half way through the recharge the bar reads ${(nitro.charge * 100).toFixed(0)}%, want 50%.`);
    step(10 + FIXED_DT);
    line.push(`25 s: ${nitro.current} ${(nitro.charge * 100).toFixed(0)}%`);
    if (!nitro.isReady) problems.push(`Bar should be full ${NITRO_RECHARGE_SECONDS} s after emptying; it is ${nitro.current} at ${(nitro.charge * 100).toFixed(0)}%.`);
    if (!nitro.tryActivate()) problems.push("A refilled bar refused to fire.");
    console.log(`\nbar timeline:  ${line.join("  ->  ")}`);

    // Braking mid-boost: the bar keeps draining, and the bike is not pushed.
    const { bike, physics } = await makeBike();
    stepFor(bike, physics, 30, 1, false);
    const before = bike.forwardSpeed;
    const n2 = new Nitro();
    n2.tryActivate();
    let t = 0;
    while (n2.isActive) {
      n2.tick(FIXED_DT);
      bike.controller.setBoost(n2.isActive);
      bike.setInput(-1, 0); // brake held the whole time
      bike.prePhysicsStep(FIXED_DT);
      physics.step();
      bike.postPhysicsStep();
      t += FIXED_DT;
    }
    console.log(`braking through a boost:  bar emptied after ${t.toFixed(1)} s, speed ${kmh(before)} -> ${kmh(bike.forwardSpeed)} km/h`);
    if (Math.abs(t - NITRO_DRAIN_SECONDS) > 0.1) problems.push(`Braking changed the drain time to ${t.toFixed(1)} s.`);
    if (bike.forwardSpeed > before * 0.5) problems.push("Braking with nitro active did not slow the bike — the boost overrode the brake.");
  }

  if (problems.length) {
    console.log(`\nFAIL`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\nPASS  nitro matches the spec.`);
}
void main();
