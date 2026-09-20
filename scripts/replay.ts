import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { Bike } from "../src/entities/Bike";
import { FIXED_DT } from "../src/core/Clock";
import { LOCAL_FORWARD, LOCAL_RIGHT } from "../src/utils/Directions";
import { DEFAULT_TRACK, pickTrack } from "../src/track/tracks";

/**
 * Replays a telemetry log against the real track: the bike is placed where
 * the log says it was, at the logged speed and heading, and then driven with
 * the logged throttle and steer inputs. If the physics is deterministic in
 * the ways that matter, the replay reproduces what the player saw — and then
 * a fix can be tried against the exact incident rather than a guess at it.
 *
 *   npm run sim:replay                          # every incident in scripts/fixtures/, as a regression check
 *   npm run sim:replay latest                   # newest logs/telemetry-*.csv, from 2.5 s before its first spin
 *   FROM=17 TO=22 npm run sim:replay path.csv   # one file, explicit window
 *   TRACK=Hillclimb npm run sim:replay path.csv # override the course (logs since Sep 2026 record it; older ones are Ridgeway)
 *
 * The fixtures are real logs of real incidents the user hit — spins, and a
 * nitro jump that landed badly; each must replay as a recovered slide (peak
 * slip under 30°) for the check to pass.
 */
interface Row {
  t: number; speed: number; heading: number; throttle: number; steer: number;
  yaw: number; slip: number; latA: number; x: number; y: number; z: number; dist: number; surfF: string; surfR: string;
  nitro: boolean;
  track: string;
}

function loadLog(path: string): Row[] {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const col = (name: string): number => header.indexOf(name);
  const c = {
    t: col("t"), speed: col("speed_kmh"), heading: col("heading_deg"), throttle: col("throttle_in"), steer: col("steer_in"),
    yaw: col("yaw_rate_rads"), slip: col("slip_deg"), latA: col("lat_accel_ms2"), x: col("x"), y: col("y"), z: col("z"), dist: col("dist_along_m"),
    surfF: col("surface_front"), surfR: col("surface_rear"), nitro: col("nitro"), track: col("track"),
  };
  return lines.slice(1).map((line) => {
    const f = line.split(",");
    return {
      t: +f[c.t], speed: +f[c.speed] / 3.6, heading: THREE.MathUtils.degToRad(+f[c.heading]), throttle: +f[c.throttle], steer: +f[c.steer],
      yaw: +f[c.yaw], slip: +f[c.slip], latA: +f[c.latA], x: +f[c.x], y: +f[c.y], z: +f[c.z], dist: +f[c.dist], surfF: f[c.surfF], surfR: f[c.surfR],
      nitro: c.nitro >= 0 && +f[c.nitro] === 1, track: c.track >= 0 ? f[c.track] : "",
    };
  });
}

/** Slip beyond this in a replay counts as a spin rather than a slide. */
const SPIN_SLIP_DEG = 30;

