import { TrackDefinition } from "../src/track/TrackDefinition";
import { DEFAULT_VEHICLE_CONFIG } from "../src/physics/VehicleController";

/**
 * Vertical profile of a stretch of track: grade, and the vertical radius of
 * curvature — the thing that loads and unloads the suspension at speed.
 * A dip of vertical radius R at speed v adds v^2/R to the wheel load; the
 * suspension bottoms once that exceeds what its travel can take.
 *
 *   FROM=500 TO=650 SPEED=100 npm run sim:profile
 */
const track = new TrackDefinition();
const FROM = +(process.env.FROM ?? 480);
const TO = +(process.env.TO ?? 700);
const SPEED = +(process.env.SPEED ?? 100) / 3.6;
const STEP = 5;

const cfg = DEFAULT_VEHICLE_CONFIG;
const g = 9.81;
// Static compression per wheel at rest, in Rapier's spring units (force = stiffness * compression * mass).
const staticCompression = (g / 2) / cfg.suspensionStiffness;
const spare = cfg.maxSuspensionTravel - staticCompression;
console.log(`suspension: stiffness ${cfg.suspensionStiffness}, travel ${cfg.maxSuspensionTravel} m, static compression ${staticCompression.toFixed(3)} m, spare ${spare.toFixed(3)} m`);
console.log(`bottoms out when extra vertical acceleration exceeds ${(spare * cfg.suspensionStiffness * 2).toFixed(1)} m/s^2 (${(spare * cfg.suspensionStiffness * 2 / g).toFixed(2)} g)\n`);
console.log(`at ${(SPEED * 3.6).toFixed(0)} km/h:`);
console.log("  dist     y    grade%   vertR(m)   load change   ");
let worst = { d: 0, a: 0 };
for (let d = FROM; d <= TO; d += STEP) {
  const y0 = track.spawnPoint(d - STEP, 0, 0).y;
  const y1 = track.spawnPoint(d, 0, 0).y;
  const y2 = track.spawnPoint(d + STEP, 0, 0).y;
  const grade = (y2 - y0) / (2 * STEP);
  const curvature = (y2 - 2 * y1 + y0) / (STEP * STEP); // d2y/ds2, + = concave up (dip/foot of climb)
  const radius = Math.abs(curvature) > 1e-6 ? 1 / Math.abs(curvature) : Infinity;
  const accel = SPEED * SPEED * curvature; // + presses the bike into the road
  if (Math.abs(accel) > Math.abs(worst.a)) worst = { d, a: accel };
  console.log(`${d.toFixed(0).padStart(6)} ${y1.toFixed(2).padStart(7)} ${(grade * 100).toFixed(1).padStart(7)} ${(Number.isFinite(radius) ? radius.toFixed(0) : "flat").padStart(10)} ${(accel >= 0 ? "+" : "") + accel.toFixed(1).padStart(5)} m/s^2 ${accel > spare * cfg.suspensionStiffness * 2 ? "  <-- BOTTOMS OUT" : accel < -g ? "  <-- AIRBORNE" : ""}`);
}
console.log(`\nworst at ${worst.d} m: ${worst.a.toFixed(1)} m/s^2 (${(worst.a / g).toFixed(2)} g)`);
