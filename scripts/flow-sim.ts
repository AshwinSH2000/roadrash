import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { DEFAULT_TRACK, pickTrack } from "../src/track/tracks";
import { buildTrack } from "../src/track/TrackBuilder";
import { gridPose, GRID_COLUMNS, GRID_ROWS, PLAYER_GRID_SLOT } from "../src/track/StartGrid";
import { Bike } from "../src/entities/Bike";
import { Racer, type Driver } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { OpponentAI } from "../src/ai/OpponentAI";
import { CombatBehavior, DEFAULT_AI_COMBAT_SETTINGS } from "../src/ai/CombatBehavior";
import { CombatSystem } from "../src/combat/CombatSystem";
import { AUTOPILOT_PERSONALITY, OPPONENT_PERSONALITIES, PLAYER_COLOR } from "../src/ai/RiderPersonality";
import { Nitro } from "../src/entities/Nitro";
import { FIXED_DT } from "../src/core/Clock";
import {
  COUNTDOWN_SECONDS,
  HARD_CAP_SECONDS,
  RaceFlow,
  RacePhase,
  RaceResult,
  TIMEOUT_MULTIPLIER,
} from "../src/core/RaceFlow";
import { LOCAL_RIGHT, WORLD_UP } from "../src/utils/Directions";

/**
 * Phase 8's verification, headless: the full loop, start to finish to "Race
 * Again", several times over, with no leaked physics bodies.
 *
 *   race 1  player on autopilot — finishes, Win or Lose
 *   race 2  player parked on the grid — times out to a DNF at 3× the winner
 *   race 3  autopilot again, with a knockdown mid-race so a restart has to
 *           clean up a rider who is off the bike
 *
 * After every race the field is reset exactly as `Game.restartRace` does it,
 * and the sim checks: the countdown held everyone still; the body and
 * collider counts are what they were before the first race; every rider is
 * back on their bike, on their grid slot, with the finishing order cleared;
 * and the next race can be won again from there.
 *
 * Run with: npm run sim:flow
 */

const STUCK_GRACE_SECONDS = 3;
const VOID_FALL_MARGIN = 30;

