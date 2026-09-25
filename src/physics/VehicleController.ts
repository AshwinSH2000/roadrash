import * as THREE from "three";
import { LOCAL_FORWARD, LOCAL_RIGHT } from "../utils/Directions";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld";
import { DEFAULT_SURFACE, SurfaceRegistry, type SurfaceProperties } from "./TerrainMaterial";
import { GROUPS_BIKE, GROUPS_WHEEL_RAY } from "./CollisionGroups";
import { Transmission, type TransmissionMode } from "./Transmission";

/**
 * "Arcade-sim hybrid" motorcycle physics: Rapier's built-in raycast vehicle
 * controller (a port of Bullet's btRaycastVehicle) drives two centerline
 * wheels (front/rear) for suspension, traction and braking. A 2-wheel
 * centerline vehicle has no inherent roll or pitch stability of its own —
 * rather than fighting that with a reactive torque spring (tried first;
 * proved fragile, see PROGRESS.md Phase 1), the chassis's pitch and roll
 * rotational freedom is locked outright via Rapier's `enabledRotations`, so
 * it is physically incapable of tipping or wheelieing no matter what force
 * acts on it. Only yaw (steering) is free.
 *
 * A consequence of that lock: the chassis stays level while the road slopes
 * under it, and the suspension absorbs the difference across the wheelbase.
 * The visible bike is pitched to match the terrain in `Bike.syncRender` —
 * render-only, exactly like the lean-into-turns effect — so the rider sees a
 * bike that follows the hills even though the physics body never rotates.
 */

export interface VehicleControllerConfig {
  chassisHalfExtents: THREE.Vector3;
  chassisMass: number;
  wheelBase: number;
  wheelRadius: number;
  suspensionRestLength: number;
  suspensionStiffness: number;
  suspensionDamping: number;
  maxSuspensionForce: number;
  maxSuspensionTravel: number;
  /** Steering lock available at a standstill / crawling speed. */
  maxSteerAngle: number;
  /** How fast the bars can be turned at low speed, in radians/sec. */
  steerSpeed: number;
  /** How fast the bars can be turned at `topSpeedEstimate` — lower than `steerSpeed` makes fast steering feel heavy. */
  steerSpeedAtTopSpeed: number;
  /** Cornering acceleration the steering is allowed to ask for, in m/s^2. This is what makes steering tighten with speed. */
  maxLateralAccel: number;
  /** Fastest the bike may rotate, in rad/s, whatever the speed. Stops a slowing bike at held lock whipping round. */
  maxYawRate: number;
  maxEngineForce: number;
  brakeForce: number;
  /** Braking applied when the throttle is released, standing in for engine braking. */
  engineBrakeForce: number;
  /** Braking applied to a bike with nobody on it, so it stops within reach of its rider. */
  riderlessBrakeForce: number;
  /** Braking applied once a rider has crossed the finish line — see `finishBrake`'s comment. */
  finishBrakeForce: number;
  /** Scales whatever grip the current surface provides — for live tuning without flattening surface differences. */
  gripMultiplier: number;
  sideFrictionStiffness: number;
  reverseTolerance: number;
  topSpeedEstimate: number;
  /** How much nitro raises the top speed, in m/s. */
  boostExtraTopSpeed: number;
  /** Engine force multiplier while nitro is active — what makes the boost *felt* rather than merely permitted. */
  boostForceMultiplier: number;
  /**
   * Upper bound on how much a lightly loaded wheel's friction coefficient is
   * raised to keep its grip limit near nominal. 1 disables the compensation.
   */
  loadCompensationMax: number;
  /** Self-aligning yaw torque per radian of slip beyond the threshold, in N·m. */
  slipRecoveryTorque: number;
  /** Slip angle below which the bike is left alone, in radians. */
  slipRecoveryThreshold: number;
  /** Cap on the recovery torque, in N·m. */
  slipRecoveryMaxTorque: number;
  /**
   * Shift the two suspension rest lengths to follow the road's grade, so both
   * wheels carry equal load on a slope despite the pitch lock. 0 disables.
   */
  gradeFollowing: number;
  /** Seconds for the grade estimate to settle — a low-pass so it can't hunt. */
  gradeFollowingSmoothing: number;
  /** Largest rest-length shift, as a fraction of suspension travel. */
  gradeFollowingMaxShift: number;
  /**
   * Fastest a wheel with its full suspension travel in hand is allowed to
   * close on the ground, in m/s. Any closing speed beyond this is removed
   * on contact — a landing the suspension could never absorb becomes one it
   * can — and the allowance shrinks to zero as the wheel nears its bump
   * stop, so the chassis never pushes on past it. 0 disables.
   */
  landingAbsorbSpeed: number;
  /**
   * How briskly an airborne bike swings its nose to where it is going, in
   * rad/s of natural frequency. The response is critically damped, so the
   * heading settles without overshoot in roughly 5/airborneYawFrequency s.
   */
  airborneYawFrequency: number;
}

