import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { GROUPS_TERRAIN } from "../src/physics/CollisionGroups";
import { Bike } from "../src/entities/Bike";
import { Racer } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { CombatSystem, AttackPhase, type HitEvent } from "../src/combat/CombatSystem";
import { AttackKind, ATTACKS, attackDuration } from "../src/combat/AttackDefinitions";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_RIGHT } from "../src/utils/Directions";

/**
 * Exercises Phase 6's verification criteria headlessly:
 *
 *   - hits land inside the intended range and arc, and only there
 *   - whiffed attacks do nothing at all
 *   - cooldown prevents spamming
 *   - knockback scales with relative speed
 *
 * Two riders on a flat plate, placed at a chosen separation and bearing —
 * no track, so geometry is the only variable.
 *
 * Run with: npm run sim:combat
 */

interface Scene2 {
  physics: PhysicsWorld;
  combat: CombatSystem;
  attacker: Racer;
  victim: Racer;
  hits: HitEvent[];
  step: (dt?: number) => void;
}

/**
 * @param separation metres between the two bikes
 * @param bearingDeg 0 = victim directly right of attacker, 90 = directly ahead
 */
async function build(
  separation: number,
  bearingDeg: number,
  pinned?: { attacker: THREE.Vector3; victim: THREE.Vector3 },
): Promise<Scene2> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const scene = new THREE.Scene();

  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(500, 1, 500)
      .setTranslation(0, -1, 0)
      .setFriction(1.0)
      .setCollisionGroups(GROUPS_TERRAIN),
    ground,
  );
  surfaces.register(groundCollider, ROAD_SURFACE);

  const facing = new THREE.Quaternion();
  const attackerBike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1, 0), facing, 0x2266dd);

  // Place the victim at `bearingDeg` measured from the attacker's right.
  const right = LOCAL_RIGHT.clone().applyQuaternion(facing);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(facing);
  const bearing = THREE.MathUtils.degToRad(bearingDeg);
  const offset = right
    .clone()
    .multiplyScalar(Math.cos(bearing) * separation)
    .addScaledVector(forward, Math.sin(bearing) * separation);
  const victimBike = new Bike(
    physics, surfaces, scene,
    new THREE.Vector3(offset.x, 1, offset.z), facing, 0xd0342f,
  );

  const attacker = new Racer(
    attackerBike, "Attacker", true, 0x2266dd,
    new RiderStateMachine(physics, scene, attackerBike, 0x2266dd),
  );
  const victim = new Racer(
    victimBike, "Victim", false, 0xd0342f,
    new RiderStateMachine(physics, scene, victimBike, 0xd0342f),
  );

  const hits: HitEvent[] = [];
  const combat = new CombatSystem([attacker, victim], (hit) => hits.push(hit));

  const step = (): void => {
    // Velocities are held fixed during a closing-speed test. The point there
    // is to check the knockback *formula* against a known relative speed, and
    // letting tyre grip bleed the velocity away mid-swing would test the
    // vehicle model instead.
    if (pinned) {
      attackerBike.controller.chassisBody.setLinvel(
        { x: pinned.attacker.x, y: 0, z: pinned.attacker.z }, true,
      );
      victimBike.controller.chassisBody.setLinvel(
        { x: pinned.victim.x, y: 0, z: pinned.victim.z }, true,
      );
    }
    for (const racer of [attacker, victim]) racer.rider.tick(FIXED_DT);
    combat.tick(FIXED_DT);
    for (const racer of [attacker, victim]) racer.bike.prePhysicsStep(FIXED_DT);
    physics.step();
    for (const racer of [attacker, victim]) racer.bike.postPhysicsStep();
  };

  return { physics, combat, attacker, victim, hits, step };
}

/** Throws one attack and runs it to completion. Returns whether it connected. */
async function attempt(
  separation: number,
  bearingDeg: number,
  kind: AttackKind,
  pinned?: { attacker: THREE.Vector3; victim: THREE.Vector3 },
): Promise<{ connected: boolean; hit: HitEvent | null }> {
  const s = await build(separation, bearingDeg, pinned);
  s.combat.request(s.attacker, kind);
  const steps = Math.ceil(attackDuration(ATTACKS[kind]) / FIXED_DT) + 4;
  for (let i = 0; i < steps; i++) s.step();
  return { connected: s.hits.length > 0, hit: s.hits[0] ?? null };
}

