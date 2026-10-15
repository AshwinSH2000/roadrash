/** Headless check that the rider's hands follow the turning handlebar. */
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { RiderModel } from "../src/entities/RiderModel";
import { createPlaceholderBikeVisuals } from "../src/entities/BikeVisuals";
import { FIXED_DT } from "../src/core/Clock";

const physics = await PhysicsWorld.create();
const surfaces = new SurfaceRegistry();
const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
surfaces.register(
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 1, 6000).setTranslation(0, -1, 0).setFriction(1.0), ground),
  ROAD_SURFACE,
);

// Placeholder visuals plus a steering assembly pivoting at the front hub, raked 27 degrees.
const factory = (color: number) => {
  const visuals = createPlaceholderBikeVisuals(color);
  const object = new THREE.Group();
  object.position.set(0, 0.35, 0.7);
  visuals.body.add(object);
  visuals.frontAssembly = { object, axis: new THREE.Vector3(0, Math.cos(0.47), -Math.sin(0.47)).normalize() };
  return visuals;
};
const bike = new Bike(physics, surfaces, new THREE.Scene(), new THREE.Vector3(0, 1, 0), new THREE.Quaternion(), 0xd23030, factory);
const rider = new RiderModel(0xd23030);
bike.addRiderObject(rider.object);
bike.attachRiderHands(rider);

const hands = () => {
  const p = rider.jointPositions();
  return `L ${p["armL.end"].toArray().map((v) => v.toFixed(3)).join(",")}  R ${p["armR.end"].toArray().map((v) => v.toFixed(3)).join(",")}`;
};
const run = (steer: number, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    bike.setInput(0.3, steer);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  }
  bike.syncRender(1, FIXED_DT);
};
run(0, 0.5);
console.log("straight    ", hands());
run(1, 0.5);
console.log("steer right ", hands(), "steerAngle", bike.controller.steerAngle.toFixed(3));
run(-1, 0.8);
console.log("steer left  ", hands(), "steerAngle", bike.controller.steerAngle.toFixed(3));
