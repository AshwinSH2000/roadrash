import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE, OFFROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD, LOCAL_RIGHT } from "../src/utils/Directions";

/**
 * Reproduces the spin the telemetry caught: cornering near the lateral limit
 * at ~100 km/h, coasting, then opening the throttle. Yaw rate ran from 0.5 to
 * 4 rad/s in 0.4 s with the steer at 1.7 degrees — the rear let go and
 * nothing brought it back. Also tried on grass, where it happened with the
 * steer released.
 *
 * Run with: npm run sim:oversteer
 */
async function scenario(
  surfaceName: "road" | "offroad",
  kmh: number,
  throttleAt: number,
  /** Road grade along +Z as a fraction; +0.08 is an 8% climb in the direction of travel. */
  grade = 0,
): Promise<{ peakYaw: number; peakSlip: number; spun: boolean; log: string[] }> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  // A huge box tilted about X so the road rises along +Z; the bike is spawned
  // well up the slope and drives "uphill" for a positive grade.
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.atan(grade));
  surfaces.register(
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(6000, 1, 6000).setTranslation(0, -1, 0).setRotation({ x: tilt.x, y: tilt.y, z: tilt.z, w: tilt.w }).setFriction(1.0),
      ground,
    ),
    surfaceName === "road" ? ROAD_SURFACE : OFFROAD_SURFACE,
  );
  const bike = new Bike(physics, surfaces, new THREE.Scene(), new THREE.Vector3(0, 1, 0));
  const ctl = bike.controller;

  for (let i = 0; i < 60 * 90 && bike.forwardSpeed < kmh / 3.6; i++) {
    bike.setInput(1, 0); bike.prePhysicsStep(FIXED_DT); physics.step(); bike.postPhysicsStep();
  }
  const q = new THREE.Quaternion(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), vel = new THREE.Vector3();
  let peakYaw = 0, peakSlip = 0, heading = 0, lastYaw: number | null = null;
  const log: string[] = [];
  for (let i = 0; i < 60 * 6; i++) {
    const t = i / 60;
    bike.setInput(t >= throttleAt ? 1 : 0, -1);
    bike.prePhysicsStep(FIXED_DT); physics.step(); bike.postPhysicsStep();
    const r = ctl.chassisBody.rotation(); q.set(r.x, r.y, r.z, r.w);
    fwd.copy(LOCAL_FORWARD).applyQuaternion(q); right.copy(LOCAL_RIGHT).applyQuaternion(q);
    const v = ctl.chassisBody.linvel(); vel.set(v.x, 0, v.z);
    const yaw = Math.atan2(fwd.x, fwd.z);
    if (lastYaw !== null) { let d = yaw - lastYaw; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; heading += d; }
    lastYaw = yaw;
    const slip = vel.length() > 0.5 ? THREE.MathUtils.radToDeg(Math.atan2(vel.dot(right), vel.dot(fwd))) : 0;
    peakYaw = Math.max(peakYaw, Math.abs(ctl.yawRate)); peakSlip = Math.max(peakSlip, Math.abs(slip));
    if (i % 24 === 0) log.push(`${t.toFixed(1).padStart(4)}  ${(vel.length() * 3.6).toFixed(0).padStart(4)} km/h  thr ${t >= throttleAt ? 1 : 0}  steer ${THREE.MathUtils.radToDeg(ctl.steerAngle).toFixed(1).padStart(5)}  latA ${ctl.lateralAcceleration.toFixed(1).padStart(6)}  yaw ${ctl.yawRate.toFixed(2).padStart(6)}  slip ${slip.toFixed(1).padStart(6)}`);
  }
  return { peakYaw, peakSlip, spun: peakSlip > 60, log };
}

async function main(): Promise<void> {
  const cases: [string, "road" | "offroad", number, number, number][] = [
    ["flat road, 100 km/h, coast 1.5 s at the limit then throttle", "road", 100, 1.5, 0],
    ["flat grass, 85 km/h, throttle from the start", "offroad", 85, 0, 0],
    ["8% UPHILL road, 100 km/h, coast 1.5 s at the limit then throttle  (the telemetry case)", "road", 100, 1.5, 0.08],
    ["8% uphill road, 100 km/h, throttle from the start", "road", 100, 0, 0.08],
    ["8% DOWNHILL road, 100 km/h, coast then throttle", "road", 100, 1.5, -0.08],
    ["8% uphill grass, 80 km/h, throttle from the start", "offroad", 80, 0, 0.08],
  ];
  let failed = false;
  for (const [name, surface, kmh, at, grade] of cases) {
    const r = await scenario(surface, kmh, at, grade);
    console.log(`\n--- ${name} ---`);
    for (const l of r.log) console.log(l);
    console.log(`  => peak yaw ${r.peakYaw.toFixed(2)} rad/s, peak slip ${r.peakSlip.toFixed(0)} deg  ${r.spun ? "SPUN" : "held"}`);
    if (r.spun) failed = true;
  }
  console.log(failed ? "\nFAIL  the bike spins out." : "\nPASS  no spin in any scenario.");
  process.exit(failed ? 1 : 0);
}
void main();
