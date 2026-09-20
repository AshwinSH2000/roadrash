/**
 * Headless race simulation.
 *
 * Runs the real physics, the real track and the real opponent AI with no
 * renderer, at whatever rate the CPU manages, and reports the finishing
 * order. This is what verifies Phase 4's criterion — "run a race with only
 * AI, confirm all riders finish in reasonable and varied times, none get
 * stuck off-road or spin out permanently" — without needing a human to sit
 * and watch six boxes for a minute and a half.
 *
 * Nothing here is game code: it is a second, non-visual front end onto the
 * same systems `Game.ts` drives, so a pass here means the AI genuinely works
 * rather than that a mock of it does.
 *
 * Run with: npm run sim:race
 */
import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { pickTrack, DEFAULT_TRACK } from "../src/track/tracks";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { BrakeToStopDriver, Racer } from "../src/entities/Racer";
import { OpponentAI } from "../src/ai/OpponentAI";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { LOCAL_RIGHT, WORLD_UP } from "../src/utils/Directions";
import { OPPONENT_PERSONALITIES, AUTOPILOT_PERSONALITY } from "../src/ai/RiderPersonality";
import { FIXED_DT } from "../src/core/Clock";

const GRID_COLUMNS = 2;
const GRID_ROW_GAP = 7;
const GRID_LATERAL = 2.5;
const VOID_FALL_MARGIN = 30;
const STUCK_GRACE_SECONDS = 3;
/** Give up after this long; a race that can't finish in 6 minutes has failed anyway. */
const TIMEOUT_SECONDS = 360;

/**
 * Every piece of track geometry must face upward. A band with inverted
 * winding is invisible in the browser — backface-culled and unlit — while
 * remaining perfectly solid to the physics, so the headless sim would happily
 * pass a race on a track the player cannot see. That exact bug shipped once;
 * this is here so it can't ship twice.
 */
function assertTrackFacesUp(group: THREE.Group): void {
  const problems: string[] = [];
  let checked = 0;
  group.traverse((object) => {
    // Only the swept ribbons. Boxes (line markers, the gantry) have opposing
    // faces whose normals correctly cancel to zero.
    if (!(object instanceof THREE.Mesh) || object.userData.isTrackBand !== true) return;
    const normals = object.geometry.getAttribute("normal");
    if (!normals) return;
    let sum = 0;
    for (let i = 0; i < normals.count; i++) sum += normals.getY(i);
    checked++;
    const average = sum / normals.count;
    if (average <= 0.1) problems.push(`${object.name} (mean normal.y ${average.toFixed(2)})`);
  });
  if (problems.length > 0) {
    console.error(`FAIL  Track geometry faces downward and would be invisible: ${problems.join(", ")}`);
    process.exit(1);
  }
  console.log(`track geometry   ${checked} bands, all facing upward\n`);
}

