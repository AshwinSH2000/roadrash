import * as THREE from "three";
import { LoopGeometry, LOOP_FULL_TURN, type LoopFrame } from "../track/TrackFeatures";
import { ROAD_HALF_WIDTH } from "../track/TrackDefinition";

/**
 * A bike riding the inside of a vertical loop — now under real physics.
 *
 * The chassis is an ordinary dynamic body with pitch and roll unlocked, the
 * wheels' suspension rays find the loop's collider, and the road pushes the
 * bike round the circle the way it would any vehicle: speed trades for
 * height through gravity, the suspension squashes under the centripetal load,
 * and a bike that is too slow simply loses contact at the top and falls.
 *
 * What this class does is the part a rider does. It follows the bike round
 * the path (loop angle, sideways position, speed, felt g-force) and works out
 * the attitude the chassis should hold — nose along the path, wheels down
 * onto the ribbon, turned a little toward where the rider is steering — which
 * `VehicleController` turns into a balancing torque. A two-wheeler has no
 * balance of its own, and a ribbon that drifts sideways as it climbs has to
 * be steered along, so the bike cannot be left to hold either by itself.
 *
 * The ride ends in one of three ways: the bike reaches the exit (completed),
 * or it loses the road — no wheel down for a moment, stalled on the climb, or
 * off the side of the ribbon (failed).
 */

const GRAVITY = 9.81;
/** Sideways speed the rider can move the target line across the ribbon at full steering, m/s. */
const LANE_SPEED = 5.5;
/** The target line stays at least this far inside the ribbon's edge, metres. */
const EDGE_MARGIN = 1;
/** Heading change, radians, asked for per metre the bike is off its target line. */
const STEER_PER_METRE = 0.12;
/** Heading change, radians, asked for per m/s of sideways drift. */
const STEER_PER_DRIFT = 0.1;
/** The most the nose may point away from the path to correct the line, radians. */
const MAX_CRAB = 0.45;
/** Below this speed on the climb the bike has stalled and rolls back off the track. */
const STALL_SPEED = 3;
/** Seconds with no wheel on the road before the ride counts as lost. */
const AIRBORNE_LIMIT = 0.3;
/**
 * Metres off the ribbon, along its normal, beyond which a bike with no wheel
 * down has really left it. The chassis rides about 1.1 m up; the wheels flick
 * off the road for a moment at a time under the loop's load without the bike
 * actually coming away.
 */
const LOST_HEIGHT = 2.2;
/** Metres past the ribbon's edge (the chassis centre) at which the bike has left it. */
const OFF_RIBBON = 0.4;
/** Loop angle at which the ride hands over to the road, a hair short of the exit. */
const HANDOVER_THETA = LOOP_FULL_TURN - 0.03;

export type LoopRideStatus = "riding" | "completed" | "failed";

export class LoopRide {
  readonly geometry: LoopGeometry;
  /** Loop angle, 0 at the entry to 2pi at the exit. */
  theta = 0;
  /** Speed along the track, m/s. */
  speed: number;
  /** The rider's felt g-force. */
  gForce = 1;
  status: LoopRideStatus = "riding";
  /** True when the ride ended because the bike left the side of the ribbon. */
  fellOffEdge = false;
  /** Metres right of the ribbon's centre, as measured on the bike. */
  lateral: number;

  /** Where the rider wants the bike to be across the ribbon. */
  private targetLateral: number;
  private lateralVelocity = 0;
  private airborneTime = 0;
  private readonly frame: LoopFrame = LoopGeometry.createFrame();
  private readonly tmpOffset = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpLeft = new THREE.Vector3();
  private readonly tmpMatrix = new THREE.Matrix4();

  /** @param lateral metres right of the road centre at the moment of entry. */
  constructor(geometry: LoopGeometry, entrySpeed: number, lateral: number) {
    this.geometry = geometry;
    this.speed = entrySpeed;
    this.lateral = lateral;
    this.targetLateral = lateral;
    this.geometry.frame(0, this.frame);
  }

  get progress(): number {
    return THREE.MathUtils.clamp(this.theta / LOOP_FULL_TURN, 0, 1);
  }