/** A player who never touches the controls — for the DNF race. */
class ParkedDriver implements Driver {
  constructor(private readonly bike: Bike) {}
  tick(): void {
    this.bike.setInput(0, 0);
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition(process.env.TRACK ? pickTrack(process.env.TRACK) : DEFAULT_TRACK);
  const scene = new THREE.Scene();
  const built = buildTrack(physics, scene, track, surfaces);
  console.log(`course           ${track.name}\n`);

  let lowest = Infinity;
  for (const p of track.samplePoints) lowest = Math.min(lowest, p.y);
  const voidFallY = lowest - VOID_FALL_MARGIN;

  // --- the field, built the way Game builds it -----------------------------
  const racers: Racer[] = [];
  const racerByCollider = new Map<number, Racer>();
  let personalityIndex = 0;
  let player: Racer | null = null;
  for (let slot = 0; slot < GRID_COLUMNS * GRID_ROWS; slot++) {
    const pose = gridPose(track, slot);
    const isPlayer = slot === PLAYER_GRID_SLOT;
    const personality = isPlayer ? null : OPPONENT_PERSONALITIES[personalityIndex++];
    const color = personality?.color ?? PLAYER_COLOR;
    const bike = new Bike(physics, surfaces, scene, pose.position, pose.rotation, color);
    const rider = new RiderStateMachine(physics, scene, bike, color);
    const racer = new Racer(bike, personality?.name ?? "You", isPlayer, color, rider);
    racer.updateTrackPosition(track);
    racers.push(racer);
    racerByCollider.set(bike.controller.chassisCollider.handle, racer);
    if (isPlayer) player = racer;
  }
  if (!player) throw new Error("no player slot");

  const combat = new CombatSystem(racers);
  const behaviors: CombatBehavior[] = [];
  const autopilot = new OpponentAI(player, track, racers, AUTOPILOT_PERSONALITY);
  const parked = new ParkedDriver(player.bike);
  for (const racer of racers) {
    if (racer.isPlayer) {
      racer.baseDriver = autopilot;
    } else {
      const personality = OPPONENT_PERSONALITIES[racers.indexOf(racer)];
      const behavior = new CombatBehavior(racer, racers, combat, personality, DEFAULT_AI_COMBAT_SETTINGS);
      behaviors.push(behavior);
      racer.baseDriver = new OpponentAI(racer, track, racers, personality, behavior);
    }
    racer.driver = racer.baseDriver;
  }
  const nitro = new Nitro();
  const flow = new RaceFlow();

  const bodiesAtStart = physics.world.bodies.len();
  const collidersAtStart = physics.world.colliders.len();
  const sceneAtStart = scene.children.length;
  console.log(`before race 1    ${bodiesAtStart} bodies, ${collidersAtStart} colliders, ${scene.children.length} scene children`);

  const standings = (): Racer[] =>
    [...racers].sort((a, b) => {
      if (a.hasFinished && b.hasFinished) return a.finishPosition - b.finishPosition;
      if (a.hasFinished) return -1;
      if (b.hasFinished) return 1;
      return b.distanceAlong - a.distanceAlong;
    });
  const firstFinishTime = (): number | null => {
    let first: number | null = null;
    for (const r of racers) if (r.hasFinished && (first === null || r.raceTime < first)) first = r.raceTime;
    return first;
  };

  /** One race, exactly the step order `Game.step` uses. */
  function runRace(label: string, knockdownAt: number | null): { result: RaceResult; position: number; elapsed: number; winnerTime: number | null } {
    let finishedCount = 0;
    let knockedDown = false;
    let countdownMoved = 0;
    let wall = 0;
    // Mirrors `Game.raceClock`: seconds since the lights went out, but unlike
    // `flow.raceElapsed` it keeps running after the race is decided, so a bot
    // finishing after the player gets its own real time rather than being
    // stamped with the player's frozen one.
    let raceClock = 0;
    const startPositions = racers.map((r) => r.bike.worldPosition.clone());

    // Guard against a race that never ends — the hard cap plus a margin.
    while (flow.current !== RacePhase.FINISHED && wall < HARD_CAP_SECONDS + COUNTDOWN_SECONDS + 5) {
      const phase = flow.current;
      if (phase === RacePhase.COUNTDOWN) {
        for (const racer of racers) {
          racer.rider.tick(FIXED_DT);
          racer.bike.setInput(0, 0);
          racer.bike.controller.setHandbrake(true);
        }
      } else {
        for (const racer of racers) racer.bike.controller.setHandbrake(false);
        nitro.tick(FIXED_DT);
        for (const racer of racers) racer.tickDriver(FIXED_DT);
      }
      combat.tick(FIXED_DT);
      for (const racer of racers) racer.bike.prePhysicsStep(FIXED_DT);
      physics.step();
      for (const racer of racers) racer.bike.postPhysicsStep();
      wall += FIXED_DT;

      for (const racer of racers) racer.updateTrackPosition(track);
      if (phase === RacePhase.COUNTDOWN) {
        // Nobody may creep forward while the lights are on.
        racers.forEach((r, i) => {
          const moved = r.bike.worldPosition.distanceTo(startPositions[i]);
          countdownMoved = Math.max(countdownMoved, moved);
          if (process.env.DRIFT_DEBUG && i === 0 && Math.round(wall * 60) % 15 === 0) {
            const d = r.bike.worldPosition.clone().sub(startPositions[i]);
            console.log(`    t=${wall.toFixed(2)} ${r.name} dx=${d.x.toFixed(2)} dy=${d.y.toFixed(2)} dz=${d.z.toFixed(2)} v=${(r.bike.forwardSpeed * 3.6).toFixed(1)} km/h along=${r.distanceAlong.toFixed(1)}`);
          }
        });
      } else {
        raceClock += FIXED_DT;
        const graceElapsed = flow.raceElapsed > STUCK_GRACE_SECONDS;
        if (knockdownAt !== null && !knockedDown && flow.raceElapsed >= knockdownAt) {
          knockedDown = true;
          const victim = racers[1];
          const impulse = new THREE.Vector3().copy(LOCAL_RIGHT).applyQuaternion(victim.bike.worldQuaternion).multiplyScalar(250).addScaledVector(WORLD_UP, 250 * 0.35);
          victim.rider.knockOff(impulse);
        }
        for (const racer of racers) {
          if (racer.hasFinished) continue;
          if (racer.bike.worldPosition.y <= voidFallY || racer.updateStuck(FIXED_DT, graceElapsed)) {
            const d = THREE.MathUtils.clamp(racer.distanceAlong - 5, track.startDistance, track.finishDistance);
            racer.bike.controller.respawnAt(track.spawnPoint(d, 0, 1.5), track.spawnRotation(d));
            if (!racer.rider.isRiding) racer.rider.forceRemount();
            racer.resetProjection();
          }
        }
        physics.world.intersectionPairsWith(built.finishSensor, (other) => {
          const racer = racerByCollider.get(other.handle);
          if (!racer || racer.hasFinished) return;
          racer.finishRace(raceClock, ++finishedCount);
        });
      }

      const order = standings();
      flow.tick(FIXED_DT, {
        playerFinished: player!.hasFinished,
        playerPosition: order.indexOf(player!) + 1,
        firstFinishTime: firstFinishTime(),
        fieldSize: racers.length,
      });
    }

    const result = flow.outcome ?? RaceResult.DNF;
    console.log(
      `${label.padEnd(16)} ${result.toUpperCase().padEnd(5)} P${flow.position} at ${flow.raceElapsed.toFixed(1)} s ` +
        `(countdown drift ${countdownMoved.toFixed(2)} m, ${finishedCount} finished)`,
    );
    if (countdownMoved > 0.3) failures.push(`${label}: a bike moved ${countdownMoved.toFixed(2)} m during the countdown.`);
    if (flow.current !== RacePhase.FINISHED) failures.push(`${label}: the race never ended.`);
    // Regression guard for the frozen-clock bug: every finisher crosses at a
    // different instant, so two identical raceTimes (beyond the trivial case
    // of only one finisher) means someone got stamped with someone else's time.
    const finishTimes = racers.filter((r) => r.hasFinished).map((r) => r.raceTime);
    if (new Set(finishTimes).size !== finishTimes.length) {
      failures.push(`${label}: two or more riders share an identical finish time — ${finishTimes.map((t) => t.toFixed(2)).join(", ")}.`);
    }
    return { result, position: flow.position, elapsed: flow.raceElapsed, winnerTime: firstFinishTime() };
  }

  /** `Game.restartRace`, line for line. */
  function restart(): void {
    for (let slot = 0; slot < racers.length; slot++) {
      const pose = gridPose(track, slot);
      racers[slot].restart(pose.position, pose.rotation, track);
    }
    combat.resetAll();
    for (const b of behaviors) b.reset();
    nitro.reset();
    player!.bike.controller.setBoost(false);
    flow.restart();
  }

  function checkReset(label: string): void {
    const bodies = physics.world.bodies.len();
    const colliders = physics.world.colliders.len();
    const problems: string[] = [];
    if (bodies !== bodiesAtStart) problems.push(`${bodies} bodies (was ${bodiesAtStart})`);
    if (colliders !== collidersAtStart) problems.push(`${colliders} colliders (was ${collidersAtStart})`);
    if (scene.children.length !== sceneAtStart) problems.push(`${scene.children.length} scene children (was ${sceneAtStart})`);
    racers.forEach((r, slot) => {
      const pose = gridPose(track, slot);
      const off = r.bike.worldPosition.distanceTo(pose.position);
      if (off > 0.5) problems.push(`${r.name} is ${off.toFixed(1)} m from grid slot ${slot + 1}`);
      if (!r.rider.isRiding) problems.push(`${r.name} is ${r.rider.current}, not riding`);
      if (r.hasFinished || r.finishPosition !== 0 || r.raceTime !== 0) problems.push(`${r.name} still has a finish recorded`);
      if (r.driver !== r.baseDriver) problems.push(`${r.name} is not back on their own driver`);
      if (r.rider.ragdollBodyCount !== 0) problems.push(`${r.name} has ${r.rider.ragdollBodyCount} ragdoll bodies alive`);
    });
    if (flow.current !== RacePhase.COUNTDOWN || flow.raceElapsed !== 0) problems.push(`flow is ${flow.current} at ${flow.raceElapsed}s`);
    if (!nitro.isReady) problems.push("nitro is not full");
    console.log(
      `${label.padEnd(16)} ${bodies} bodies, ${colliders} colliders, ${scene.children.length} scene children` +
        (problems.length ? `\n    PROBLEMS: ${problems.join("; ")}` : "   — clean"),
    );
    for (const p of problems) failures.push(`${label}: ${p}`);
  }

  // --- race 1: a normal race --------------------------------------------
  const r1 = runRace("race 1", null);
  if (r1.result === RaceResult.DNF) failures.push("Race 1: the autopilot player did not finish.");
  restart();
  checkReset("after race 1");

  // --- race 2: the player never moves, so the timeout must end it --------
  player.baseDriver = parked;
  player.driver = parked;
  const r2 = runRace("race 2 (parked)", null);
  if (r2.result !== RaceResult.DNF) failures.push(`Race 2: a parked player got "${r2.result}" instead of a DNF.`);
  if (r2.position !== racers.length) failures.push(`Race 2: DNF ranked P${r2.position}, should be last (P${racers.length}).`);
  if (r2.winnerTime !== null) {
    const expected = Math.min(HARD_CAP_SECONDS, r2.winnerTime * TIMEOUT_MULTIPLIER);
    if (Math.abs(r2.elapsed - expected) > 0.1) {
      failures.push(`Race 2: timed out at ${r2.elapsed.toFixed(1)} s, expected ${expected.toFixed(1)} s (3× the winner's ${r2.winnerTime.toFixed(1)} s).`);
    }
  }
  player.baseDriver = autopilot;
  restart();
  checkReset("after race 2");

  // --- race 3: a knockdown mid-race, then a restart with a rider down ----
  // Knock the same rider off again just before the restart, so the reset
  // has to despawn a live ragdoll rather than only tidy a finished field.
  const r3 = runRace("race 3 (fight)", 15);
  if (r3.result === RaceResult.DNF) failures.push("Race 3: the autopilot player did not finish.");
  const victim = racers[1];
  if (victim.rider.isRiding) {
    const impulse = new THREE.Vector3().copy(LOCAL_RIGHT).applyQuaternion(victim.bike.worldQuaternion).multiplyScalar(250).addScaledVector(WORLD_UP, 250 * 0.35);
    victim.rider.knockOff(impulse);
    for (let i = 0; i < 30; i++) {
      for (const racer of racers) racer.rider.tick(FIXED_DT);
      physics.step();
    }
  }
  const ragdollAlive = victim.rider.ragdollBodyCount;
  console.log(`before restart 3 ${victim.name} is ${victim.rider.current} with ${ragdollAlive} ragdoll bodies live`);
  if (ragdollAlive === 0) failures.push("Race 3: the pre-restart knockdown did not produce a live ragdoll to clean up.");
  restart();
  checkReset("after race 3");

  // --- race 4: and it still works from a cleaned-up field ----------------
  const r4 = runRace("race 4", null);
  if (r4.result === RaceResult.DNF) failures.push("Race 4: the autopilot player did not finish after three restarts.");

  console.log("");
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log("PASS  start → finish → race again, four times, nothing leaked.");
}

void main();
