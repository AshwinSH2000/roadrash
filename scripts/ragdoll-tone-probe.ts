/** How floppy is the ragdoll? Peak swing at each ball joint through a fall, with and without muscle tone, plus how long it takes to settle. */
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { RagdollController, RAGDOLL_TONE, BONES } from "../src/physics/RagdollController";
import { FIXED_DT } from "../src/core/Clock";

async function fall(speed: number, scale: number): Promise<{ peak: Map<string, number>; settle: number; dist: number; rest: number }> {
  RAGDOLL_TONE.scale = scale;
  const physics = await PhysicsWorld.create();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(1), ground);
  const ragdoll = new RagdollController(physics, new THREE.Scene(), 0x2266dd);
  ragdoll.spawn(new THREE.Vector3(0, 1, 0), new THREE.Quaternion(), new THREE.Vector3(0, 0, speed), new THREE.Vector3(250, 100, 0));
  const peak = new Map<string, number>();
  let settle = 0;
  let rest = 0;
  const bodies = (ragdoll as any).bones as { spec: { name: string; parent?: string; tone?: unknown }; body: RAPIER.RigidBody }[];
  for (let i = 0; i < 600; i++) {
    physics.step();
    if (settle === 0 && ragdoll.tick(FIXED_DT)) settle = (i + 1) * FIXED_DT;
    for (const b of bodies) {
      if (i > 72) break;
      if (!b.spec.tone || !b.spec.parent) continue;
      const p = bodies.find((x) => x.spec.name === b.spec.parent)!;
      const pr = p.body.rotation(), cr = b.body.rotation();
      const rel = new THREE.Quaternion(pr.x, pr.y, pr.z, pr.w).invert().multiply(new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w));
      const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
      peak.set(b.spec.name, Math.max(peak.get(b.spec.name) ?? 0, angle));
    }
    if (i >= 420) rest = Math.max(rest, ragdoll.peakSpeeds.angular);
  }
  const t = ragdoll.pelvisPosition;
  return { peak, settle, dist: Math.hypot(t.x, t.z), rest };
}

const names = BONES.filter((b) => b.tone).map((b) => b.name);
console.log("peak swing at each joint (degrees) in the first 1.2 s of the fall, while the tone holds");
console.log("  speed  tone  " + names.map((n) => n.slice(0, 10).padEnd(11)).join("") + "settle  slid   residual spin");
for (const speed of [8, 20, 36]) {
  for (const scale of [0, 1]) {
    const r = await fall(speed, scale);
    console.log(
      `  ${String(speed).padStart(3)}    ${scale}    ` +
        names.map((n) => (((r.peak.get(n) ?? 0) * 180) / Math.PI).toFixed(0).padEnd(11)).join("") +
        `${r.settle.toFixed(1).padStart(4)} s  ${r.dist.toFixed(0).padStart(3)} m  ${r.rest.toFixed(2)}`,
    );
  }
}
