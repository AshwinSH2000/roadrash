import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { Racer } from "../src/entities/Racer";
import { RiderStateMachine } from "../src/entities/RiderStateMachine";
import { StuntSystem } from "../src/entities/StuntSystem";
import { OPPONENT_PERSONALITIES } from "../src/ai/RiderPersonality";
import { TRACKS } from "../src/track/tracks";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD } from "../src/utils/Directions";
import { CameraRig, CAMERA_MODES, type CameraMode } from "../src/camera/CameraRig";

/**
 * Drives the bike round the Daredevil Run's loop and checks, in every camera
 * mode, that the camera stays sane: finite, near the bike, looking roughly at
 * or along its way, and never jumping far between frames.
 *
 * Run with: node scripts/run-sim.mjs camera
 */
const layout = TRACKS.find((t) => t.name === "Daredevil Run")!;

interface Stat { frames: number; bad: number; maxDist: number; maxJump: number; minFov: number; maxFov: number; lookOff: number; maxRoll: number }

async function ride(mode: CameraMode): Promise<Stat> {
  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  const track = new TrackDefinition(layout);
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);
  const loop = track.featuresOfKind("loop")[0];
  const p = OPPONENT_PERSONALITIES[0];
  const start = loop.startDistance - 60;
  const rotation = track.spawnRotation(start);
  const bike = new Bike(physics, surfaces, scene, track.spawnPoint(start, 0, 1.0), rotation, p.color);
  const rider = new RiderStateMachine(physics, scene, bike, p.color);
  const racer = new Racer(bike, p.name, false, p.color, rider);
  racer.updateTrackPosition(track);
  const dir = LOCAL_FORWARD.clone().applyQuaternion(rotation).multiplyScalar(36);
  bike.controller.chassisBody.setLinvel({ x: dir.x, y: dir.y, z: dir.z }, true);
  const stunts = new StuntSystem(track);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const rig = new CameraRig(camera, physics, track);
  while (rig.mode !== mode) rig.cycle();

  const st: Stat = { frames: 0, bad: 0, maxDist: 0, maxJump: 0, minFov: 999, maxFov: 0, lookOff: 0, maxRoll: 0 };
  const forward = new THREE.Vector3();
  let last: THREE.Vector3 | null = null;
  for (let i = 0; i < 60 * 9; i++) {
    racer.rider.tick(FIXED_DT);
    bike.setInput(1, 0);
    bike.prePhysicsStep(FIXED_DT);
    physics.step();
    bike.postPhysicsStep();
    stunts.update([racer]);
    racer.updateTrackPosition(track);
    bike.syncRender(1, FIXED_DT);
    racer.rider.syncRender(1);
    rig.update(bike, rider.cameraPosition, FIXED_DT, { riding: rider.isRiding, distanceAlong: racer.distanceAlong });
    camera.updateMatrixWorld(true);
    st.frames++;
    const pos = camera.position;
    if (![pos.x, pos.y, pos.z, camera.fov].every(Number.isFinite)) st.bad++;
    const toBike = bike.worldPosition.clone().sub(pos);
    st.maxDist = Math.max(st.maxDist, toBike.length());
    if (last) st.maxJump = Math.max(st.maxJump, last.distanceTo(pos));
    last = pos.clone();
    st.minFov = Math.min(st.minFov, camera.fov);
    st.maxFov = Math.max(st.maxFov, camera.fov);
    camera.getWorldDirection(forward);
    if (toBike.length() > 0.5 && mode !== "helmet" && mode !== "bumper") {
      st.lookOff = Math.max(st.lookOff, (forward.angleTo(toBike.normalize()) * 180) / Math.PI);
    }
    // How far the picture is tilted from level: the angle between the camera's up and world up.
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    st.maxRoll = Math.max(st.maxRoll, (camUp.angleTo(new THREE.Vector3(0, 1, 0)) * 180) / Math.PI);
  }
  return st;
}

console.log("Daredevil Run, 9 s through the loop, full throttle, one mode at a time");
console.log("mode        bad  farthest from bike  biggest jump  fov range     worst off-aim  max tilt");
for (const mode of CAMERA_MODES) {
  const st = await ride(mode);
  console.log(
    `  ${mode.padEnd(10)} ${String(st.bad).padStart(3)}  ${st.maxDist.toFixed(1).padStart(10)} m      ${st.maxJump.toFixed(1).padStart(6)} m     ${st.minFov.toFixed(0)}-${st.maxFov.toFixed(0)} deg   ${st.lookOff.toFixed(0).padStart(6)} deg    ${st.maxRoll.toFixed(0)} deg`,
  );
}
