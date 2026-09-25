import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry, ROAD_SURFACE } from "../src/physics/TerrainMaterial";
import { GROUPS_TERRAIN } from "../src/physics/CollisionGroups";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { pickTrack, DEFAULT_TRACK } from "../src/track/tracks";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { BrakeToStopDriver, Racer } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { OpponentAI } from "../src/ai/OpponentAI";
import {
  CombatBehavior,
  DEFAULT_AI_COMBAT_SETTINGS,
  type AiCombatSettings,
} from "../src/ai/CombatBehavior";
import { CombatSystem, type HitEvent } from "../src/combat/CombatSystem";
import {
  OPPONENT_PERSONALITIES,
  AUTOPILOT_PERSONALITY,
  type RiderPersonality,
} from "../src/ai/RiderPersonality";
import { FIXED_DT } from "../src/core/Clock";

/**
 * Phase 7's verification, headless:
 *
 *   1. The "bots attack you" setting is honoured: on a flat plate, a maximally
 *      aggressive bot parked beside the player never swings while the setting
 *      is off, and swings within seconds once it is on.
 *   2. In a full AI race the bots fight *occasionally* — some hits, but not a
 *      brawl — the player (with the setting off) is never touched, nobody is
 *      caught in an endless fight loop, and every knocked-down rider gets up,
 *      rejoins and finishes.
 *   3. The same race with the setting on: bots go for the player, and over
 *      six races land at least one hit. Whether any single race produces a
 *      hit on the player depends on who happens to be alongside when a bot
 *      rolls to engage — and now on that rider holding position long enough
 *      to clear the mandatory 2-5 s stand-off before a bot may swing at all
 *      (`CombatBehavior`'s `STRIKE_DELAY_MIN`/`MAX`, requested directly so a
 *      target has real time to move away) — so any single race is very much
 *      a coin toss now; six races is enough samples that requiring zero
 *      hits across all of them stays a real signal rather than noise. The
 *      plate test above, which pins both bikes stationary and alongside for
 *      the whole 15 s, is the deterministic proof the setting and the
 *      stand-off both work at all.
 *
 * Bot decisions are random, so the sims run on a seeded generator and are
 * repeatable; `SEED=n` picks another.
 *
 * Run with: npm run sim:aicombat
 */

const SEED = Number(process.env.SEED ?? 7);

/** Small seeded PRNG (mulberry32), so a failure here can be replayed exactly. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. The setting ------------------------------------------------------

/**
 * Two bikes side by side on a plate, 1.8 m apart, both held at 12 m/s (bots
 * don't fight below racing speed). The bot has aggression 1.0 so the only
 * thing standing between it and a punch is the setting. Returns how many
 * seconds passed before the first hit, or null.
 */
const PLATE_SPEED = 12;
async function settingOnPlate(settings: AiCombatSettings, seconds: number): Promise<number | null> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const scene = new THREE.Scene();
  const ground = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(1.0).setCollisionGroups(GROUPS_TERRAIN),
    ground,
  );
  surfaces.register(groundCollider, ROAD_SURFACE);

  const facing = new THREE.Quaternion();
  const botBike = new Bike(physics, surfaces, scene, new THREE.Vector3(0, 1, 0), facing, 0xd0342f);
  const playerBike = new Bike(physics, surfaces, scene, new THREE.Vector3(1.8, 1, 0), facing, 0x2266dd);
  const bot = new Racer(botBike, "Bot", false, 0xd0342f, new RiderStateMachine(physics, scene, botBike, 0xd0342f));
  const player = new Racer(playerBike, "You", true, 0x2266dd, new RiderStateMachine(physics, scene, playerBike, 0x2266dd));
  const field = [bot, player];

  const hits: HitEvent[] = [];
  const combat = new CombatSystem(field, (hit) => hits.push(hit));
  const personality: RiderPersonality = { ...OPPONENT_PERSONALITIES[1], aggression: 1.0 };
  const behavior = new CombatBehavior(bot, field, combat, personality, settings, makeRandom(SEED));

  let t = 0;
  while (t < seconds) {
    for (const racer of field) {
      racer.bike.controller.chassisBody.setLinvel({ x: 0, y: 0, z: PLATE_SPEED }, true);
      racer.rider.tick(FIXED_DT);
    }
    behavior.tick(FIXED_DT);
    combat.tick(FIXED_DT);
    for (const racer of field) racer.bike.prePhysicsStep(FIXED_DT);
    physics.step();
    for (const racer of field) racer.bike.postPhysicsStep();
    t += FIXED_DT;
    if (hits.length > 0) return t;
  }
  return null;
}