async function main(): Promise<void> {
  const failures: string[] = [];

  // --- 1. Range -----------------------------------------------------------
  console.log("Range — victim directly beside the attacker:\n");
  console.log("attack   separation   inside stated range?   connected?");
  for (const kind of [AttackKind.PUNCH, AttackKind.KICK]) {
    const range = ATTACKS[kind].range;
    for (const separation of [range - 0.6, range - 0.1, range + 0.3, range + 1.5]) {
      const { connected } = await attempt(separation, 0, kind);
      const shouldHit = separation <= range;
      const ok = connected === shouldHit;
      console.log(
        `${kind.padEnd(7)}  ${separation.toFixed(1).padStart(9)} m   ` +
          `${(shouldHit ? "yes" : "no").padStart(19)}   ${(connected ? "HIT" : "miss").padStart(9)}` +
          `${ok ? "" : "   <-- WRONG"}`,
      );
      if (!ok) {
        failures.push(
          `${kind} at ${separation.toFixed(1)} m ${connected ? "hit" : "missed"} but should have ` +
            `${shouldHit ? "hit" : "missed"} (range ${range}).`,
        );
      }
    }
  }

  // --- 2. Arc -------------------------------------------------------------
  console.log("\nArc — victim at 1.8 m, swung around the attacker:\n");
  console.log("bearing from the side   inside arc?   connected?");
  const punchArc = THREE.MathUtils.radToDeg(ATTACKS[AttackKind.PUNCH].arc);
  for (const bearing of [0, 30, punchArc - 5, punchArc + 8, 90]) {
    const { connected } = await attempt(1.8, bearing, AttackKind.PUNCH);
    const shouldHit = bearing <= punchArc;
    const ok = connected === shouldHit;
    console.log(
      `${bearing.toFixed(0).padStart(19)} deg   ${(shouldHit ? "yes" : "no").padStart(11)}   ` +
        `${(connected ? "HIT" : "miss").padStart(9)}${ok ? "" : "   <-- WRONG"}`,
    );
    if (!ok) {
      failures.push(
        `Punch at ${bearing.toFixed(0)} deg off the side ${connected ? "hit" : "missed"} but should ` +
          `have ${shouldHit ? "hit" : "missed"} (arc ${punchArc.toFixed(0)} deg).`,
      );
    }
  }

  // --- 3. A whiff does nothing -------------------------------------------
  const whiff = await build(8, 0);
  whiff.combat.request(whiff.attacker, AttackKind.KICK);
  for (let i = 0; i < 60; i++) whiff.step();
  const whiffClean = whiff.hits.length === 0 && whiff.victim.rider.isRiding;
  console.log(`\nwhiff at 8 m           ${whiffClean ? "no effect (correct)" : "SOMETHING HAPPENED"}`);
  if (!whiffClean) failures.push("A whiffed attack still affected the victim.");

  // --- 4. Cooldown --------------------------------------------------------
  const spam = await build(1.8, 0);
  let accepted = 0;
  const kickDuration = attackDuration(ATTACKS[AttackKind.KICK]);
  const spamSteps = Math.ceil(kickDuration / FIXED_DT);
  for (let i = 0; i < spamSteps; i++) {
    if (spam.combat.request(spam.attacker, AttackKind.KICK)) accepted++;
    spam.step();
  }
  console.log(
    `spam over one attack   ${accepted} of ${spamSteps} requests accepted ` +
      `(want exactly 1 — the rest are on cooldown)`,
  );
  if (accepted !== 1) failures.push(`Cooldown let ${accepted} attacks start where only 1 should have.`);

  // --- 5. Knockback scales with closing speed -----------------------------
  // The victim closes straight along the line between the two riders, so the
  // bearing stays fixed while the gap shrinks. Closing on any other heading
  // rotates that line during the wind-up, and by the time the strike lands
  // the relative velocity no longer points along it — which produced a
  // *decreasing* impulse and looked like a scaling bug in the code.
  console.log("\nKnockback vs closing speed (punch, victim closing head-on):\n");
  console.log("closing speed   impulse   over baseline");
  const impulses: number[] = [];
  for (const closing of [0, 5, 10]) {
    const towardAttacker = LOCAL_RIGHT.clone().multiplyScalar(-closing);
    const { hit } = await attempt(2.0, 0, AttackKind.PUNCH, {
      attacker: new THREE.Vector3(0, 0, 0),
      victim: towardAttacker,
    });
    const impulse = hit?.impulse ?? 0;
    impulses.push(impulse);
    const baseline = impulses[0] || 1;
    console.log(
      `${closing.toFixed(0).padStart(11)} m/s   ${impulse.toFixed(0).padStart(7)}   ` +
        `${(((impulse - baseline) / baseline) * 100).toFixed(0).padStart(11)}%`,
    );
  }
  if (impulses.some((i) => i === 0)) {
    failures.push("A closing-speed test never connected, so knockback scaling is untested.");
  } else if (!(impulses[2] > impulses[1] && impulses[1] > impulses[0])) {
    failures.push("Knockback does not increase with closing speed.");
  }

  // --- 6. The hit actually starts a fall ----------------------------------
  const fall = await build(1.8, 0);
  fall.combat.request(fall.attacker, AttackKind.KICK);
  for (let i = 0; i < 40; i++) fall.step();
  const victimDown = !fall.victim.rider.isRiding;
  const attackerUp = fall.attacker.rider.isRiding;
  console.log(
    `\nafter a landed kick    victim off the bike: ${victimDown}, attacker still riding: ${attackerUp}`,
  );
  if (!victimDown) failures.push("A landed hit did not knock the victim off.");
  if (!attackerUp) failures.push("The attacker fell off their own attack.");

  console.log("");
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log("PASS  combat behaves as specified.");
}
void main();
