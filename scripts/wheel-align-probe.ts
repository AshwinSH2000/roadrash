import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD } from "../src/utils/Directions";

/**
 * Are the drawn wheels where the bike says they are? For a bike at several
 * speeds, compares each wheel's drawn position with where the wheel should be
 * if it is fixed to the bike's own drawn body, measured along the bike's
 * forward axis. Zero means aligned; anything else is the wheels sitting ahead
 * of or behind the frame.
 */
async function measure(kph: number): Promise<string> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  surfaces.register(
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 1, 2000).setTranslation(0, -1, 0).setFriction(1.0), ground),
    ROAD_SURFACE,
  );
  const scene = new THREE.Scene();
  const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1, -1500));
  const any = bike as any;
  for (let i = 0; i < 60 * 40 && bike.forwardSpeed * 3.6 < kph; i++) {
    bike.setInput(1, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  }
  // Hold the speed steady while measuring.
  const results: number[][] = [[], []];
  for (let i = 0; i < 120; i++) {
    bike.setInput(bike.forwardSpeed * 3.6 < kph ? 1 : 0.3, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
    for (const alpha of [0, 0.5, 1]) {
      bike.syncRender(alpha, FIXED_DT);
      const group: THREE.Group = any.group;
      group.updateMatrixWorld(true);
      const forward = LOCAL_FORWARD.clone().applyQuaternion(group.quaternion);
      for (let w = 0; w < 2; w++) {
        const wheel: THREE.Object3D = any.wheelObjects[w];
        // Where this wheel should be on the drawn body: its mount point on the chassis, in the group's frame.
        const expected = group.localToWorld(new THREE.Vector3(0, 0, w === 0 ? 0.7 : -0.7));
        const delta = wheel.position.clone().sub(expected);
        results[w].push(delta.dot(forward));
      }
    }
  }
  const stat = (a: number[]): string => `${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)} m (range ${Math.min(...a).toFixed(2)}..${Math.max(...a).toFixed(2)})`;
  return `  ${String(kph).padStart(3)} km/h (${(kph / 3.6 * FIXED_DT).toFixed(2)} m per physics step): front wheel ${stat(results[0])}   rear wheel ${stat(results[1])}`;
}

console.log("wheel position along the bike's forward axis, relative to its mount on the body (0 = aligned)");
for (const kph of [0, 30, 60, 100, 130]) console.log(await measure(kph));

{
  // Ride height at a standstill: how far the springs sag under the bike's weight.
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  surfaces.register(
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(1.0), ground),
    ROAD_SURFACE,
  );
  const bike = new Bike(physics, surfaces, new THREE.Scene(), new THREE.Vector3(0, 1.2, 0));
  for (let i = 0; i < 60 * 4; i++) {
    bike.setInput(0, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  }
  const c = bike.controller;
  console.log(
    `standing still: suspension ${c.wheelSuspensionLength(0).toFixed(3)} m front / ${c.wheelSuspensionLength(1).toFixed(3)} m rear (rest length 0.45), chassis centre ${bike.worldPosition.y.toFixed(3)} m above the road`,
  );
}