// --- 2/3. A race with combat --------------------------------------------

interface RaceReport {
  finished: number;
  total: number;
  elapsed: number;
  hits: HitEvent[];
  engagements: number;
  attacks: number;
  expired: number;
  lost: number;
  /** Chases that were aimed at the player. */
  playerChases: number;
  knockdowns: Map<string, number>;
  playerHits: number;
  stillDown: string[];
  leaked: string[];
  /** Rescues of a rider who was on their bike — a driving failure, like sim:race counts. */
  rescuesRiding: number;
  /**
   * Rescues within 30 s of being knocked off: the fall carried the rider off
   * the world, or the riderless bike came to rest somewhere it couldn't leave.
   * The fall system's business, not this phase's; allowed, as in sim:race.
   */
  rescuesAfterKnockdown: number;
  order: Racer[];
}

const GRID_COLUMNS = 2;
const GRID_ROW_GAP = 7;
const GRID_LATERAL = 2.5;
const VOID_FALL_MARGIN = 30;
const STUCK_GRACE_SECONDS = 3;
const TIMEOUT_SECONDS = 360;

async function race(settings: AiCombatSettings, seed: number): Promise<RaceReport> {
  const random = makeRandom(seed);
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition(process.env.TRACK ? pickTrack(process.env.TRACK) : DEFAULT_TRACK);
  const scene = new THREE.Scene();
  const built = buildTrack(physics, scene, track, surfaces);

  let lowest = Infinity;
  for (const p of track.samplePoints) lowest = Math.min(lowest, p.y);
  const voidFallY = lowest - VOID_FALL_MARGIN;

  // The player's seat is filled by a stand-in flagged as the player so the
  // "bots attack you" setting applies to it. Aggression 0: it never swings,
  // which keeps "was the player hit" a clean measure of the setting. It rides
  // at mid-pack pace and does *not* auto-dodge: the real autopilot moves
  // 3.5 m away from every bot it passes, which no human does, and which put
  // it out of reach of every swing in the first version of this sim.
  const SIM_PLAYER: RiderPersonality = { ...AUTOPILOT_PERSONALITY, topSpeedFraction: 0.97, dodges: false };
  const personalities = [...OPPONENT_PERSONALITIES, SIM_PLAYER];
  const racers: Racer[] = [];
  const racerByCollider = new Map<number, Racer>();
  for (let slot = 0; slot < personalities.length; slot++) {
    const personality = personalities[slot];
    const row = Math.floor(slot / GRID_COLUMNS);
    const lateral = slot % GRID_COLUMNS === 0 ? -GRID_LATERAL : GRID_LATERAL;
    const distance = track.startDistance - row * GRID_ROW_GAP;
    const bike = new Bike(physics, surfaces, scene, track.spawnPoint(distance, lateral, 1.0), track.spawnRotation(distance), personality.color);
    const rider = new RiderStateMachine(physics, scene, bike, personality.color);
    const isPlayer = personality === SIM_PLAYER;
    const racer = new Racer(bike, isPlayer ? "You" : personality.name, isPlayer, personality.color, rider);
    racer.updateTrackPosition(track);
    racers.push(racer);
    racerByCollider.set(bike.controller.chassisCollider.handle, racer);
  }

  const hits: HitEvent[] = [];
  const lastKnockdown = new Map<Racer, number>();
  const combat = new CombatSystem(racers, (hit) => {
    hits.push(hit);
    lastKnockdown.set(hit.victim, elapsed);
  });
  const behaviors: CombatBehavior[] = [];
  for (let i = 0; i < racers.length; i++) {
    const behavior = new CombatBehavior(racers[i], racers, combat, personalities[i], settings, random);
    behaviors.push(behavior);
    racers[i].driver = new OpponentAI(racers[i], track, racers, personalities[i], behavior);
  }

  let elapsed = 0;
  let finished = 0;
  let rescuesRiding = 0;
  let rescuesAfterKnockdown = 0;
  let playerChases = 0;
  const chasingPlayer = new Set<CombatBehavior>();
  while (finished < racers.length && elapsed < TIMEOUT_SECONDS) {
    for (const racer of racers) racer.tickDriver(FIXED_DT);
    for (const behavior of behaviors) {
      const onPlayer = behavior.currentTarget?.isPlayer === true;
      if (onPlayer && !chasingPlayer.has(behavior)) playerChases++;
      if (onPlayer) chasingPlayer.add(behavior);
      else chasingPlayer.delete(behavior);
    }
    combat.tick(FIXED_DT);
    for (const racer of racers) racer.bike.prePhysicsStep(FIXED_DT);
    physics.step();
    for (const racer of racers) racer.bike.postPhysicsStep();
    elapsed += FIXED_DT;
    const graceElapsed = elapsed > STUCK_GRACE_SECONDS;

    for (const racer of racers) {
      racer.updateTrackPosition(track);
      if (racer.hasFinished) continue;
      const fell = racer.bike.worldPosition.y <= voidFallY;
      if (fell || racer.updateStuck(FIXED_DT, graceElapsed)) {
        const sinceKnockdown = elapsed - (lastKnockdown.get(racer) ?? -Infinity);
        if (sinceKnockdown < 30) rescuesAfterKnockdown++;
        else rescuesRiding++;
        console.log(
          `    [rescue] ${racer.name.padEnd(8)} ${fell ? "fell off world" : "stuck"} at ${elapsed.toFixed(1)} s, ` +
            `${racer.rider.isRiding ? "riding" : racer.rider.current}, ` +
            `${Number.isFinite(sinceKnockdown) ? `${sinceKnockdown.toFixed(1)} s after being knocked off` : "never knocked off"}, ` +
            `off-centre ${racer.lateralOffset.toFixed(1)} m`,
        );
        const rescueDistance = THREE.MathUtils.clamp(racer.distanceAlong - 5, track.startDistance, track.finishDistance);
        racer.bike.controller.respawnAt(track.spawnPoint(rescueDistance, 0, 1.5), track.spawnRotation(rescueDistance));
        if (!racer.rider.isRiding) racer.rider.forceRemount();
        racer.resetProjection();
      }
    }

    physics.world.intersectionPairsWith(built.finishSensor, (other) => {
      const racer = racerByCollider.get(other.handle);
      if (!racer || racer.hasFinished) return;
      racer.hasFinished = true;
      racer.raceTime = elapsed;
      racer.finishPosition = ++finished;
      racer.driver = new BrakeToStopDriver(racer.bike);
    });
  }

  const knockdowns = new Map<string, number>();
  for (const hit of hits) knockdowns.set(hit.victim.name, (knockdowns.get(hit.victim.name) ?? 0) + 1);

  const order = [...racers].sort((a, b) => {
    if (a.hasFinished && b.hasFinished) return a.finishPosition - b.finishPosition;
    if (a.hasFinished) return -1;
    if (b.hasFinished) return 1;
    return b.distanceAlong - a.distanceAlong;
  });

  return {
    finished,
    total: racers.length,
    elapsed,
    hits,
    engagements: behaviors.reduce((n, b) => n + b.stats.engagements, 0),
    attacks: behaviors.reduce((n, b) => n + b.stats.attacks, 0),
    expired: behaviors.reduce((n, b) => n + b.stats.expired, 0),
    lost: behaviors.reduce((n, b) => n + b.stats.lost, 0),
    playerChases,
    knockdowns,
    playerHits: hits.filter((h) => h.victim.isPlayer).length,
    stillDown: racers.filter((r) => !r.rider.isRiding).map((r) => r.name),
    leaked: racers.filter((r) => r.rider.ragdollBodyCount !== 0).map((r) => r.name),
    rescuesRiding,
    rescuesAfterKnockdown,
    order,
  };
}

