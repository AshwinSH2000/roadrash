import * as THREE from "three";
import type { Racer } from "../entities/Racer";
import type { TrackDefinition } from "../track/TrackDefinition";
import type { Nitro } from "../entities/Nitro";
import { LOCAL_FORWARD, LOCAL_RIGHT } from "../utils/Directions";

/**
 * Ten-times-a-second record of what the player's bike is doing, written to
 * `logs/telemetry-<session>.csv` through the dev server.
 *
 * This exists because a bug was reported that the flat-ground probe could not
 * reproduce — "hold the steer through the long left-hander and it spins" —
 * and the way to find out what is different about the real corner is to have
 * every number from the moment it happens. Press **M** to write a MARK row at
 * the moment of interest; the surrounding seconds are what to read.
 *
 * Dev-only: the browser can't write files, so rows are batched and POSTed to
 * a tiny middleware in `vite.config.ts` that appends them. In a production
 * build there is no server to post to and this stays inert.
 */
const SAMPLE_INTERVAL = 0.1;
const FLUSH_INTERVAL = 1.0;

export const TELEMETRY_COLUMNS = [
  "t",
  "mark",
  "rider",
  "speed_kmh",
  "accel_ms2",
  "lat_accel_ms2",
  "yaw_rate_rads",
  "heading_deg",
  "pitch_deg",
  "roll_deg",
  "lean_deg",
  "slip_deg",
  "throttle_in",
  "steer_in",
  "steer_deg",
  "steer_limit_deg",
  "surface_front",
  "surface_rear",
  "contact_f",
  "contact_r",
  "dist_along_m",
  "off_centre_m",
  "corner_radius_m",
  "nitro",
  "x",
  "y",
  "z",
  // Which course the log was recorded on, so `sim:replay` can rebuild it
  // without being told — a Hillclimb jump replayed on Ridgeway flies
  // through empty air.
  "track",
] as const;

export class Telemetry {
  readonly session = new Date().toISOString().replace(/[:.]/g, "-");
  private sinceSample = 0;
  private sinceFlush = 0;
  private pending: string[] = [];
  private markPending = "";
  private lastSpeed: number | null = null;
  private lastSampleTime = 0;
  private elapsed = 0;
  rowsWritten = 0;
  lastError: string | null = null;

  private readonly q = new THREE.Quaternion();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly euler = new THREE.Euler();

  constructor(
    private readonly player: Racer,
    private readonly track: TrackDefinition,
    private readonly nitro: Nitro,
  ) {
    this.pending.push(TELEMETRY_COLUMNS.join(","));
  }

  /** Flags the next row; shows up in the `mark` column so the moment can be found. */
  mark(label = "MARK"): void {
    this.markPending = label;
  }

  /** Call once per fixed physics step. */
  tick(dt: number): void {
    this.elapsed += dt;
    this.sinceSample += dt;
    this.sinceFlush += dt;
    if (this.sinceSample >= SAMPLE_INTERVAL) {
      this.sinceSample -= SAMPLE_INTERVAL;
      this.pending.push(this.sample());
    }
    if (this.sinceFlush >= FLUSH_INTERVAL) {
      this.sinceFlush = 0;
      void this.flush();
    }
  }

  private sample(): string {
    const bike = this.player.bike;
    const ctl = bike.controller;
    const body = ctl.chassisBody;

    const r = body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    this.fwd.copy(LOCAL_FORWARD).applyQuaternion(this.q);
    this.right.copy(LOCAL_RIGHT).applyQuaternion(this.q);
    const v = body.linvel();
    this.vel.set(v.x, v.y, v.z);

    const speed = bike.forwardSpeed;
    const dt = this.elapsed - this.lastSampleTime;
    const accel = this.lastSpeed === null || dt <= 0 ? 0 : (speed - this.lastSpeed) / dt;
    this.lastSpeed = speed;
    this.lastSampleTime = this.elapsed;

    const heading = THREE.MathUtils.radToDeg(Math.atan2(this.fwd.x, this.fwd.z));
    // Pitch and roll of the physics chassis — locked by design, so any drift
    // here would itself be a finding.
    this.euler.setFromQuaternion(this.q, "YXZ");
    const pitch = THREE.MathUtils.radToDeg(this.euler.x);
    const roll = THREE.MathUtils.radToDeg(this.euler.z);

    const horizontal = this.vel.clone().setY(0);
    const slip =
      horizontal.length() > 0.5
        ? THREE.MathUtils.radToDeg(Math.atan2(horizontal.dot(this.right), horizontal.dot(this.fwd)))
        : 0;

    const inputs = ctl.debugInputs;
    const p = bike.worldPosition;
    const radius = this.track.cornerRadiusAt(this.player.distanceAlong);

    const mark = this.markPending;
    this.markPending = "";

    const f = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "");
    return [
      f(this.elapsed, 1),
      mark,
      this.player.rider.current,
      f(speed * 3.6, 1),
      f(accel),
      f(ctl.lateralAcceleration),
      f(ctl.yawRate, 3),
      f(heading, 1),
      f(pitch, 1),
      f(roll, 1),
      f(THREE.MathUtils.radToDeg(bike.leanAngle), 1),
      f(slip, 1),
      f(inputs.throttle, 1),
      f(inputs.steer, 1),
      f(THREE.MathUtils.radToDeg(ctl.steerAngle), 1),
      f(THREE.MathUtils.radToDeg(ctl.steerLimit), 1),
      ctl.wheelSurfaceName(0),
      ctl.wheelSurfaceName(1),
      ctl.wheelIsGrounded(0) ? "1" : "0",
      ctl.wheelIsGrounded(1) ? "1" : "0",
      f(this.player.distanceAlong, 1),
      f(this.player.lateralOffset),
      Number.isFinite(radius) ? f(radius, 0) : "straight",
      this.nitro.isActive ? "1" : "0",
      f(p.x),
      f(p.y),
      f(p.z),
      this.track.name,
    ].join(",");
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    try {
      const response = await fetch(`/__telemetry?session=${this.session}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: rows.join("\n") + "\n",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.rowsWritten += rows.length;
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error);
    }
  }
}
