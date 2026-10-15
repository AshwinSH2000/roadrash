/** Headless check of the procedural rider: ride pose, then the punch and kick timelines, in the bike's frame (+Z forward, +Y up, +X left). */
import { RiderModel } from "../src/entities/RiderModel";
import { PUNCH, KICK } from "../src/combat/AttackDefinitions";

const model = new RiderModel(0xd23030);
const f = (v: { x: number; y: number; z: number } | undefined): string =>
  v ? `${v.x.toFixed(2).padStart(6)} ${v.y.toFixed(2).padStart(6)} ${v.z.toFixed(2).padStart(6)}` : "     -      -      -";

console.log("ride pose");
for (const [name, p] of Object.entries(model.jointPositions())) console.log(" ", name.padEnd(8), f(p));

for (const [label, def] of [["punch", PUNCH], ["kick", KICK]] as const) {
  const total = def.windup + def.active + def.recovery;
  console.log(`\n${label} to the bike's right (side +1), t in s; impact at ${def.windup.toFixed(2)}`);
  console.log("  t     hips                   head                   armR hand              legR foot              baton");
  for (let i = 0; i <= 12; i++) {
    const t = (total * i) / 12;
    model.setAttack(label, 1, t, def);
    const p = model.jointPositions();
    console.log(`  ${t.toFixed(2)}  ${f(p.hips)}  ${f(p.head)}  ${f(p["armR.end"])}  ${f(p["legR.end"])}  ${f(p.baton)}`);
  }
  model.setAttack(null, 0, 0, def);
}

// On-foot poses: origin on the ground under the hips, +Z forward.
console.log("\nrun cycle (one stride), feet and hands; feet should touch y~0.08 for about a third of the stride");
console.log("  phase  hips                   legL foot              legR foot              armL hand              armR hand");
for (let i = 0; i <= 8; i++) {
  model.setRun((i / 8) * Math.PI * 2, 1);
  const p = model.jointPositions();
  console.log(`  ${(i / 8).toFixed(2)}   ${f(p.hips)}  ${f(p["legL.end"])}  ${f(p["legR.end"])}  ${f(p["armL.end"])}  ${f(p["armR.end"])}`);
}
console.log("\nget up (progress 0 -> 1)");
console.log("  p     hips                   head                   legL foot              armL hand");
for (let i = 0; i <= 5; i++) {
  model.setGetUp(i / 5);
  const p = model.jointPositions();
  console.log(`  ${(i / 5).toFixed(1)}   ${f(p.hips)}  ${f(p.head)}  ${f(p["legL.end"])}  ${f(p["armL.end"])}`);
}

import * as THREE from "three";
console.log("\npick up the bike (grip near the ground at first, rising); hands should reach their targets");
console.log("  p     hips                   head                   armL hand              armR hand");
for (let i = 0; i <= 5; i++) {
  const p = i / 5;
  // Bike on its side to start, standing at the end; rider 0.7 m from it, bars straight ahead of them.
  const gripY = 0.3 + 0.75 * Math.min(1, Math.max(0, (p - 0.25) / 0.7));
  model.setPickUp(p, new THREE.Vector3(0.0, gripY, 0.7), new THREE.Vector3(0.0, gripY - 0.05, 1.1));
  const q = model.jointPositions();
  console.log(`  ${p.toFixed(1)}   ${f(q.hips)}  ${f(q.head)}  ${f(q["armL.end"])}  ${f(q["armR.end"])}   (target y ${gripY.toFixed(2)})`);
}
console.log("\nhop onto the seat; at 1 the hands should be on the grips and feet on the pegs (shifted into the on-foot frame)");
for (let i = 0; i <= 4; i++) {
  model.setHop(i / 4);
  const q = model.jointPositions();
  console.log(`  ${(i / 4).toFixed(2)}  head ${f(q.head)}  armL ${f(q["armL.end"])}  legL ${f(q["legL.end"])}`);
}
