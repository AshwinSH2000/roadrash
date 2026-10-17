import * as THREE from "three";
import { LoopGeometry, LOOP_FULL_TURN, type LoopFrame } from "../track/TrackFeatures";
import { ROAD_HALF_WIDTH } from "../track/TrackDefinition";

/**
 * A bike riding the inside of a vertical loop.
 *
 * The chassis physics cannot do this: its pitch and roll are locked (that is
 * what keeps a two-wheeler upright), and the suspension rays only ever look
 * "down" in the chassis frame. So for the length of the loop the bike is a
 * point mass on a rail, and the rail's physics is done properly here:
 *
 *  - Speed along the path changes with gravity's component along it, so the
 *    bike slows climbing and quickens coming down — kinetic and potential
 *    energy trade exactly, less air drag and rolling resistance, plus
 *    whatever the engine or brakes add.
 *  - The track pushes back on the rider with `N = v^2 k + g n_y` per unit
 *    mass (k the path's curvature, n_y how far the inward normal points
 *    up): `v^2 k` is the centripetal term, `g n_y` is gravity's share, which
 *    helps at the bottom and works against it at the top. `N / g` is the
 *    rider's felt g-force: 1 g standing still, about 4 g at the foot of a
 *    gentle loop, and over 10 g flat out at the bottom of this one.
 *  - If `N` reaches zero the bike is no longer pressed to the road. It
 *    leaves the track on the ballistic path it is on — the caller turns that
 *    into a real fall. This is why a loop needs speed: with no engine, a
 *    point mass completes a circle of radius R only above sqrt(5 g R) at the
 *    bottom.
 *
 * Nothing here knows about Rapier: it produces a pose and a velocity each
 * step, and `VehicleController` moves the chassis to it.
 */

const GRAVITY = 9.81;
/** Chassis centre height above the road surface when the bike sits on its suspension. */
const HOVER = 1.08;
/** Air drag per unit mass: 0.5 rho Cd A / m, with ~1.2 kg/m^3, CdA 0.6 m^2, 300 kg rider and bike. */
const DRAG = 0.0012;
/** Rolling resistance per unit mass, m/s^2. */
const ROLLING = 0.15;
/** Engine acceleration at low speed, m/s^2, tapering to nothing at `ENGINE_TOP_SPEED`. */
const ENGINE_ACCEL = 6.5;
const ENGINE_TOP_SPEED = 44;
const BRAKE_DECEL = 9;
/** Below this speed on the climb the bike has stalled and rolls back off the track. */
const STALL_SPEED = 3;
/** Sideways speed across the ribbon at full steering, m/s. */
const LANE_SPEED = 5.5;
/** Seconds for the sideways speed to follow the steering input. */
const LANE_RESPONSE = 0.18;
/** The chassis rides at most this far inside the ribbon's edge, metres. */
const EDGE_MARGIN = 1;
/**
 * Sideways speed, m/s, above which reaching the edge throws the bike off.
 * Slower than this the bike just runs along the lip, so a small correction
 * is safe and only a committed lunge across the ribbon costs the ride.
 */
const EDGE_FALL_SPEED = 4;

export type LoopRideStatus = "riding" | "completed" | "failed";

export class LoopRide {
  readonly geometry: LoopGeometry;
  /** Loop angle, 0 at the entry to 2pi at the exit. */
  theta = 0;
  /** Speed along the track, m/s. */
  speed: number;
  /** The rider's felt g-force. */
  gForce = 1;
  /** Distance travelled, metres — for the wheels' spin. */
  travelled = 0;
  status: LoopRideStatus = "riding";

  /** True when the ride ended because the bike hit the edge fast enough to leave the ribbon. */
  fellOffEdge = false;
  /** Sideways speed the bike carried off the edge, m/s (signed, positive to the right). */
  private edgeSpeed = 0;
  /** Metres right of the ribbon's centre. Steering moves it; it starts where the bike entered. */
  lateral: number;
  private lateralVelocity = 0;
  private readonly frame: LoopFrame = LoopGeometry.createFrame();
  private readonly tmpLeft = new THREE.Vector3();
  private readonly tmpMatrix = new THREE.Matrix4();