  /**
   * Reads the bike's actual position and velocity after a physics step and
   * decides whether the ride goes on. `wheelsDown` is how many wheels touch
   * the road; `steer` is -1..1, positive to the right.
   */
  observe(dt: number, position: THREE.Vector3, velocity: THREE.Vector3, wheelsDown: number, steer: number): LoopRideStatus {
    if (this.status !== "riding") return this.status;

    // Find the bike's loop angle: a few Newton steps from the last one.
    for (let i = 0; i < 3; i++) {
      this.geometry.frame(this.theta, this.frame);
      this.tmpOffset.subVectors(position, this.frame.position);
      this.theta += this.tmpOffset.dot(this.frame.tangent) / this.frame.speedFactor;
      this.theta = THREE.MathUtils.clamp(this.theta, 0, LOOP_FULL_TURN);
    }
    this.geometry.frame(this.theta, this.frame);
    this.tmpOffset.subVectors(position, this.frame.position);

    const lateral = this.tmpOffset.dot(this.geometry.across);
    this.lateralVelocity = (lateral - this.lateral) / dt;
    this.lateral = lateral;
    this.speed = velocity.dot(this.frame.tangent);

    const limit = ROAD_HALF_WIDTH - EDGE_MARGIN;
    this.targetLateral = THREE.MathUtils.clamp(this.targetLateral + THREE.MathUtils.clamp(steer, -1, 1) * LANE_SPEED * dt, -limit, limit);

    const normalForce = Math.max(0, this.speed * this.speed * this.frame.curvature + GRAVITY * this.frame.normal.y);
    this.gForce = normalForce / GRAVITY;

    if (this.theta >= HANDOVER_THETA) {
      this.gForce = 1;
      this.status = "completed";
      return this.status;
    }

    this.airborneTime = wheelsDown > 0 ? 0 : this.airborneTime + dt;
    const midRide = this.theta > 0.15;
    if (Math.abs(lateral) > ROAD_HALF_WIDTH + OFF_RIBBON) {
      this.fellOffEdge = true;
      this.status = "failed";
    } else if (midRide && this.airborneTime > AIRBORNE_LIMIT && this.tmpOffset.dot(this.frame.normal) > LOST_HEIGHT) {
      this.status = "failed";
    } else if (this.speed < STALL_SPEED && this.theta > 0.3) {
      this.status = "failed";
    }
    return this.status;
  }

  /**
   * The push the road must give the bike to hold it on the circle, as an
   * acceleration along the inward normal: `v^2 k + g n_y`, the centripetal
   * term plus gravity's share. Zero or less means the road would have to
   * pull the bike down onto it — it cannot, so the bike leaves.
   */
  requiredNormalAcceleration(): number {
    const f = this.frame;
    return Math.max(0, this.speed) ** 2 * f.curvature + GRAVITY * f.normal.y;
  }

  /** Unit vector the road pushes along: into the loop. */
  get normal(): THREE.Vector3 {
    return this.frame.normal;
  }

  /** How fast the chassis must turn, world frame, rad/s, just to keep its nose on the path: dT/dt = omega x T = v k N. */
  targetAngularVelocity(out: THREE.Vector3): THREE.Vector3 {
    const f = this.frame;
    return out.crossVectors(f.tangent, f.normal).multiplyScalar(f.curvature * Math.max(0, this.speed));
  }

  /** The attitude the chassis should hold now: nose along the path, turned toward the target line, wheels onto the ribbon. */
  targetAttitude(out: THREE.Quaternion): THREE.Quaternion {
    const f = this.frame;
    const crab = THREE.MathUtils.clamp(
      (this.targetLateral - this.lateral) * STEER_PER_METRE - this.lateralVelocity * STEER_PER_DRIFT,
      -MAX_CRAB,
      MAX_CRAB,
    );
    // Turn the nose toward the target line: across is fixed in the world, so
    // this is the same side whether the bike is upright or upside-down.
    this.tmpForward.copy(this.geometry.across).addScaledVector(f.tangent, -this.geometry.across.dot(f.tangent)).normalize();
    this.tmpForward.multiplyScalar(Math.sin(crab)).addScaledVector(f.tangent, Math.cos(crab));
    // Bike frame: +X left, +Y up, +Z forward; left = up x forward.
    this.tmpLeft.crossVectors(f.normal, this.tmpForward).normalize();
    this.tmpForward.crossVectors(this.tmpLeft, f.normal);
    this.tmpMatrix.makeBasis(this.tmpLeft, f.normal, this.tmpForward);
    return out.setFromRotationMatrix(this.tmpMatrix);
  }
}