export const DEFAULT_VEHICLE_CONFIG: VehicleControllerConfig = {
  chassisHalfExtents: new THREE.Vector3(0.4, 0.3, 1.0),
  chassisMass: 220,
  wheelBase: 1.4,
  wheelRadius: 0.35,
  suspensionRestLength: 0.45,
  suspensionStiffness: 32,
  // Damping is per unit mass in Rapier's (Bullet's) suspension, so critical
  // is 2*sqrt(stiffness) = 11.3. The original 3.2 was a 0.28 ratio — badly
  // underdamped — and it showed: the telemetry replay of the user's spin
  // found the bike bottoming its suspension at the foot of an 8% climb, then
  // rebounding so hard both wheels went to a third of their load with the
  // rear still cornering at the limit. 8 is a 0.7 ratio, the textbook figure
  // for a vehicle: absorbs the transition without the bounce.
  suspensionDamping: 8,
  maxSuspensionForce: 10000,
  maxSuspensionTravel: 0.25,
  maxSteerAngle: THREE.MathUtils.degToRad(32),
  steerSpeed: THREE.MathUtils.degToRad(220),
  steerSpeedAtTopSpeed: THREE.MathUtils.degToRad(70),
  // The single number that decides how the bike feels at speed, because it
  // sets the tightest arc it can describe: minimum radius is v^2 divided by
  // this. At the old 1.1g "road bike" value the limit at 131 km/h was a 134 m
  // radius, and the track's fastest sweepers are 140-192 m — so every fast
  // corner had to be taken at the absolute limit and braking was the only way
  // to make one, which is not the game this is meant to be.
  //
  // 16 delivers about 14.4 m/s^2 (~1.45g, roughly MotoGP territory) and a
  // 92 m minimum radius at top speed, so sweepers are flat out and only the
  // genuinely tight corners need braking. Grip is *not* the constraint here:
  // `npm run sim:skidpad` shows achieved cornering tracks this cap at a flat
  // 90% regardless of `gripMultiplier`, i.e. the tyres never let go and this
  // number alone governs.
  maxLateralAccel: 16,
  // The lateral-acceleration cap alone has a hole at low speed: allowed
  // steering angle grows as 1/v^2 and yaw rate as a/v, so a bike that bleeds
  // speed through a long corner with the steer held tightens into an
  // ever-faster pirouette — `npm run sim:spin` measured 116 deg/s at full
  // lock by 20 km/h, and the bike had turned 425 degrees in eight seconds
  // with the tyres never sliding. Reported by the user as "hold A too long
  // and it does a 360". Capping the yaw rate at ~57 deg/s leaves every real
  // corner untouched (the tightest, 49 m at racing speed, needs ~0.4 rad/s)
  // and only bites below about 45 km/h, where it makes the rate of turn
  // steady and predictable instead of runaway.
  maxYawRate: 1.0,
  maxEngineForce: 2200,
  // Not newtons — Rapier treats this as a brake impulse, and it bites far
  // harder than the name suggests. Measured with `npm run sim:brake`: 60
  // gave 33 m/s^2, about 3.4g, which stops the bike as if it hit a wall.
  // 20 measures 12.1 m/s^2 (~1.24g) — a shade above what a real sportbike
  // manages on its front brake, which is the arcade half of "arcade-sim" and
  // leaves the player margin at the braking points. Well clear of the 6.5
  // m/s^2 the AI conservatively plans its braking around.
  brakeForce: 20,
  // Lifting off should visibly slow the bike. Linear damping alone gives only
  // ~1.8 m/s^2 at top speed, which left braking as the sole way to shed speed
  // for a corner. This adds roughly 3.3 m/s^2 on a closed throttle, in the
  // range a real bike's engine braking provides.
  engineBrakeForce: 4,
  // ~15 m/s^2, stopping a bike from top speed in about 45 m — close enough
  // for the rider, who tumbles a similar distance in the same direction, to
  // jog to it in a few seconds.
  riderlessBrakeForce: 25,
  // Measured the same way as `brakeForce` above (full stop distance this
  // time, not distance-to-halve): 190 stops the bike within 8.2 m even from
  // a nitro-boosted 153 km/h — the fastest a finish can plausibly happen at —
  // comfortably inside the 10 m the finish is meant to stop within. Far
  // harder than a rider would ever brake themselves; only `finishBrake` uses
  // it, once there is nothing left to steer around.
  finishBrakeForce: 190,
  gripMultiplier: 1.0,
  sideFrictionStiffness: 1.0,
  reverseTolerance: 0.6,
  topSpeedEstimate: 40,
  // Nitro: +20 km/h on the top speed. The torque curve tapers to zero at the
  // top-speed estimate, so raising the estimate alone would only let the bike
  // creep up to the new limit; the force multiplier is what makes the first
  // second of a boost feel like a kick. Both tuned with `npm run sim:nitro`.
  boostExtraTopSpeed: 20 / 3.6,
  boostForceMultiplier: 1.6,
  // Two defences against the spin the telemetry caught, either of which
  // would have prevented it and both of which are kept (see `tick`):
  //
  // A raycast vehicle's friction limit is proportional to the wheel's
  // suspension force, so a wheel that goes light over a crest or after a
  // bounce loses its grip in proportion. Real tyres do too — but a real bike
  // also pitches, and its rider absorbs the road; this chassis is pitch- and
  // roll-locked and cannot. Compensating the friction coefficient by up to
  // 3x keeps the limit near nominal until the wheel is below a third of its
  // load, at which point grip fades honestly.
  loadCompensationMax: 3,
  // And when the rear does step out, a torque toward the direction of travel
  // — the effect of trail and of a rider steering into the slide — turns a
  // 180° pirouette into a slide that gathers itself up. Without it there is
  // nothing in the model to stop a yaw runaway: a saturated wheel gives a
  // constant force whatever its slip angle, so once rotating it keeps going.
  slipRecoveryTorque: 4000,
  slipRecoveryThreshold: THREE.MathUtils.degToRad(5),
  slipRecoveryMaxTorque: 2500,
  // The chassis cannot pitch, so on a grade the suspension takes up the
  // whole difference between the two wheels: 1.4 m of wheelbase on an 8%
  // climb is 11 cm, which the replay showed as the front sitting on its bump
  // stop at 2400 N while the rear hung at 0.37 m carrying 250-700 N. A
  // chassis riding on a hard stop passes every ripple straight into the
  // light wheel's load, and that wheel is the one cornering at the limit.
  // Moving the rest lengths by half the difference each way gives both
  // wheels the same compression on any slope — what a pitching chassis
  // does — and the mesh already pitches to match (Bike.updateVisualPitch).
  gradeFollowing: 1,
  gradeFollowingSmoothing: 0.12,
  gradeFollowingMaxShift: 0.7,
  // The suspension has 0.25 m of travel under a 10 kN cap, which absorbs a
  // closing speed of about 4 m/s. The telemetry of a nitro run over the Wall
  // (replayed by `sim:replay`, checked by `sim:climb`) had the bike meeting
  // the drop's slope at 9.6 m/s after a 3 s flight: the suspension bottomed
  // at 12.5 kN in a single step, the chassis box itself hit the road, and
  // the box's friction took 50 km/h and threw the yaw to 3.4 rad/s. Below
  // this, the wheel and its spring do the landing; the excess is simply not
  // allowed to happen. Horizontal speed is untouched — an arcade landing
  // keeps what the flight had.
  landingAbsorbSpeed: 3,
  // Settles the nose in about a second — the length of the bounce in that
  // same log, during which the ground-only slip recovery, with no tyre to
  // resist it, swung the heading through ±30° three times.
  airborneYawFrequency: 5,
};