  /** @param lateral metres right of the road centre at the moment of entry. */
  constructor(geometry: LoopGeometry, entrySpeed: number, lateral: number) {
    this.geometry = geometry;
    this.speed = entrySpeed;
    this.lateral = lateral;
    this.geometry.frame(0, this.frame);
  }

  get progress(): number {
    return THREE.MathUtils.clamp(this.theta / LOOP_FULL_TURN, 0, 1);
  }

  /**
   * Advances one step. `throttle` is -1 (brake) to 1; `boost` multiplies the
   * engine's push; `steer` is -1..1, positive to the right, and moves the
   * bike across the ribbon (it cannot leave it).
   */
  step(dt: number, throttle: number, boost: number, steer: number): LoopRideStatus {
    if (this.status !== "riding") return this.status;

    const limit = ROAD_HALF_WIDTH - EDGE_MARGIN;
    const wanted = THREE.MathUtils.clamp(steer, -1, 1) * LANE_SPEED;
    this.lateralVelocity += (wanted - this.lateralVelocity) * (1 - Math.exp(-dt / LANE_RESPONSE));
    const wasAtEdge = Math.abs(this.lateral) >= limit - 1e-6;
    this.lateral = THREE.MathUtils.clamp(this.lateral + this.lateralVelocity * dt, -limit, limit);
    if (Math.abs(this.lateral) >= limit && this.lateral * this.lateralVelocity > 0) {
      // Only the arrival at the edge counts; once there, pushing on just slides along the lip.
      if (!wasAtEdge && Math.abs(this.lateralVelocity) > EDGE_FALL_SPEED) {
        this.fellOffEdge = true;
        this.edgeSpeed = this.lateralVelocity;
        this.status = "failed";
        this.geometry.frame(this.theta, this.frame);
        return this.status;
      }
      this.lateralVelocity = 0;
    }

    this.geometry.frame(this.theta, this.frame);
    const drive =
      throttle > 0
        ? ENGINE_ACCEL * boost * throttle * THREE.MathUtils.clamp(1 - this.speed / ENGINE_TOP_SPEED, 0, 1)
        : BRAKE_DECEL * throttle;
    const along = -GRAVITY * this.frame.tangent.y + drive - DRAG * this.speed * this.speed - ROLLING;
    this.speed = Math.max(0, this.speed + along * dt);

    this.theta += (this.speed * dt) / this.frame.speedFactor;
    this.travelled += this.speed * dt;

    if (this.theta >= LOOP_FULL_TURN) {
      this.theta = LOOP_FULL_TURN;
      this.geometry.frame(this.theta, this.frame);
      this.gForce = 1;
      this.status = "completed";
      return this.status;
    }

    this.geometry.frame(this.theta, this.frame);
    const normalForce = this.speed * this.speed * this.frame.curvature + GRAVITY * this.frame.normal.y;
    this.gForce = normalForce / GRAVITY;
    // Contact is lost when the road would have to pull the bike down onto
    // it; and a bike that has stopped on the way up is rolling backwards.
    const stalled = this.speed < STALL_SPEED && this.theta > 0.3;
    if (normalForce <= 0 || stalled) this.status = "failed";
    return this.status;
  }

  /** Chassis pose for the current loop angle. */
  pose(outPosition: THREE.Vector3, outRotation: THREE.Quaternion): void {
    const f = this.frame;
    outPosition
      .copy(f.position)
      .addScaledVector(f.normal, HOVER)
      .addScaledVector(this.geometry.across, this.lateral);

    // Bike frame: +X left, +Y up, +Z forward; left = up x forward.
    this.tmpLeft.crossVectors(f.normal, f.tangent).normalize();
    this.tmpMatrix.makeBasis(this.tmpLeft, f.normal, f.tangent);
    outRotation.setFromRotationMatrix(this.tmpMatrix);
  }

  /** Velocity along the track at the current angle. */
  velocity(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.frame.tangent).multiplyScalar(this.speed);
    if (this.fellOffEdge) out.addScaledVector(this.geometry.across, this.edgeSpeed);
    return out;
  }
}