function printRace(r: RaceReport): void {
  console.log(
    `  simulated      ${r.elapsed.toFixed(1)} s, ${r.finished}/${r.total} finished, ` +
      `${r.rescuesRiding} rescue(s) unrelated to a fight, ${r.rescuesAfterKnockdown} in the 30 s after a knockdown`,
  );
  console.log(
    `  fights         ${r.engagements} chases (${r.playerChases} at the player): ${r.attacks} swings, ` +
      `${r.expired} gave up, ${r.lost} lost the target; ${r.hits.length} landed ` +
      `(${((r.hits.length / r.elapsed) * 60).toFixed(1)} per minute of racing)`,
  );
  for (const hit of r.hits) {
    console.log(`    ${hit.attacker.name.padEnd(8)} ${hit.kind.padEnd(5)} ${hit.victim.name.padEnd(8)} closing ${hit.closingSpeed.toFixed(1)} m/s`);
  }
  console.log("  pos  rider     time      knocked off");
  for (let i = 0; i < r.order.length; i++) {
    const racer = r.order[i];
    const time = racer.hasFinished ? `${racer.raceTime.toFixed(1)}s` : "DNF";
    console.log(`    ${i + 1}  ${racer.name.padEnd(9)} ${time.padEnd(9)} ${r.knockdowns.get(racer.name) ?? 0}`);
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  console.log(`seed ${SEED}\n`);

  // --- 1 ---
  const offSetting: AiCombatSettings = { ...DEFAULT_AI_COMBAT_SETTINGS };
  const onSetting: AiCombatSettings = { ...DEFAULT_AI_COMBAT_SETTINGS, botsAttackPlayer: true };
  const whileOff = await settingOnPlate(offSetting, 15);
  const whileOn = await settingOnPlate(onSetting, 15);
  console.log("Setting — an aggression-1.0 bot parked 1.8 m from the player, 15 s:");
  console.log(`  bots attack you OFF   ${whileOff === null ? "never swung (correct)" : `HIT the player at ${whileOff.toFixed(1)} s`}`);
  console.log(`  bots attack you ON    ${whileOn === null ? "NEVER SWUNG" : `hit the player at ${whileOn.toFixed(1)} s`}`);
  if (whileOff !== null) failures.push("A bot attacked the player with the setting off.");
  if (whileOn === null) failures.push("A bot never attacked the player with the setting on.");
  if (DEFAULT_AI_COMBAT_SETTINGS.botsAttackPlayer) failures.push("The default for 'bots attack you' is on; it must be off.");

  // --- 2 ---
  console.log("\nRace, bots attack you OFF (the default):");
  const clean = await race(offSetting, SEED);
  printRace(clean);
  if (clean.finished < clean.total) failures.push(`${clean.total - clean.finished} rider(s) did not finish with combat on.`);
  if (clean.stillDown.length) failures.push(`Ended the race off their bike: ${clean.stillDown.join(", ")}`);
  if (clean.leaked.length) failures.push(`Ragdoll bodies leaked: ${clean.leaked.join(", ")}`);
  if (clean.playerHits > 0) failures.push(`The player was hit ${clean.playerHits} time(s) with the setting off.`);
  if (clean.playerChases > 0) failures.push(`Bots chased the player ${clean.playerChases} time(s) with the setting off.`);
  if (clean.rescuesRiding > 0) failures.push(`${clean.rescuesRiding} rescue(s) unrelated to any knockdown — combat is putting bots off the road.`);
  if (clean.hits.length === 0) failures.push("No bot ever landed a hit — they should fight occasionally.");
  const perMinute = (clean.hits.length / clean.elapsed) * 60;
  if (perMinute > 8) failures.push(`${perMinute.toFixed(1)} hits per minute is a brawl, not occasional.`);
  for (const [name, n] of clean.knockdowns) {
    if (n > 5) failures.push(`${name} was knocked off ${n} times — that's a fight loop, not a race.`);
  }

  // --- 3 ---
  let playerChases = 0;
  let playerHits = 0;
  const raceSeeds = [SEED, SEED + 1, SEED + 2, SEED + 3, SEED + 4, SEED + 5];
  for (const seed of raceSeeds) {
    console.log(`\nRace, bots attack you ON (seed ${seed}):`);
    const hostile = await race(onSetting, seed);
    printRace(hostile);
    playerChases += hostile.playerChases;
    playerHits += hostile.playerHits;
    if (hostile.finished < hostile.total) failures.push(`${hostile.total - hostile.finished} rider(s) did not finish with the player targetable (seed ${seed}).`);
    if (hostile.stillDown.length) failures.push(`Ended the race off their bike (setting on, seed ${seed}): ${hostile.stillDown.join(", ")}`);
    if (hostile.leaked.length) failures.push(`Ragdoll bodies leaked (setting on, seed ${seed}): ${hostile.leaked.join(", ")}`);
  }
  console.log(
    `\nwith the setting on, over ${raceSeeds.length} races: ${playerChases} chase(s) at the player, ${playerHits} hit(s) landed`,
  );
  if (playerChases === 0) failures.push("No bot ever went for the player with the setting on.");
  if (playerHits === 0) failures.push(`The player was never hit with the setting on, over ${raceSeeds.length} races.`);

  console.log("");
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log("PASS  bots fight occasionally, honour the setting, and everyone finishes.");
}

void main();
