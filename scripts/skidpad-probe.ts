import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";

/**
 * Measures the cornering acceleration the bike ACTUALLY achieves at various
 * speeds, against the `maxLateralAccel` the steering model assumes it can
 * ask for.
 *
 * This is the single most load-bearing number in the whole vehicle: it sets
 * the minimum corner radius, which sets the track layout, which sets where
 * the AI brakes. If the steering commands more cornering than the tyres can
 * deliver, every rider understeers off the outside of every fast corner and
 * no amount of AI tuning fixes it.
 *
 * Run with: npm run sim:skidpad
 */
async function measure(
  targetSpeed: number,
  knobs: { commandedAccel: number; gripMultiplier: number },
): Promise<{ achieved: number; speed: number; heldSpeed: boolean }> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const scene = new THREE.Scene();

  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(4000, 1, 4000).setTranslation(0, -1, 0).setFriction(1.0),
    ground,
  );
  surfaces.register(groundCollider, ROAD_SURFACE);

  const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1, 0));
  const cfg = bike.controller.tuning;

  // `tuning` hands back the shared DEFAULT_VEHICLE_CONFIG object, so anything
  // set here leaks into every later measurement unless it is put back.
  const original = { maxLateralAccel: cfg.maxLateralAccel, gripMultiplier: cfg.gripMultiplier };
  cfg.maxLateralAccel = knobs.commandedAccel;
  cfg.gripMultiplier = knobs.gripMultiplier;

  try {
    // Straight-line run up to speed.
    let reached = false;
    for (let i = 0; i < 60 * 90; i++) {
      bike.setInput(bike.forwardSpeed < targetSpeed ? 1 : 0, 0);
      bike.prePhysicsStep(FIXED_DT);
      physics.step();
      bike.postPhysicsStep();
      if (bike.forwardSpeed >= targetSpeed) {
        reached = true;
        break;
      }
    }

    // Then hold speed and full lock, and let the turn settle before sampling.
    let sum = 0;
    let samples = 0;
    for (let i = 0; i < 60 * 8; i++) {
      bike.setInput(bike.forwardSpeed < targetSpeed ? 1 : 0, 1);
      bike.prePhysicsStep(FIXED_DT);
      physics.step();
      bike.postPhysicsStep();
      if (i > 60 * 6) {
        sum += Math.abs(bike.controller.lateralAcceleration);
        samples++;
      }
    }

    const speed = Math.abs(bike.forwardSpeed);
    return {
      achieved: samples > 0 ? sum / samples : 0,
      speed,
      // If the bike couldn't hold the target speed through the turn, it was
      // scrubbing off speed sliding, and the reading isn't a steady state.
      heldSpeed: reached && speed > targetSpeed * 0.85,
    };
  } finally {
    cfg.maxLateralAccel = original.maxLateralAccel;
    cfg.gripMultiplier = original.gripMultiplier;
  }
}

async function main(): Promise<void> {
  const TEST_SPEED = 110 / 3.6;
  console.log(`Steady-state cornering at ${(TEST_SPEED * 3.6).toFixed(0)} km/h, full lock.\n`);
  console.log("A row DELIVERS its commanded figure only if 'achieved' matches it and the");
  console.log("bike held its speed; otherwise the tyres are the limit, not the steering.\n");
  console.log("grip   commanded   achieved   delivered?   min radius at 131 km/h");

  for (const grip of [1.0, 1.5, 2.0, 2.5]) {
    for (const commanded of [11, 14, 17, 20]) {
      const r = await measure(TEST_SPEED, { commandedAccel: commanded, gripMultiplier: grip });
      const delivered = r.heldSpeed && r.achieved >= commanded * 0.9;
      const minRadius = r.achieved > 0.01 ? (36.4 * 36.4) / r.achieved : Infinity;
      console.log(
        `${grip.toFixed(1).padStart(4)}   ${commanded.toFixed(0).padStart(9)}   ` +
          `${r.achieved.toFixed(1).padStart(8)}   ${(delivered ? "yes" : "no").padStart(10)}   ` +
          `${(Number.isFinite(minRadius) ? minRadius.toFixed(0) : "inf").padStart(10)} m`,
      );
    }
  }
  console.log("\nThe track's fastest sweepers are 140-192 m radius; the tight corners 49-54 m.");
}
void main();
