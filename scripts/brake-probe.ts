import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";

/**
 * Measures how hard the bike can actually stop, for a range of `brakeForce`
 * values. The AI plans its braking points from an assumed deceleration; if
 * the real figure is lower than that, every bot arrives at every corner too
 * fast, which is indistinguishable from "the AI can't drive".
 *
 * Runs on a flat plate rather than the real track deliberately — on the
 * course a bike held straight simply leaves the road at the first corner and
 * the numbers become meaningless.
 *
 * Run with: npm run sim:brake
 */
async function measure(
  brakeForce: number,
  throttleInput = -1,
): Promise<{ topSpeed: number; decel: number; distance: number }> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const scene = new THREE.Scene();

  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(60, 1, 6000).setTranslation(0, -1, 0).setFriction(1.0),
    ground,
  );
  surfaces.register(groundCollider, ROAD_SURFACE);

  const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1, 0));
  bike.controller.tuning.brakeForce = brakeForce;

  for (let i = 0; i < 60 * 40; i++) {
    bike.setInput(1, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  }

  const startSpeed = bike.forwardSpeed;
  const startPos = bike.worldPosition.clone();
  const target = startSpeed * 0.5;
  let steps = 0;
  while (bike.forwardSpeed > target && steps < 60 * 60) {
    bike.setInput(throttleInput, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
    steps++;
  }

  const seconds = steps * FIXED_DT;
  return {
    topSpeed: startSpeed,
    decel: seconds > 0 ? (startSpeed - bike.forwardSpeed) / seconds : 0,
    distance: bike.worldPosition.distanceTo(startPos),
  };
}

async function main(): Promise<void> {
  console.log("brakeForce   top speed    decel          distance to halve speed");
  for (const force of [5, 10, 15, 20, 30, 60, 200]) {
    const r = await measure(force);
    console.log(
      `${force.toString().padStart(9)}   ${(r.topSpeed * 3.6).toFixed(0).padStart(3)} km/h    ` +
        `${r.decel.toFixed(2).padStart(5)} m/s^2    ${r.distance.toFixed(0).padStart(5)} m`,
    );
  }

  // What the player feels when they simply lift off — the thing that decides
  // whether braking is mandatory for every corner or only the tight ones.
  const coast = await measure(0, 0);
  console.log(
    `\ncoasting (throttle released, engine braking only): ` +
      `${coast.decel.toFixed(2)} m/s^2 over ${coast.distance.toFixed(0)} m`,
  );

  console.log("\nThe AI plans braking at PLANNED_BRAKE_DECEL in OpponentAI.ts;");
  console.log("that must sit safely below whatever the chosen brakeForce actually delivers.");
}
void main();
