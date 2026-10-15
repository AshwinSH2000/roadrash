/** Headless check that elbows and knees only bend the way they should while a ragdoll tumbles. */
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { RagdollController } from "../src/physics/RagdollController";
import { FIXED_DT } from "../src/core/Clock";

const speeds = [8, 20, 36];
let worst = new Map<string, { min: number; max: number }>();
for (const speed of speeds) {
  const physics = await PhysicsWorld.create();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(1), ground);
  const ragdoll = new RagdollController(physics, new THREE.Scene(), 0x2266dd);
  ragdoll.spawn(new THREE.Vector3(0, 1, 0), new THREE.Quaternion(), new THREE.Vector3(0, 0, speed), new THREE.Vector3(250, 100, 0));
  let settled = 0;
  const rest = { linear: 0, angular: 0 };
  for (let i = 0; i < 600; i++) {
    physics.step();
    if (settled === 0 && ragdoll.tick(FIXED_DT)) settled = (i + 1) * FIXED_DT;
    if (i >= 420) {
      // Long after it should have come to rest: whatever speed is left is jitter.
      const peak = ragdoll.peakSpeeds;
      rest.linear = Math.max(rest.linear, peak.linear);
      rest.angular = Math.max(rest.angular, peak.angular);
    }
    for (const { name, angle } of ragdoll.hingeAngles) {
      const w = worst.get(name) ?? { min: Infinity, max: -Infinity };
      w.min = Math.min(w.min, angle);
      w.max = Math.max(w.max, angle);
      worst.set(name, w);
    }
  }
  console.log(`${String(speed).padStart(3)} m/s  settled after ${settled ? settled.toFixed(2) + " s" : "NEVER"}; residual after 7 s: ${rest.linear.toFixed(3)} m/s, ${rest.angular.toFixed(3)} rad/s`);
}
for (const [name, w] of worst) console.log(name.padEnd(14), `angle ${w.min.toFixed(2)} .. ${w.max.toFixed(2)}`);