async function replayOne(path: string): Promise<{ recordedPeakYaw: number; peakYaw: number; peakSlip: number }> {
  const rows = loadLog(path);

  const firstSpin = rows.findIndex((r) => Math.abs(r.yaw) > 0.95 || Math.abs(r.slip) > 20);
  const from = process.env.FROM ? +process.env.FROM : Math.max(0, (firstSpin >= 0 ? rows[firstSpin].t : rows[0].t) - 2.5);
  const to = process.env.TO ? +process.env.TO : from + 6;
  const window = rows.filter((r) => r.t >= from - 1e-6 && r.t <= to + 1e-6);
  if (window.length < 5) { console.log(`window ${from}..${to} s has too few rows`); process.exit(2); }
  const start = window[0];

  const physics = await PhysicsWorld.create();
  const surfaces = new SurfaceRegistry();
  // No name at all means the log predates the `track` column, and every one
  // of those was recorded on the default course. `pickTrack` without a name
  // draws at random, which is not what a regression check wants.
  const trackName = process.env.TRACK || start.track;
  const track = new TrackDefinition(trackName ? pickTrack(trackName) : DEFAULT_TRACK);
  const scene = new THREE.Scene();
  buildTrack(physics, scene, track, surfaces);

  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), start.heading);
  const bike = new Bike(physics, surfaces, scene, new THREE.Vector3(start.x, start.y, start.z), q);
  // Tuning overrides for experiments: DAMPING=8 STIFFNESS=32 npm run sim:replay
  const tuning = bike.controller.tuning;
  if (process.env.DAMPING) tuning.suspensionDamping = +process.env.DAMPING;
  if (process.env.STIFFNESS) tuning.suspensionStiffness = +process.env.STIFFNESS;
  if (process.env.RECOVERY) tuning.slipRecoveryTorque = +process.env.RECOVERY;
  if (process.env.LOADCOMP) tuning.loadCompensationMax = +process.env.LOADCOMP;
  if (process.env.RECOVERY || process.env.LOADCOMP) console.log(`override: slipRecoveryTorque=${tuning.slipRecoveryTorque} loadCompensationMax=${tuning.loadCompensationMax}`);
  if (process.env.DAMPING || process.env.STIFFNESS) {
    bike.controller.applyWheelTuning();
    console.log(`override: suspensionStiffness=${tuning.suspensionStiffness} suspensionDamping=${tuning.suspensionDamping}`);
  }
  const quiet = !!process.env.QUIET;
  const body = bike.controller.chassisBody;
  const dir = LOCAL_FORWARD.clone().applyQuaternion(q);
  // The logged speed is the whole velocity, vertical included; the climb
  // rate comes from the next row's height, so a bike that starts on a slope
  // or in the air (a jump replayed from before it landed) carries it.
  const vy = THREE.MathUtils.clamp((window[1].y - start.y) / (window[1].t - start.t), -start.speed, start.speed);
  const horizontal = Math.sqrt(Math.max(0, start.speed * start.speed - vy * vy));
  body.setLinvel({ x: dir.x * horizontal, y: vy, z: dir.z * horizontal }, true);

  console.log(`replaying ${path} on ${track.name}`);
  console.log(`from t=${start.t} s: ${(start.speed * 3.6).toFixed(0)} km/h at (${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}), dist ${start.dist} m, heading ${THREE.MathUtils.radToDeg(start.heading).toFixed(0)} deg\n`);
  console.log("             ---- recorded ----          ---- replay ----                       ---- wheels: front | rear ----");
  console.log("   t  thr str    km/h   latA   yaw   slip      km/h   latA   yaw   slip   surf        suspN  len   side  fwd  tilt | suspN  len   side  fwd  tilt");
  const raw = bike.controller as unknown as { vehicle: import("@dimforge/rapier3d-compat").DynamicRayCastVehicleController };
  const wheelInfo = (i: number): string => {
    const veh = raw.vehicle;
    const n = veh.wheelContactNormal(i);
    const tilt = n ? THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, n.y)))) : NaN;
    const f = (x: number | null | undefined, d = 0): string => (x === null || x === undefined ? "  -" : x.toFixed(d)).padStart(5);
    return `${f(veh.wheelSuspensionForce(i))} ${f(veh.wheelSuspensionLength(i), 2)} ${f(veh.wheelSideImpulse(i), 1)} ${f(veh.wheelForwardImpulse(i), 1)} ${f(tilt, 1)}`;
  };

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), vel = new THREE.Vector3(), rq = new THREE.Quaternion();
  let peakYaw = 0, peakSlip = 0;
  // Two settle steps so the suspension finds the road before inputs begin.
  for (let i = 0; i < 2; i++) { bike.setInput(0, 0); bike.prePhysicsStep(FIXED_DT); physics.step(); bike.postPhysicsStep(); }

  for (let k = 0; k < window.length - 1; k++) {
    const row = window[k];
    const stepsThisRow = Math.round((window[k + 1].t - row.t) / FIXED_DT);
    for (let i = 0; i < stepsThisRow; i++) {
      bike.setInput(row.throttle, row.steer);
      bike.controller.setBoost(row.nitro);
      bike.prePhysicsStep(FIXED_DT); physics.step(); bike.postPhysicsStep();
    }
    const r = body.rotation(); rq.set(r.x, r.y, r.z, r.w);
    fwd.copy(LOCAL_FORWARD).applyQuaternion(rq); right.copy(LOCAL_RIGHT).applyQuaternion(rq);
    const v = body.linvel(); vel.set(v.x, 0, v.z);
    const slip = vel.length() > 0.5 ? THREE.MathUtils.radToDeg(Math.atan2(vel.dot(right), vel.dot(fwd))) : 0;
    const ctl = bike.controller;
    peakYaw = Math.max(peakYaw, Math.abs(ctl.yawRate)); peakSlip = Math.max(peakSlip, Math.abs(slip));
    const next = window[k + 1];
    if (!quiet) console.log(
      `${next.t.toFixed(1).padStart(5)}  ${row.throttle.toFixed(0)} ${row.steer.toFixed(0).padStart(3)}   ` +
        `${(next.speed * 3.6).toFixed(0).padStart(5)} ${next.latA.toFixed(1).padStart(6)} ${next.yaw.toFixed(2).padStart(6)} ${next.slip.toFixed(0).padStart(5)}     ` +
        `${(vel.length() * 3.6).toFixed(0).padStart(5)} ${ctl.lateralAcceleration.toFixed(1).padStart(6)} ${ctl.yawRate.toFixed(2).padStart(6)} ${slip.toFixed(0).padStart(5)}   ` +
        `${ctl.wheelSurfaceName(0).slice(0, 4)}/${ctl.wheelSurfaceName(1).slice(0, 4)}   ${wheelInfo(0)} | ${wheelInfo(1)}`,
    );
  }
  const recordedPeak = Math.max(...window.map((r) => Math.abs(r.yaw)));
  console.log(`\nrecorded peak yaw ${recordedPeak.toFixed(2)} rad/s;  replay peak yaw ${peakYaw.toFixed(2)} rad/s, peak slip ${peakSlip.toFixed(0)} deg  =>  ${peakSlip > SPIN_SLIP_DEG ? "SPUN" : "held (slide recovered)"}`);
  return { recordedPeakYaw: recordedPeak, peakYaw, peakSlip };
}

async function main(): Promise<void> {
  const arg = process.argv[3];
  const { readdirSync } = await import("node:fs");
  let paths: string[];
  if (arg === "latest") {
    const files = readdirSync("logs").filter((f) => f.startsWith("telemetry-") && f.endsWith(".csv")).sort();
    if (!files.length) { console.log("no logs/telemetry-*.csv"); process.exit(0); }
    paths = [resolve("logs", files[files.length - 1])];
  } else if (arg) {
    paths = [resolve(arg)];
  } else {
    paths = readdirSync(resolve("scripts/fixtures")).filter((f) => f.endsWith(".csv")).sort().map((f) => resolve("scripts/fixtures", f));
  }

  let failed = 0;
  for (const path of paths) {
    const r = await replayOne(path);
    if (r.peakSlip > SPIN_SLIP_DEG) failed++;
  }
  if (paths.length > 1 || !arg) {
    console.log(failed ? `\nFAIL  ${failed} of ${paths.length} recorded incidents still spin.` : `\nPASS  all ${paths.length} recorded incidents replay as recovered slides.`);
    process.exit(failed ? 1 : 0);
  }
}
void main();