async function main(): Promise<void> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  // Pinned to the original course unless TRACK names another; a random pick
  // here would make the one race everything else is compared against drift.
  const track = new TrackDefinition(process.env.TRACK ? pickTrack(process.env.TRACK) : DEFAULT_TRACK);
  console.log(`course           ${track.name}`);
  const scene = new THREE.Scene();
  const built = buildTrack(physics, scene, track, surfaces);

  assertTrackFacesUp(built.group);

  let lowest = Infinity;
  for (const p of track.samplePoints) lowest = Math.min(lowest, p.y);
  const voidFallY = lowest - VOID_FALL_MARGIN;

  // Every slot is AI here — the player's seat is filled by the autopilot
  // personality, which is exactly what the "AI-only race" check needs.
  const personalities = [...OPPONENT_PERSONALITIES, AUTOPILOT_PERSONALITY];
  const racers: Racer[] = [];
  const racerByCollider = new Map<number, Racer>();

  for (let slot = 0; slot < personalities.length; slot++) {
    const personality = personalities[slot];
    const row = Math.floor(slot / GRID_COLUMNS);
    const lateral = slot % GRID_COLUMNS === 0 ? -GRID_LATERAL : GRID_LATERAL;
    const distance = track.startDistance - row * GRID_ROW_GAP;

    const bike = new Bike(
      physics,
      surfaces,
      scene,
      track.spawnPoint(distance, lateral, 1.0),
      track.spawnRotation(distance),
      personality.color,
    );
    const rider = new RiderStateMachine(physics, scene, bike, personality.color);
    const racer = new Racer(bike, personality.name, false, personality.color, rider);
    racer.updateTrackPosition(track);
    racers.push(racer);
    racerByCollider.set(bike.controller.chassisCollider.handle, racer);
  }

  for (let i = 0; i < racers.length; i++) {
    racers[i].driver = new OpponentAI(racers[i], track, racers, personalities[i]);
  }

  // Knock one rider off mid-race, so the fall/recovery cycle is exercised
  // inside a real race rather than only in isolation. They must still finish.
  const KNOCKDOWN_AT = 20;
  const knockdownVictim = racers[1];
  let knockedDown = false;
  let knockdownRescues = 0;

  const rescues = new Map<string, number>();
  let elapsed = 0;
  let finished = 0;
  const maxOffroad: Record<string, number> = {};
  const topSpeed: Record<string, number> = {};

  while (finished < racers.length && elapsed < TIMEOUT_SECONDS) {
    for (const racer of racers) racer.tickDriver(FIXED_DT);
    for (const racer of racers) racer.bike.prePhysicsStep(FIXED_DT);
    physics.step();
    for (const racer of racers) racer.bike.postPhysicsStep();

    elapsed += FIXED_DT;
    const graceElapsed = elapsed > STUCK_GRACE_SECONDS;

    if (!knockedDown && elapsed >= KNOCKDOWN_AT && knockdownVictim.rider.isRiding) {
      knockedDown = true;
      const impulse = new THREE.Vector3()
        .copy(LOCAL_RIGHT)
        .applyQuaternion(knockdownVictim.bike.worldQuaternion)
        .multiplyScalar(250)
        .addScaledVector(WORLD_UP, 250 * 0.35);
      knockdownVictim.rider.knockOff(impulse);
      console.log(
        `  [knockdown] ${knockdownVictim.name} thrown off at ` +
          `${(Math.abs(knockdownVictim.bike.forwardSpeed) * 3.6).toFixed(0)} km/h, t=${elapsed.toFixed(1)}s`,
      );
    }

    for (const racer of racers) {
      racer.updateTrackPosition(track);
      if (racer.hasFinished) continue;
      {
        maxOffroad[racer.name] = Math.max(maxOffroad[racer.name] ?? 0, Math.abs(racer.lateralOffset));
        topSpeed[racer.name] = Math.max(topSpeed[racer.name] ?? 0, racer.bike.forwardSpeed);
      }
      const fell = racer.bike.worldPosition.y <= voidFallY;
      if (fell || racer.updateStuck(FIXED_DT, graceElapsed)) {
        const rescueDistance = THREE.MathUtils.clamp(
          racer.distanceAlong - 5,
          track.startDistance,
          track.finishDistance,
        );
        racer.bike.controller.respawnAt(
          track.spawnPoint(rescueDistance, 0, 1.5),
          track.spawnRotation(rescueDistance),
        );
        racer.resetProjection();
        rescues.set(racer.name, (rescues.get(racer.name) ?? 0) + 1);
        // A rescue of the rider we threw off, soon after we threw them, is
        // the rescue system catching a knockdown that carried them off the
        // world — expected on a fast sweeper, and not a driving failure.
        if (racer === knockdownVictim && knockedDown && elapsed - KNOCKDOWN_AT < 30) knockdownRescues++;
        console.log(
          `  [rescue] ${racer.name.padEnd(10)} ${fell ? "fell off world" : "stuck         "} ` +
            `at ${racer.distanceAlong.toFixed(0)}m, ` +
            `off-centre ${racer.lateralOffset.toFixed(1)}m, ` +
            `corner R=${track.cornerRadiusAt(racer.distanceAlong).toFixed(0)}m, ` +
            `t=${elapsed.toFixed(1)}s`,
        );
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

  // --- report -------------------------------------------------------------
  const order = [...racers].sort((a, b) => {
    if (a.hasFinished && b.hasFinished) return a.finishPosition - b.finishPosition;
    if (a.hasFinished) return -1;
    if (b.hasFinished) return 1;
    return b.distanceAlong - a.distanceAlong;
  });

  console.log(`race length      ${track.raceLength.toFixed(0)} m`);
  console.log(`simulated        ${elapsed.toFixed(1)} s\n`);
  console.log("pos  rider      time      top speed   max off-centre   rescues");
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    const time = r.hasFinished ? `${r.raceTime.toFixed(1)}s` : "DNF";
    console.log(
      `  ${i + 1}  ${r.name.padEnd(10)} ${time.padEnd(9)} ` +
        `${(topSpeed[r.name] * 3.6).toFixed(0).padStart(3)} km/h     ` +
        `${(maxOffroad[r.name] ?? 0).toFixed(1).padStart(5)} m        ` +
        `${rescues.get(r.name) ?? 0}`,
    );
  }

  // --- checks -------------------------------------------------------------
  const failures: string[] = [];
  const dnf = racers.filter((r) => !r.hasFinished);
  if (dnf.length > 0) failures.push(`${dnf.length} rider(s) did not finish: ${dnf.map((r) => r.name).join(", ")}`);

  const times = racers.filter((r) => r.hasFinished).map((r) => r.raceTime);
  if (times.length > 1) {
    const spread = Math.max(...times) - Math.min(...times);
    console.log(`\nfinishing spread ${spread.toFixed(1)}s (want > 1s, so the order isn't a lockstep procession)`);
    if (spread < 1) failures.push(`Finishing times span only ${spread.toFixed(1)}s — the bots are driving identically.`);
  }

  const stillDown = racers.filter((r) => !r.rider.isRiding);
  if (stillDown.length > 0) {
    failures.push(`${stillDown.length} rider(s) ended the race off their bike: ${stillDown.map((r) => r.name).join(", ")}`);
  }
  const leakedBodies = racers.filter((r) => r.rider.ragdollBodyCount !== 0);
  if (leakedBodies.length > 0) {
    failures.push(`Ragdoll bodies leaked for: ${leakedBodies.map((r) => r.name).join(", ")}`);
  }
  console.log(
    `knockdown        ${knockdownVictim.name} was thrown off at ${KNOCKDOWN_AT}s and ` +
      `${knockdownVictim.hasFinished ? `still finished P${knockdownVictim.finishPosition}` : "DID NOT FINISH"}`,
  );

  const totalRescues = [...rescues.values()].reduce((a, b) => a + b, 0) - knockdownRescues;
  console.log(
    `total rescues    ${totalRescues} (want 0; each one is a bot that got stuck or fell off)` +
      (knockdownRescues ? `  + ${knockdownRescues} of the knocked-down rider, who was carried off the world by the fall — allowed` : ""),
  );
  if (totalRescues > 0) {
    failures.push(`${totalRescues} rescue(s) needed — bots are getting stuck or leaving the world.`);
  }

  console.log("");
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log("PASS  AI-only race completed cleanly.");
}

void main();