/** Slip recovery only acts above this forward speed (m/s); below it there is nothing to recover from. */
const SLIP_RECOVERY_MIN_FORWARD_SPEED = 3;
/** Below this speed (m/s) engine braking fades out, so it can't fight low-speed manoeuvring. */
const ENGINE_BRAKE_FADE_SPEED = 2;

const RIDDEN_LINEAR_DAMPING = 0.05;
const RIDDEN_ANGULAR_DAMPING = 1.5;
/**
 * Damping applied to a bike with nobody on it.
 *
 * The wheel brakes alone are not enough, because a riderless bike has its
 * rotation locks released and promptly flips — and once it is on its side the
 * suspension raycasts point at the sky, find no ground, and apply no braking
 * at all. Measured before this: a bike knocked over at 131 km/h was still
 * travelling two kilometres later. Damping doesn't care which way up the bike
 * is, and stops it within about 35 m.
 */
const RIDERLESS_LINEAR_DAMPING = 1.0;
const RIDERLESS_ANGULAR_DAMPING = 2.0;

export class VehicleController {
  readonly chassisBody: RAPIER.RigidBody;
  readonly chassisCollider: RAPIER.Collider;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private readonly config: VehicleControllerConfig;
  private readonly surfaces: SurfaceRegistry;

  private currentSteerAngle = 0;
  private throttleInput = 0;
  private steerInput = 0;
  private currentSurface: SurfaceProperties = DEFAULT_SURFACE;
  private boosting = false;
  private handbrake = false;
  private finishBraking = false;
  private riderAttached = true;
  private lastEngineForce = 0;
  private currentSteerLimit = 0;

  /**
   * Gear/rpm simulation. Automatic mode (every bot, and the player by
   * default): audio and HUD only, never the physics. Manual mode
   * (player-only, opt-in): also the real drive force — see `applyDrivetrain`.
   */
  private readonly transmission = new Transmission();

  private readonly tmpDrag = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpFwd = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpVel = new THREE.Vector3();
  /** Most recent slip angle, radians; positive when the bike is travelling to the right of where it points. */
  private currentSlipAngle = 0;
  /** Smoothed height difference the front wheel's ground sits above the rear's, in metres. */
  private gradeRise = 0;
  private readonly tmpContactF = new THREE.Vector3();
  private readonly tmpContactR = new THREE.Vector3();
  private readonly tmpNormal = new THREE.Vector3();
  /** Chassis moment of inertia about the yaw axis, kg·m² — sizes the airborne heading controller. */
  private readonly yawInertia: number;

