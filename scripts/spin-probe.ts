import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD, LOCAL_RIGHT } from "../src/utils/Directions";

/**
 * Reproduces "hold the steer through a long corner and the bike spins".
 *
 * Runs the bike up to speed on the flat, then holds full steer for several
 * seconds — coasting, as you would mid-corner — and logs what the tyres and
 * the yaw are doing each half second. A second run pulses the same steer
 * input (release, re-press) for comparison, since the report was that pulsing
 * avoids the spin.
 *
 * Run with: npm run sim:spin
 */
interface Sample {
  t: number;
  speed: number;
  steerDeg: number;
  yawRate: number;
  slipDeg: number;
  heading: number;
  sideImpulseFront: number;
  sideImpulseRear: number;
  frontContact: boolean;
  rearContact: boolean;
}

async function run(
  targetSpeed: number,
  mode: "hold" | "pulse",
  throttle: number,
  seconds: number,
): Promise<Sample[]> {
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
  const ctl = bike.controller;

  for (let i = 0; i < 60 * 90 && bike.forwardSpeed < targetSpeed; i++) {
    bike.setInput(1, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
  }

  const samples: Sample[] = [];
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let heading = 0;
  let lastYaw: number | null = null;

  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    const t = i / 60;
    // Pulse: 0.6 s on, 0.25 s off — roughly what "release and re-press" is.
    const on = mode === "hold" ? true : t % 0.85 < 0.6;
    bike.setInput(throttle, on ? -1 : 0); // -1 = A / left
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();

    const r = ctl.chassisBody.rotation();
    q.set(r.x, r.y, r.z, r.w);
    fwd.copy(LOCAL_FORWARD).applyQuaternion(q);
    right.copy(LOCAL_RIGHT).applyQuaternion(q);
    const v = ctl.chassisBody.linvel();
    vel.set(v.x, 0, v.z);
    const yaw = Math.atan2(fwd.x, fwd.z);
    if (lastYaw !== null) {
      let d = yaw - lastYaw;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      heading += d;
    }
    lastYaw = yaw;

    if (i % 30 === 0 || i === steps - 1) {
      const speed = vel.length();
      const slip = speed > 0.5 ? Math.atan2(vel.dot(right), vel.dot(fwd)) : 0;
      const raw = ctl as unknown as { vehicle: RAPIER.DynamicRayCastVehicleController };
      const sideImpulse = (w: number): number => {
        const fn = (raw.vehicle as unknown as { wheelSideImpulse?: (i: number) => number | null }).wheelSideImpulse;
        return fn ? (fn.call(raw.vehicle, w) ?? 0) : NaN;
      };
      samples.push({
        t,
        speed,
        steerDeg: THREE.MathUtils.radToDeg(ctl.steerAngle),
        yawRate: ctl.yawRate,
        slipDeg: THREE.MathUtils.radToDeg(slip),
        heading: THREE.MathUtils.radToDeg(heading),
        sideImpulseFront: sideImpulse(0),
        sideImpulseRear: sideImpulse(1),
        frontContact: ctl.wheelIsGrounded(0),
        rearContact: ctl.wheelIsGrounded(1),
      });
    }
  }
  return samples;
}

function print(title: string, samples: Sample[]): void {
  console.log(`\n${title}`);
  console.log("   t   km/h   steer   yawRate   slip    heading   sideImp F/R    contact");
  for (const s of samples) {
    console.log(
      `${s.t.toFixed(1).padStart(4)}  ${(s.speed * 3.6).toFixed(0).padStart(4)}  ` +
        `${s.steerDeg.toFixed(1).padStart(6)}  ${s.yawRate.toFixed(2).padStart(7)}  ` +
        `${s.slipDeg.toFixed(1).padStart(5)}  ${s.heading.toFixed(0).padStart(7)}   ` +
        `${s.sideImpulseFront.toFixed(0).padStart(5)}/${s.sideImpulseRear.toFixed(0).padEnd(5)}  ` +
        `${s.frontContact ? "F" : "-"}${s.rearContact ? "R" : "-"}`,
    );
  }
  const last = samples[samples.length - 1];
  const maxSlip = Math.max(...samples.map((s) => Math.abs(s.slipDeg)));
  console.log(`  => turned ${last.heading.toFixed(0)} deg total, peak slip ${maxSlip.toFixed(1)} deg${maxSlip > 30 ? "  <-- SLIDING" : ""}`);
}

/** Yaw rate above which a held corner reads as a spin rather than a turn — 1.15 rad/s is ~66 deg/s. */
const SPIN_YAW_RATE = 1.15;

async function main(): Promise<void> {
  console.log("Full LEFT steer held on the flat, coasting (throttle off), from speed.");
  console.log("slip = angle between where the bike points and where it is going; a spin shows as yaw rate running away.");
  let peak = 0;
  for (const kmh of [60, 90, 120]) {
    const samples = await run(kmh / 3.6, "hold", 0, 8);
    print(`--- ${kmh} km/h, HOLD steer, throttle off ---`, samples);
    peak = Math.max(peak, ...samples.map((s) => Math.abs(s.yawRate)));
  }
  print(`--- 90 km/h, PULSE steer (0.6 s on / 0.25 s off), throttle off ---`, await run(90 / 3.6, "pulse", 0, 8));
  print(`--- 90 km/h, HOLD steer, throttle ON ---`, await run(90 / 3.6, "hold", 1, 8));

  console.log(`\npeak yaw rate with steer held while slowing: ${peak.toFixed(2)} rad/s (${THREE.MathUtils.radToDeg(peak).toFixed(0)} deg/s), want <= ${SPIN_YAW_RATE}`);
  if (peak > SPIN_YAW_RATE) {
    console.log("FAIL  a slowing bike at held lock whips round — the turn rate runs away.");
    process.exit(1);
  }
  console.log("PASS  turn rate stays bounded however long the steer is held.");
}
void main();
