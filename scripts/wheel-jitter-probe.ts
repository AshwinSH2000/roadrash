/** Headless check that the wheels hold still relative to the body while the render alpha sweeps between physics steps. */
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";

const physics = await PhysicsWorld.create();
const surfaces = new SurfaceRegistry();
const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
surfaces.register(
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 1, 6000).setTranslation(0, -1, 0).setFriction(1.0), ground),
  ROAD_SURFACE,
);
const bike = new Bike(physics, surfaces, new THREE.Scene(), new THREE.Vector3(0, 1, 0));

const worst = [0, 0];
for (let step = 0; step < 600; step++) {
  bike.setInput(1, step > 300 ? 0.3 : 0);
  bike.prePhysicsStep(FIXED_DT);
  physics.step();
  bike.postPhysicsStep();
  if (step < 240) continue;
  // Sweep alpha across the step, as a display that isn't locked to 60 Hz would.
  const local: THREE.Vector3[][] = [[], []];
  for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
    bike.syncRender(alpha, FIXED_DT);
    bike.group.updateMatrixWorld(true);
    for (let w = 0; w < 2; w++) local[w].push(bike.group.worldToLocal(bike.wheelObjects[w].position.clone()));
  }
  for (let w = 0; w < 2; w++) {
    const box = new THREE.Box3().setFromPoints(local[w]);
    worst[w] = Math.max(worst[w], box.getSize(new THREE.Vector3()).length());
  }
}
console.log(`speed ${(bike.forwardSpeed * 3.6).toFixed(0)} km/h`);
console.log(`front wheel moved up to ${(worst[0] * 100).toFixed(1)} cm relative to the body within one step; rear ${(worst[1] * 100).toFixed(1)} cm`);
