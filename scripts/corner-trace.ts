import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { Racer } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { OpponentAI } from "../src/ai/OpponentAI";
import { OPPONENT_PERSONALITIES } from "../src/ai/RiderPersonality";
import { FIXED_DT } from "../src/core/Clock";

/** Follows a single bot through one named stretch of track, printing why it does what it does. */
const FROM = Number(process.env.FROM ?? 480);
const TO = Number(process.env.TO ?? 720);

async function main(): Promise<void> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition();
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);

  const p = OPPONENT_PERSONALITIES[1];
  const bike = new Bike(physics, surfaces, scene,
    track.spawnPoint(track.startDistance, 0, 1.0),
    track.spawnRotation(track.startDistance), p.color);
  const racer = new Racer(bike, p.name, false, p.color, new RiderStateMachine(physics, scene, bike, p.color));
  racer.updateTrackPosition(track);
  const field = [racer];
  racer.driver = new OpponentAI(racer, track, field, p);

  console.log(`tracing ${p.name} from ${FROM}m to ${TO}m (cornering confidence ${p.corneringConfidence})`);
  console.log("  t    dist    lat   speed  wantSpeed  cornerR  steerIn  steerAng  limit  surface");

  let step = 0;
  let lastPrint = -1;
  while (racer.distanceAlong < TO && step < 60 * 200) {
    racer.tickDriver(FIXED_DT);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
    racer.updateTrackPosition(track);
    step++;

    const t = step * FIXED_DT;
    if (racer.distanceAlong >= FROM && t - lastPrint >= 0.25) {
      lastPrint = t;
      const want = track.speedLimitAhead(racer.distanceAlong, p.corneringConfidence, 6.5, 160);
      const radius = track.cornerRadiusAt(racer.distanceAlong);
      console.log(
        `${t.toFixed(1).padStart(5)} ${racer.distanceAlong.toFixed(0).padStart(6)} ` +
        `${racer.lateralOffset.toFixed(1).padStart(6)} ${(bike.forwardSpeed * 3.6).toFixed(0).padStart(5)} ` +
        `${(Math.min(want, 40) * 3.6).toFixed(0).padStart(9)} ` +
        `${(Number.isFinite(radius) ? radius.toFixed(0) : "inf").padStart(8)} ` +
        `${bike.controller.debugInputs.steer.toFixed(2).padStart(7)} ` +
        `${THREE.MathUtils.radToDeg(bike.controller.steerAngle).toFixed(1).padStart(8)} ` +
        `${THREE.MathUtils.radToDeg(bike.controller.steerLimit).toFixed(1).padStart(6)}  ` +
        `${bike.controller.surfaceName}`);
    }
  }
}
void main();