  constructor(
    physics: PhysicsWorld,
    surfaces: SurfaceRegistry,
    spawnPosition: THREE.Vector3,
    spawnRotation: THREE.Quaternion = new THREE.Quaternion(),
    config: VehicleControllerConfig = DEFAULT_VEHICLE_CONFIG,
  ) {
    this.config = config;
    this.surfaces = surfaces;
    const half = config.chassisHalfExtents;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)
      .setRotation({
        x: spawnRotation.x,
        y: spawnRotation.y,
        z: spawnRotation.z,
        w: spawnRotation.w,
      })
      // Deliberately tiny while ridden. Top speed should be set by the engine's torque
      // curve tapering to zero at `topSpeedEstimate`, not by a blanket
      // velocity damper — at the old 0.3 this drag was 66*v newtons and
      // balanced the engine at 23 m/s, capping the bike at 86 km/h no matter
      // what `topSpeedEstimate` said. Surface drag is applied separately and
      // per-surface in `applySurfaceGrip`.
      .setLinearDamping(RIDDEN_LINEAR_DAMPING)
      .setAngularDamping(RIDDEN_ANGULAR_DAMPING)
      // Lock pitch (X) and roll (Z); yaw (Y) stays free for steering. See
      // class-level comment — this replaces an earlier reactive-torque
      // stabilizer that could oscillate and, past a threshold, actually
      // topple the bike instead of preventing it.
      //
      // Phase 5 note: this must be released (`setEnabledRotations(true, true,
      // true, true)`) when a rider is knocked off, so the bike can tumble.
      .enabledRotations(false, true, false)
      // Never sleeps. The countdown holds a bike nearly motionless (handbrake
      // plus heavy linear damping) for a full 3 seconds — comfortably past
      // Rapier's default sleep threshold — and the raycast vehicle
      // controller applies wheel forces through its own internal path rather
      // than a normal `addForce`/`applyImpulse` call, which does not reliably
      // wake a sleeping body. A bike that fell asleep on the grid kept
      // integrating `currentVehicleSpeed()` (the wheel/engine side of the
      // model) while `translation()` stayed pinned at the spawn point — the
      // dashboard read 130+ km/h on a bike that hadn't moved a centimetre —
      // until some unrelated nudge woke it and it snapped to where its
      // pent-up motion said it should already be, on top of whatever else
      // was nearby. Costs nothing while genuinely at rest; a stopped bike
      // still reports zero speed either way.
      .setCanSleep(false);
    this.chassisBody = physics.world.createRigidBody(bodyDesc);
    this.chassisCollider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setMass(config.chassisMass)
        // Frictionless on purpose. The box only ever touches the road when
        // the suspension has bottomed — a hard landing — and with the pitch
        // and roll axes locked, a rubbing box edge was the one thing that
        // could yank the yaw and eat the bike's speed in a single step (see
        // `landingAbsorbSpeed`). A pure normal contact still stops the bike
        // falling through the world, which is all it is for.
        .setFriction(0)
        .setCollisionGroups(GROUPS_BIKE),
      this.chassisBody,
    );
    const inertia = this.chassisBody.principalInertia();
    this.yawInertia =
      inertia.y > 0
        ? inertia.y
        : (config.chassisMass / 12) * (4 * half.x * half.x + 4 * half.z * half.z);

    this.vehicle = new RAPIER.DynamicRayCastVehicleController(
      this.chassisBody,
      physics.world.bodies,
      physics.world.colliders,
      physics.world.queryPipeline,
    );
    this.vehicle.indexUpAxis = 1;
    // Note: Rapier's type defs name this setter accessor `setIndexForwardAxis`
    // (not `indexForwardAxis`, unlike every other paired get/set here) — upstream typo.
    this.vehicle.setIndexForwardAxis = 2;

    const halfWheelBase = config.wheelBase / 2;
    // Mount point sits at the chassis's local bottom (not its center) — the raycast only
    // searches (restLength + radius) downward from this point, so mounting at the center
    // with a tall chassis left the ray too short to ever reach the ground (the bug that
    // made the bike sit dead on its belly and "vibrate" instead of driving).
    const mountY = -half.y;
    // Wheel 0 = front (steered), wheel 1 = rear (driven).
    this.vehicle.addWheel(
      { x: 0, y: mountY, z: halfWheelBase },
      { x: 0, y: -1, z: 0 },
      { x: 1, y: 0, z: 0 },
      config.suspensionRestLength,
      config.wheelRadius,
    );
    this.vehicle.addWheel(
      { x: 0, y: mountY, z: -halfWheelBase },
      { x: 0, y: -1, z: 0 },
      { x: 1, y: 0, z: 0 },
      config.suspensionRestLength,
      config.wheelRadius,
    );

    this.applyWheelTuning();
  }

  /**
   * Re-applies config's per-wheel tuning values; call after mutating config
   * live (e.g. from a debug GUI). Note that tyre grip is deliberately *not*
   * set here — it's driven per-tick by whichever surface each wheel is
   * currently on, in `applySurfaceGrip`.
   */
  applyWheelTuning(): void {
    const cfg = this.config;
    for (let i = 0; i < 2; i++) {
      this.vehicle.setWheelSuspensionStiffness(i, cfg.suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, cfg.suspensionDamping);
      this.vehicle.setWheelSuspensionRelaxation(i, cfg.suspensionDamping);
      this.vehicle.setWheelMaxSuspensionForce(i, cfg.maxSuspensionForce);
      this.vehicle.setWheelMaxSuspensionTravel(i, cfg.maxSuspensionTravel);
      this.vehicle.setWheelSideFrictionStiffness(i, cfg.sideFrictionStiffness);
    }
  }

  setInput(throttleInput: number, steerInput: number): void {
    this.throttleInput = THREE.MathUtils.clamp(throttleInput, -1, 1);
    this.steerInput = THREE.MathUtils.clamp(steerInput, -1, 1);
  }

  /**
   * Rapier applies `setWheelEngineForce()` along the opposite of the local +Z
   * this class treats as "forward" (the direction the nose marker points and
   * the chase camera sits behind) — confirmed empirically in Phase 1, when
   * throttle drove the bike toward its own tail. Engine force is therefore
   * negated at exactly this one handoff.
   *
   * `currentVehicleSpeed()`, however, is *not* mirrored: it already reads
   * positive when the bike travels nose-first. An earlier version negated it
   * too, on the assumption that both shared one convention, and that single
   * wrong sign silently disabled three things at once — the brakes (the
   * `forwardSpeed > 0.05` test could never pass while moving), the engine's
   * top-speed taper (`clamp(negative, 0, 1)` pinned the torque curve at full
   * output forever), and the AI's ability to slow for corners. Verified
   * against ground truth with `npm run sim:probe`: chassis linear velocity
   * dotted with the nose direction agrees with this getter in sign and
   * magnitude.
   */
  private static readonly ENGINE_FORCE_SIGN = -1;

  get forwardSpeed(): number {
    return this.vehicle.currentVehicleSpeed();
  }

  private toRawEngineForce(engineForceInOurForwardConvention: number): number {
    return VehicleController.ENGINE_FORCE_SIGN * engineForceInOurForwardConvention;
  }

  get tuning(): VehicleControllerConfig {
    return this.config;
  }

  get steerAngle(): number {
    return this.currentSteerAngle;
  }

  /** The steering lock currently available at this speed, in radians. */
  get steerLimit(): number {
    return this.currentSteerLimit;
  }

  /** Surface under the bike right now, for HUD/debug readouts. */
  get surfaceName(): string {
    return this.currentSurface.name;
  }

  /** Nitro on or off for the coming steps. Only matters under throttle; braking with it on just wastes it, as specified. */
  /** Locks both wheels regardless of input — the grid during the countdown. */
  setHandbrake(on: boolean): void {
    this.handbrake = on;
  }

  /** Locks both wheels at `finishBrakeForce`, regardless of input — a rider who has crossed the line. */
  setFinishBrake(on: boolean): void {
    this.finishBraking = on;
  }

  setBoost(active: boolean): void {
    this.boosting = active;
  }

  get isBoosting(): boolean {
    return this.boosting;
  }

  /** What one wheel is resting on right now, by name; "air" when it isn't touching anything. */
  wheelSurfaceName(index: 0 | 1): string {
    if (!this.vehicle.wheelIsInContact(index)) return "air";
    return this.surfaces.lookup(this.vehicle.wheelGroundObject(index)).name;
  }

  /** Input as the controller actually received it — for telling "keys not arriving" apart from "no traction". */
  get debugInputs(): { throttle: number; steer: number } {
    return { throttle: this.throttleInput, steer: this.steerInput };
  }

  /** Engine force applied on the most recent tick, in newtons. */
  get debugEngineForce(): number {
    return this.lastEngineForce;
  }

  /** 1-based gear. Sound/display only in automatic mode; drives real force in manual — see `transmissionMode`. */
  get gear(): number {
    return this.transmission.gear;
  }

  get rpm(): number {
    return this.transmission.rpm;
  }

  /** Engine speed as 0..1 between idle and redline. */
  get rpmNormalized(): number {
    return this.transmission.rpmNormalized;
  }

  get transmissionMode(): TransmissionMode {
    return this.transmission.transmissionMode;
  }

  /** Total forward gears (6). For UI — Transmission itself never needs to be asked. */
  get gearCount(): number {
    return this.transmission.gearCount;
  }

  setTransmissionMode(mode: TransmissionMode): void {
    this.transmission.setMode(mode);
  }

  /** Manual mode only; a no-op in automatic (there's nothing to shift — the box does it itself). */
  shiftUp(): void {
    this.transmission.shiftUp();
  }

  /** Manual mode only; a no-op in automatic. */
  shiftDown(): void {
    this.transmission.shiftDown();
  }

  /**
   * Real lateral (cornering) acceleration, in m/s^2. Negative when turning
   * right, because a right turn is a *negative* yaw rate here (measured, see
   * `utils/Directions`). Taken as `speed * yawRate` from the chassis's actual angular
   * velocity rather than computed from the commanded steering angle, so it
   * reports what the bike is *doing*, not what was asked of it — on a
   * low-grip surface the bike understeers and this correctly falls off, where
   * a commanded-angle version would have it leaning into a turn it isn't
   * making. Yaw is the only rotational axis left unlocked, so this is smooth
   * enough to drive the visual lean directly.
   */
  get lateralAcceleration(): number {
    return this.forwardSpeed * this.yawRate;
  }

  /**
   * Chassis yaw rate in rad/s, straight from the physics body. Negative when
   * turning right. Exposed for the HUD and for the direction probe.
   */
  get yawRate(): number {
    return this.chassisBody.angvel().y;
  }

  wheelIsGrounded(index: 0 | 1): boolean {
    return this.vehicle.wheelIsInContact(index);
  }

  wheelHardPoint(index: 0 | 1): THREE.Vector3 | null {
    const p = this.vehicle.wheelHardPoint(index);
    return p ? new THREE.Vector3(p.x, p.y, p.z) : null;
  }

  wheelContactPoint(index: 0 | 1): THREE.Vector3 | null {
    const p = this.vehicle.wheelContactPoint(index);
    return p ? new THREE.Vector3(p.x, p.y, p.z) : null;
  }

  wheelSuspensionLength(index: 0 | 1): number {
    return this.vehicle.wheelSuspensionLength(index) ?? this.config.suspensionRestLength;
  }

  wheelRotation(index: 0 | 1): number {
    return this.vehicle.wheelRotation(index) ?? 0;
  }

  tick(dt: number): void {
    // Drag and the recovery torque are re-applied from scratch every tick;
    // Rapier accumulates applied forces until explicitly cleared — and
    // torques SEPARATELY. Forgetting `resetTorques` made the slip-recovery
    // torque pile up step on step until the bike spun at 240 rad/s, with
    // either sign of torque, which is how it was diagnosed. Gravity is
    // internal and unaffected.
    this.chassisBody.resetForces(true);
    this.chassisBody.resetTorques(true);

    this.applySurfaceGrip();
    this.applyGradeFollowing(dt);
    if (this.riderAttached) {
      this.applyDrivetrain();
      this.applySteering(dt);
      // Contact state here is last step's — the rays are cast in
      // `updateVehicle` below — which is one step stale and good enough.
      if (this.vehicle.wheelIsInContact(0) || this.vehicle.wheelIsInContact(1)) {
        this.applySlipRecovery();
      } else {
        this.applyAirborneYawControl();
      }
    } else {
      // Riderless: no drive, no steering, and a firm scrub so the bike slides
      // to a halt in a few dozen metres. Left to coast it would run hundreds
      // of metres down the road, and the rider — jogging at 5 m/s — would
      // never catch it. A crashed bike shedding speed hard is also what
      // actually happens.
      this.vehicle.setWheelEngineForce(1, 0);
      this.vehicle.setWheelBrake(0, this.config.riderlessBrakeForce);
      this.vehicle.setWheelBrake(1, this.config.riderlessBrakeForce);
      this.lastEngineForce = 0;
    }
    // Terrain-only wheel rays: without the filter a bike rides up over a
    // fallen rider instead of past them.
    this.vehicle.updateVehicle(dt, undefined, GROUPS_WHEEL_RAY);
    this.absorbLanding();
    this.transmission.update(this.riderAttached ? this.forwardSpeed : 0, dt);
  }

  /**
   * Takes the sting out of a hard landing.
   *
   * A raycast vehicle's suspension can only absorb what its travel and force
   * cap allow — about 4 m/s of closing speed here — and Rapier gives it one
   * step to do so. Anything faster bottoms the spring instantly, puts the
   * chassis box on the road, and hands the landing to a rigid-body contact,
   * which is where the recorded 14 g stop and yaw kick came from. So on
   * every step a wheel is touching the ground, the chassis velocity *into*
   * that ground is clamped to what the suspension can take — the full
   * allowance with the spring at rest, tapering to nothing at the bump stop,
   * which makes the stop itself inelastic instead of leaving it to the box.
   * Velocity along the surface is left alone: the bike lands at the speed
   * it flew, pointed where it was pointed, and rides down the slope it
   * landed on rather than bouncing off it. The same clamp turns the foot of
   * a steep climb, where a pitch-locked chassis would otherwise drive its
   * nose into the rising road, into a redirect up the slope.
   */
  private absorbLanding(): void {
    const cfg = this.config;
    if (cfg.landingAbsorbSpeed <= 0) return;
    for (let i = 0; i < 2; i++) {
      if (!this.vehicle.wheelIsInContact(i)) continue;
      const n = this.vehicle.wheelContactNormal(i);
      if (!n) continue;
      const length = this.vehicle.wheelSuspensionLength(i) ?? cfg.suspensionRestLength;
      const rest = this.vehicle.wheelSuspensionRestLength(i) ?? cfg.suspensionRestLength;
      const remaining = THREE.MathUtils.clamp((length - (rest - cfg.maxSuspensionTravel)) / cfg.maxSuspensionTravel, 0, 1);
      // Stopping distance scales with speed squared, so the speed a given
      // travel can absorb scales with its square root.
      const limit = cfg.landingAbsorbSpeed * Math.sqrt(remaining);
      this.tmpNormal.set(n.x, n.y, n.z);
      const v = this.chassisBody.linvel();
      this.tmpVel.set(v.x, v.y, v.z);
      const closing = -this.tmpVel.dot(this.tmpNormal);
      if (closing <= limit) continue;
      this.tmpVel.addScaledVector(this.tmpNormal, closing - limit);
      this.chassisBody.setLinvel({ x: this.tmpVel.x, y: this.tmpVel.y, z: this.tmpVel.z }, true);
    }
  }

  /**
   * Attaches or detaches the rider.
   *
   * Detaching releases the chassis's pitch and roll locks so a riderless bike
   * tumbles freely — that lock is what makes a *ridden* bike impossible to
   * topple (see the class comment), and keeping it while the bike cartwheels
   * down the road would look absurd. Re-attaching restores the locks and
   * stands the bike back up, since a bike lying on its side has no upright
   * orientation of its own to recover.
   *
   * This is the release flagged as required back when the locks were added.
   */
  setRiderAttached(attached: boolean): void {
    if (this.riderAttached === attached) return;
    this.riderAttached = attached;

    if (attached) {
      this.standUpright();
      this.chassisBody.setEnabledRotations(false, true, false, true);
      this.chassisBody.setLinearDamping(RIDDEN_LINEAR_DAMPING);
      this.chassisBody.setAngularDamping(RIDDEN_ANGULAR_DAMPING);
      this.transmission.reset();
    } else {
      this.chassisBody.setEnabledRotations(true, true, true, true);
      this.chassisBody.setLinearDamping(RIDERLESS_LINEAR_DAMPING);
      this.chassisBody.setAngularDamping(RIDERLESS_ANGULAR_DAMPING);
      this.setInput(0, 0);
      this.currentSteerAngle = 0;
      this.vehicle.setWheelSteering(0, 0);
    }
  }

  get hasRider(): boolean {
    return this.riderAttached;
  }

  /**
   * Removes pitch and roll from the chassis, keeping its heading. Called on
   * remount: the rotation locks only prevent *new* pitch and roll, so a bike
   * that came to rest upside-down would stay upside-down forever once locked.
   */
  private standUpright(): void {
    const r = this.chassisBody.rotation();
    const euler = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(r.x, r.y, r.z, r.w),
      "YXZ",
    );
    const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.y);
    this.chassisBody.setRotation(
      { x: upright.x, y: upright.y, z: upright.z, w: upright.w },
      true,
    );
    this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * Shifts the suspension rest lengths so that on a grade both wheels sit at
   * the same compression. The rise is measured from where the wheel rays
   * actually hit, low-passed so a single bump can't yank the rest lengths
   * around, and capped at half the travel so a wheel can never be asked to
   * rest beyond its own limits.
   *
   * With only one wheel down the rise is read off that wheel's contact
   * normal instead. A bike landing on the 30% drop of the Wall touches rear
   * first, and with the rest lengths still level the front ray — 0.8 m from
   * a mount that is 0.97 m off the road — never reaches the ground: both
   * the bot and the nitro run (`sim:climb`) rode the whole descent on the
   * rear wheel alone, with no front grip and, since the visual pitch also
   * wants two wheels, the mesh level on a 17° slope. The normal says what
   * the slope is; lengthening the front to suit brings the wheel down.
   */
  private applyGradeFollowing(dt: number): void {
    const cfg = this.config;
    if (cfg.gradeFollowing <= 0) return;

    // With a wheel off the ground the grade is unknown, and the shift must
    // not be left where it was: a bike that leaves a 30% crest at 60 km/h
    // carries a front rest length 0.175 m short, so on landing the front ray
    // is too short to find the road at ride height, the bike rides on its
    // rear wheel alone, never re-measures the grade — and on the drop that
    // follows falls straight through the world (`sim:climb` found this).
    // In flight the shift decays to level, fast.
    let targetRise = 0;
    let smoothing = cfg.gradeFollowingSmoothing * 0.5;
    const front = this.vehicle.wheelContactPoint(0);
    const rear = this.vehicle.wheelContactPoint(1);
    const frontDown = this.vehicle.wheelIsInContact(0);
    const rearDown = this.vehicle.wheelIsInContact(1);
    if (front && rear && frontDown && rearDown) {
      this.tmpContactF.set(front.x, front.y, front.z);
      this.tmpContactR.set(rear.x, rear.y, rear.z);
      targetRise = this.tmpContactF.y - this.tmpContactR.y;
      smoothing = cfg.gradeFollowingSmoothing;
    } else if (frontDown !== rearDown) {
      const n = this.vehicle.wheelContactNormal(frontDown ? 0 : 1);
      if (n && n.y > 0.1) {
        const r = this.chassisBody.rotation();
        this.tmpQuat.set(r.x, r.y, r.z, r.w);
        this.tmpFwd.copy(LOCAL_FORWARD).applyQuaternion(this.tmpQuat);
        this.tmpNormal.set(n.x, n.y, n.z);
        // Rise over the wheelbase of a plane with this normal: uphill ahead
        // means the normal leans back, against the forward direction.
        targetRise = (-this.tmpNormal.dot(this.tmpFwd) / this.tmpNormal.y) * cfg.wheelBase;
        smoothing = cfg.gradeFollowingSmoothing;
      }
    }
    const blend = 1 - Math.exp(-dt / Math.max(smoothing, 1e-3));
    this.gradeRise += (targetRise - this.gradeRise) * blend;

    const limit = cfg.maxSuspensionTravel * cfg.gradeFollowingMaxShift;
    const shift = THREE.MathUtils.clamp((this.gradeRise * cfg.gradeFollowing) / 2, -limit, limit);
    // Uphill: the front's ground is closer, so its rest length shortens and
    // the rear's lengthens by the same amount. Net ride height is unchanged.
    this.vehicle.setWheelSuspensionRestLength(0, cfg.suspensionRestLength - shift);
    this.vehicle.setWheelSuspensionRestLength(1, cfg.suspensionRestLength + shift);
  }

  /**
   * Slip angle between where the bike points and where it is going, from the
   * chassis velocity in its own frame. Positive = travelling to the right of
   * the nose (bike's right is -X, see utils/Directions).
   */
  private measureSlip(): number {
    const r = this.chassisBody.rotation();
    this.tmpQuat.set(r.x, r.y, r.z, r.w);
    this.tmpFwd.copy(LOCAL_FORWARD).applyQuaternion(this.tmpQuat);
    this.tmpRight.copy(LOCAL_RIGHT).applyQuaternion(this.tmpQuat);
    const v = this.chassisBody.linvel();
    this.tmpVel.set(v.x, 0, v.z);
    if (this.tmpVel.lengthSq() < 1) return 0;
    return Math.atan2(this.tmpVel.dot(this.tmpRight), this.tmpVel.dot(this.tmpFwd));
  }

  /**
   * Yaws the bike back toward its direction of travel once it is sliding.
   *
   * A positive slip means the velocity is to the right of the nose, so the
   * nose must yaw right to realign — and a right turn is a NEGATIVE yaw in
   * this body frame (measured; utils/Directions). Hence the sign. Verified in
   * `sim:replay`, which first exposed a torque accumulation bug (see `tick`)
   * that made both signs explode alike.
   */
  private applySlipRecovery(): void {
    const cfg = this.config;
    const slip = this.measureSlip();
    this.currentSlipAngle = slip;
    // Forward motion only. A bike rolling backwards down a slope reads as a
    // 180° slide, and the full recovery torque then pivots it on the spot:
    // on the Wall (`sim:climb`) a stopped bike rolled back 2 m, was swung
    // 23° by this, and drove off across the grass and over the edge.
    if (this.tmpVel.dot(this.tmpFwd) < SLIP_RECOVERY_MIN_FORWARD_SPEED) return;
    const excess = Math.max(0, Math.abs(slip) - cfg.slipRecoveryThreshold);
    if (excess <= 0) return;
    const magnitude = Math.min(cfg.slipRecoveryTorque * excess, cfg.slipRecoveryMaxTorque);
    const torque = -Math.sign(slip) * magnitude;
    this.chassisBody.addTorque({ x: 0, y: torque, z: 0 }, true);
  }

  /**
   * Keeps an airborne bike pointed where it is flying.
   *
   * With no wheel on the ground there is no tyre to resist yaw, and the
   * ground slip recovery — a spring with no damper — would swing the nose
   * back and forth about the flight direction for as long as the flight
   * lasts (±30° three times in a one-second bounce, in the log that found
   * this). Off the ground the heading is instead driven by a critically
   * damped spring-damper toward the direction of travel, sized from the
   * chassis's yaw inertia so it settles without overshoot. Same sign
   * convention as `applySlipRecovery`. Too slow to have a direction, and
   * only the damping acts.
   */
  private applyAirborneYawControl(): void {
    const cfg = this.config;
    const slip = this.measureSlip();
    this.currentSlipAngle = slip;
    const w = cfg.airborneYawFrequency;
    const stiffness = this.yawInertia * w * w;
    const damping = 2 * this.yawInertia * w;
    const hasDirection = this.tmpVel.dot(this.tmpFwd) >= SLIP_RECOVERY_MIN_FORWARD_SPEED;
    let torque = -damping * this.yawRate;
    if (hasDirection) torque -= stiffness * slip;
    torque = THREE.MathUtils.clamp(torque, -cfg.slipRecoveryMaxTorque, cfg.slipRecoveryMaxTorque);
    this.chassisBody.addTorque({ x: 0, y: torque, z: 0 }, true);
  }

  /** Current slip angle in radians — see `measureSlip`. */
  get slipAngle(): number {
    return this.currentSlipAngle;
  }

  /**
   * Reads what each wheel is actually resting on and applies that surface's
   * grip, plus a speed-proportional drag for surfaces that have any. This is
   * what makes leaving the road cost something: less lateral grip *and* a
   * lower terminal speed, rather than only one or the other.
   */
  private applySurfaceGrip(): void {
    const cfg = this.config;
    let totalResistance = 0;
    let contactCount = 0;
    let dominant: SurfaceProperties = DEFAULT_SURFACE;

    // What each wheel would carry with the bike level and at rest.
    const nominalLoad = (cfg.chassisMass * 9.81) / 2;

    for (let i = 0; i < 2; i++) {
      const surface = this.surfaces.lookup(this.vehicle.wheelGroundObject(i));
      // Rapier caps a wheel's friction impulse at suspensionForce * dt *
      // frictionSlip, so raising frictionSlip as the load falls holds the
      // cap steady — up to `loadCompensationMax`, beyond which it is allowed
      // to fade. Last step's force is used; one step of lag is invisible.
      const load = this.vehicle.wheelSuspensionForce(i) ?? nominalLoad;
      const compensation = THREE.MathUtils.clamp(nominalLoad / Math.max(load, 1), 1, cfg.loadCompensationMax);
      this.vehicle.setWheelFrictionSlip(i, surface.frictionSlip * cfg.gripMultiplier * compensation);

      if (this.vehicle.wheelIsInContact(i)) {
        contactCount++;
        totalResistance += surface.rollingResistance;
        // Rear wheel wins ties — it's the driven one, so it's what governs
        // whether the bike can actually put power down.
        if (i === 1 || dominant === DEFAULT_SURFACE) dominant = surface;
      }
    }

    this.currentSurface = contactCount > 0 ? dominant : DEFAULT_SURFACE;

    if (totalResistance > 0) {
      const resistance = totalResistance / 2;
      const v = this.chassisBody.linvel();
      // Horizontal only — resisting vertical motion would fight gravity and
      // suspension rather than modelling ground drag.
      this.tmpDrag.set(v.x, 0, v.z).multiplyScalar(-resistance);
      this.chassisBody.addForce({ x: this.tmpDrag.x, y: 0, z: this.tmpDrag.z }, true);
    }
  }

  private applyDrivetrain(): void {
    const cfg = this.config;
    const forwardSpeed = this.forwardSpeed;

    let engineForce = 0;
    let brake = 0;

    if (this.throttleInput > 0 && this.transmission.transmissionMode === "manual") {
      // Manual mode: real per-gear drive instead of the continuous curve
      // below — see Transmission.manualDrive for the model. Nitro's extra
      // top speed is passed through as a scale on every gear's own top
      // speed, for the same reason it stretches `topSpeedEstimate` below.
      const topSpeedScale = 1 + (this.boosting ? cfg.boostExtraTopSpeed / cfg.topSpeedEstimate : 0);
      const boost = this.boosting ? cfg.boostForceMultiplier : 1;
      const drive = this.transmission.manualDrive(forwardSpeed, topSpeedScale);
      engineForce = cfg.maxEngineForce * this.throttleInput * drive.forceMultiplier * boost;
      if (drive.overRevBrakeMultiplier > 0) {
        brake = Math.max(brake, cfg.engineBrakeForce * drive.overRevBrakeMultiplier);
      }
    } else if (this.throttleInput > 0) {
      // Nitro stretches the torque curve out to a higher top speed and
      // multiplies the force under it, so it both permits and delivers the
      // extra speed.
      const topSpeed = cfg.topSpeedEstimate + (this.boosting ? cfg.boostExtraTopSpeed : 0);
      const speedRatio = THREE.MathUtils.clamp(forwardSpeed / topSpeed, 0, 1);
      const torqueCurve = 1 - speedRatio * speedRatio;
      const boost = this.boosting ? cfg.boostForceMultiplier : 1;
      engineForce = cfg.maxEngineForce * this.throttleInput * torqueCurve * boost;
    } else if (this.throttleInput === 0) {
      // Closed throttle: engine braking. Faded out below walking pace so it
      // can't fight the reverse creep or stop the bike rocking free.
      if (Math.abs(forwardSpeed) > ENGINE_BRAKE_FADE_SPEED) {
        brake = cfg.engineBrakeForce;
      }
    } else if (this.throttleInput < 0) {
      if (forwardSpeed > 0.05) {
        brake = cfg.brakeForce * -this.throttleInput;
      } else if (forwardSpeed > -cfg.reverseTolerance) {
        const towardToleranceRatio = THREE.MathUtils.clamp(-forwardSpeed / cfg.reverseTolerance, 0, 1);
        engineForce = cfg.maxEngineForce * this.throttleInput * 0.4 * (1 - towardToleranceRatio);
      }
    }

    // The wrong-way rule is a hard block: nothing may travel backwards past
    // the small tolerance, gravity included. Without this a bike stopped on
    // a grade with the brake on rolled back down it — the starting grid on
    // Ridgeway is uphill, and the pack slid 3 m backwards during the
    // countdown — and a stalled bike on the Wall hit 90 km/h in reverse.
    if (forwardSpeed < -cfg.reverseTolerance) {
      engineForce = Math.max(engineForce, 0);
      brake = cfg.brakeForce;
    }

    // Handbrake: both wheels locked, whatever the throttle says. Held on the
    // grid through the countdown.
    if (this.handbrake) {
      engineForce = 0;
      brake = cfg.brakeForce;
    }

    // Finish brake: same idea, for a rider who has crossed the line — see
    // `finishBrakeForce`'s comment for why it brakes far harder than racing
    // ever does.
    if (this.finishBraking) {
      engineForce = 0;
      brake = cfg.finishBrakeForce;
    }

    this.lastEngineForce = engineForce;
    this.vehicle.setWheelEngineForce(1, this.toRawEngineForce(engineForce));
    this.vehicle.setWheelBrake(0, brake);
    this.vehicle.setWheelBrake(1, brake);
  }

  /**
   * Speed-sensitive steering, in two parts.
   *
   * **How far the bars can turn** is capped by cornering acceleration rather
   * than by angle. A given steering angle does not produce a fixed rate of
   * turn — yaw rate is `v * tan(delta) / wheelbase`, so it grows with speed.
   * Simply scaling the angle down with speed (what this used to do) still
   * left the bike turning several times faster at 90 km/h than at 10 km/h,
   * i.e. twitchier the faster you went. Capping lateral acceleration
   * `a = v^2 * tan(delta) / L` instead makes the angle fall off as 1/v^2, so
   * the achievable yaw rate becomes `a / v` — it *decreases* with speed, and
   * cornering radius widens naturally the faster you're going.
   *
   * **How fast the bars can move** is separately reduced with speed, which is
   * what makes fast steering feel physically heavy instead of merely limited.
   * Straightening up is exempt: recovering from a slide or a bad line has to
   * stay responsive, so only turning *into* a corner is slowed.
   */
  private applySteering(dt: number): void {
    const cfg = this.config;
    const speed = Math.abs(this.forwardSpeed);

    let maxAngle = cfg.maxSteerAngle;
    if (speed > 1.0) {
      const gripLimited = Math.atan((cfg.maxLateralAccel * cfg.wheelBase) / (speed * speed));
      // Same kinematics, solved for yaw rate instead: yaw = v * tan(delta) / L.
      const yawLimited = Math.atan((cfg.maxYawRate * cfg.wheelBase) / speed);
      maxAngle = Math.min(maxAngle, gripLimited, yawLimited);
    }
    const targetAngle = this.steerInput * maxAngle;

    const speedRatio = THREE.MathUtils.clamp(speed / cfg.topSpeedEstimate, 0, 1);
    const turnInRate = THREE.MathUtils.lerp(cfg.steerSpeed, cfg.steerSpeedAtTopSpeed, speedRatio);
    const straightening = Math.abs(targetAngle) < Math.abs(this.currentSteerAngle);
    const rate = straightening ? cfg.steerSpeed : turnInRate;

    const maxDelta = rate * dt;
    this.currentSteerAngle = THREE.MathUtils.clamp(
      targetAngle,
      this.currentSteerAngle - maxDelta,
      this.currentSteerAngle + maxDelta,
    );
    this.currentSteerLimit = maxAngle;
    // Flipped at the handoff: `currentSteerAngle` is positive for a right
    // turn, but a positive rotation about the up axis carries +Z toward +X,
    // which is the bike's LEFT (utils/Directions). Rapier applies exactly that
    // rotation, so it needs the negative (confirmed empirically — without the
    // flip, A turned right and D turned left). `steerAngle` stays
    // positive-right for callers, and Bike.ts applies the same negation when
    // it draws the wheel — an earlier comment here claimed the render side
    // could use the angle as-is, and the wheel steered backwards on screen.
    this.vehicle.setWheelSteering(0, -this.currentSteerAngle);
  }

  /** Places the bike back on the track — used to recover from falling off the world. */
  respawnAt(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.chassisBody.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.chassisBody.setRotation(
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      true,
    );
    this.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.chassisBody.resetForces(true);
    this.currentSteerAngle = 0;
    this.transmission.reset();
  }
}
