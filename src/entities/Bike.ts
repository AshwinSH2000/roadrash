import * as THREE from "three";
import type { PhysicsWorld } from "../physics/PhysicsWorld";
import type { SurfaceRegistry } from "../physics/TerrainMaterial";
import { VehicleController, DEFAULT_VEHICLE_CONFIG } from "../physics/VehicleController";
import {
  createPlaceholderBikeVisuals,
  type BikeVisuals,
  type BikeVisualsFactory,
} from "./BikeVisuals";
import { LOCAL_DOWN, LOCAL_FORWARD } from "../utils/Directions";

const X_AXIS = new THREE.Vector3(1, 0, 0);

/** How quickly the visual pitch chases the terrain slope (per second, exponential). */
const PITCH_SMOOTHING = 8;
/** How quickly the visual lean chases the cornering force (per second, exponential). */
const LEAN_SMOOTHING = 9;
/** Ceiling on lean, so a spin or a landing can't lay the bike flat on its side. */
const MAX_LEAN = THREE.MathUtils.degToRad(48);
/** Below this speed (m/s) the bike stands up — a stationary bike doesn't lean. */
const LEAN_FADE_IN_SPEED = 3;

const GRAVITY = 9.81;

/**
 * One bike: the VehicleController physics, whatever is currently being drawn
 * for it, and the interpolation of its render transform between fixed physics
 * steps.
 *
 * What gets drawn comes from a `BikeVisuals` and is swappable at runtime via
 * `setVisuals` — the procedural boxes by default, a loaded model when one is
 * available. Nothing below this line knows which it has; all of it operates on
 * a body object and two wheel objects.
 *
 * Both terrain pitch and cornering lean are applied here, to the *meshes*
 * only — the physics chassis has its pitch and roll axes locked (see
 * VehicleController) and must never be rotated on them, since that lock is
 * the only reason the bike can't topple.
 */
export class Bike {
  readonly controller: VehicleController;
  private readonly scene: THREE.Scene;
  private readonly group: THREE.Group;
  private visuals: BikeVisuals;
  private wheelObjects: [THREE.Object3D, THREE.Object3D];
  private readonly strikeMesh: THREE.Mesh;

  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currQuat = new THREE.Quaternion();

  /** Interpolated *physics* orientation — no visual pitch or lean baked in. */
  private readonly renderQuat = new THREE.Quaternion();
  private visualPitch = 0;
  private visualLean = 0;

  private readonly tmpDown = new THREE.Vector3();
  private readonly tmpSteerQuat = new THREE.Quaternion();
  private readonly tmpSpinQuat = new THREE.Quaternion();
  private readonly tmpPitchQuat = new THREE.Quaternion();
  private readonly tmpSlope = new THREE.Vector3();
  private readonly tmpBodyQuat = new THREE.Quaternion();
  private readonly tmpLeanQuat = new THREE.Quaternion();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpPivot = new THREE.Vector3();
  private readonly tmpRelative = new THREE.Vector3();
  private readonly wheelCenters: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private readonly wheelQuats: [THREE.Quaternion, THREE.Quaternion] = [
    new THREE.Quaternion(),
    new THREE.Quaternion(),
  ];

  constructor(
    physics: PhysicsWorld,
    surfaces: SurfaceRegistry,
    scene: THREE.Scene,
    spawnPosition: THREE.Vector3,
    spawnRotation: THREE.Quaternion = new THREE.Quaternion(),
    color = 0x2266dd,
    /**
     * Omitted by every headless simulation, which must be able to construct a
     * bike without a GLTF file or a DOM to load one with.
     */
    visualsFactory: BikeVisualsFactory = createPlaceholderBikeVisuals,
  ) {
    this.controller = new VehicleController(physics, surfaces, spawnPosition, spawnRotation);

    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.visuals = visualsFactory(color);
    this.group.add(this.visuals.body);
    this.wheelObjects = this.visuals.wheels;
    scene.add(this.wheelObjects[0], this.wheelObjects[1]);

    // Strike indicator. A child of the group on purpose: it then inherits the
    // bike's lean and terrain pitch for free, so a punch thrown mid-corner
    // swings from the leaned-over bike rather than floating upright beside it.
    this.strikeMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.16, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0x554400, roughness: 0.5 }),
    );
    this.strikeMesh.visible = false;
    this.group.add(this.strikeMesh);

    this.captureTransform(this.prevPos, this.prevQuat);
    this.captureTransform(this.currPos, this.currQuat);
  }

  setInput(throttleInput: number, steerInput: number): void {
    this.controller.setInput(throttleInput, steerInput);
  }

  /**
   * Swaps what is drawn for this bike, leaving the physics untouched.
   *
   * This is what makes fitting a downloaded model tractable: the fitting
   * numbers (scale, heading, ride height offsets) can be nudged in the debug
   * GUI and re-applied to all six bikes mid-race, instead of being guessed,
   * rebuilt and reloaded one attempt at a time.
   *
   * The wheels are re-added to the scene root rather than to the group,
   * because their transforms are written in world space every frame — see the
   * note on `BikeVisuals`.
   */
  setVisuals(visuals: BikeVisuals): void {
    this.visuals.dispose();
    this.group.remove(this.visuals.body);
    this.scene.remove(this.wheelObjects[0], this.wheelObjects[1]);

    this.visuals = visuals;
    this.group.add(visuals.body);
    this.wheelObjects = visuals.wheels;
    this.scene.add(this.wheelObjects[0], this.wheelObjects[1]);
  }

  /** Releases this bike's meshes. The physics bodies are owned by the world, not here. */
  dispose(): void {
    this.visuals.dispose();
    this.group.removeFromParent();
    this.scene.remove(this.wheelObjects[0], this.wheelObjects[1]);
    this.strikeMesh.geometry.dispose();
    (this.strikeMesh.material as THREE.Material).dispose();
  }

  /**
   * Shows or hides the strike indicator. `side` is -1 for left, +1 for right,
   * 0 to hide; `reach` is how far out the fist is thrown, in metres.
   *
   * Placeholder visuals — this becomes a real arm animation once there's a
   * rigged rider — but it has to exist now, because an attack you can't see
   * is impossible to judge range or timing on.
   */
  setStrike(side: number, reach: number): void {
    if (side === 0) {
      this.strikeMesh.visible = false;
      return;
    }
    this.strikeMesh.visible = true;
    // Local -X is the bike's right (see utils/Directions), so a right-hand
    // strike goes out along negative X.
    this.strikeMesh.position.set(-side * reach, 0.35, 0.15);
  }

  /** See `VehicleController.setRiderAttached` — releases the tip-over locks when riderless. */
  setRiderAttached(attached: boolean): void {
    this.controller.setRiderAttached(attached);
  }

  get hasRider(): boolean {
    return this.controller.hasRider;
  }

  get forwardSpeed(): number {
    return this.controller.forwardSpeed;
  }

  get worldPosition(): THREE.Vector3 {
    return this.currPos;
  }

  /** Physics orientation (yaw only) — deliberately excludes the cosmetic pitch and lean. */
  get worldQuaternion(): THREE.Quaternion {
    return this.currQuat;
  }

  /** Current cosmetic lean, in radians; positive leans right. The camera borrows this for its roll. */
  get leanAngle(): number {
    return this.visualLean;
  }

  /** Call before `physics.step()`: snapshots the previous transform and applies this step's drive/steer input. */
  prePhysicsStep(dt: number): void {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.controller.tick(dt);
  }

  /** Call after `physics.step()`: captures the newly-integrated transform. */
  postPhysicsStep(): void {
    this.captureTransform(this.currPos, this.currQuat);
  }

  /**
   * Moves the bike somewhere else at rest — a rescue, or back to the grid.
   * Both cached transforms are refreshed at once, so `worldPosition` is right
   * immediately (the track projection and the HUD read it before the next
   * physics step) and the render doesn't interpolate across the map.
   */
  teleport(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.controller.respawnAt(position, rotation);
    this.captureTransform(this.prevPos, this.prevQuat);
    this.captureTransform(this.currPos, this.currQuat);
  }

  private captureTransform(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const t = this.controller.chassisBody.translation();
    const r = this.controller.chassisBody.rotation();
    outPos.set(t.x, t.y, t.z);
    outQuat.set(r.x, r.y, r.z, r.w);
  }

  /**
   * The physics chassis has its pitch axis locked, so on a slope it stays
   * level while the road tilts under it. Measuring the actual ground contact
   * points and pitching the *mesh* to match keeps the bike looking like it's
   * following the terrain, without giving the physics body back a rotational
   * freedom that made it topple.
   */
  private updateVisualPitch(dtSeconds: number): void {
    const front = this.controller.wheelContactPoint(0);
    const rear = this.controller.wheelContactPoint(1);

    let target = 0;
    if (
      this.controller.hasRider &&
      front &&
      rear &&
      this.controller.wheelIsGrounded(0) &&
      this.controller.wheelIsGrounded(1)
    ) {
      this.tmpSlope.subVectors(front, rear);
      const length = this.tmpSlope.length();
      if (length > 1e-3) {
        target = Math.asin(THREE.MathUtils.clamp(this.tmpSlope.y / length, -1, 1));
      }
    }

    // Exponential smoothing, frame-rate independent — also decays back to
    // level while airborne, since `target` stays 0 with no wheels down.
    const blend = 1 - Math.exp(-PITCH_SMOOTHING * dtSeconds);
    this.visualPitch = THREE.MathUtils.lerp(this.visualPitch, target, blend);
  }

  /**
   * A motorcycle in a steady turn leans until gravity and cornering force
   * line up through the contact patch, which is exactly `tan(lean) = a / g`.
   * Deriving the angle from the real cornering acceleration rather than from
   * steering input means the lean is *informative*: how far the bike is laid
   * over tells you how close you are to the cornering limit, which at the
   * 11 m/s^2 cap works out to about 48 degrees.
   *
   * Sign convention: `visualLean` is positive when the bike is leaned to its
   * right. Lateral acceleration is *negative* in a right-hand turn (a right
   * turn is a negative yaw rate — measured, see `utils/Directions`), hence
   * the negation. Getting this backwards was one of four mirrored-axis bugs
   * in this project, so it is pinned to measured behaviour rather than to a
   * derivation.
   */
  private updateVisualLean(dtSeconds: number): void {
    const airborne = !this.controller.wheelIsGrounded(0) && !this.controller.wheelIsGrounded(1);
    if (!this.controller.hasRider || airborne) {
      // A riderless bike is tumbling on its own real rotation; adding a
      // cosmetic lean on top would fight it. And a bike with both wheels off
      // the ground has no cornering force to lean against — its yaw rate is
      // the airborne heading controller settling, and leaning to that had
      // the bike rolling ±45° in mid-air in a logged nitro jump.
      const blend = 1 - Math.exp(-LEAN_SMOOTHING * dtSeconds);
      this.visualLean = THREE.MathUtils.lerp(this.visualLean, 0, blend);
      return;
    }
    const lateral = this.controller.lateralAcceleration;
    let target = -Math.atan2(lateral, GRAVITY);
    target = THREE.MathUtils.clamp(target, -MAX_LEAN, MAX_LEAN);

    // Fade out at walking pace. `speed * yawRate` is near zero when stopped
    // anyway, but a stationary bike being shoved around shouldn't tip.
    const fade = THREE.MathUtils.clamp(Math.abs(this.forwardSpeed) / LEAN_FADE_IN_SPEED, 0, 1);
    target *= fade;

    const blend = 1 - Math.exp(-LEAN_SMOOTHING * dtSeconds);
    this.visualLean = THREE.MathUtils.lerp(this.visualLean, target, blend);
  }

  syncRender(alpha: number, dtSeconds: number): void {
    this.group.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.currQuat, alpha);

    this.updateVisualPitch(dtSeconds);
    // Negative angle because a positive rotation about local +X tips the
    // nose (+Z) downward, and a positive slope means the nose is higher.
    this.tmpPitchQuat.setFromAxisAngle(X_AXIS, -this.visualPitch);
    this.tmpBodyQuat.copy(this.renderQuat).multiply(this.tmpPitchQuat);
    this.group.quaternion.copy(this.tmpBodyQuat);

    // Wheel placement uses the *unpitched* physics orientation: hard points
    // come from the physics chassis, so pitching them too would slide them
    // out of their suspension travel. Their bottoms also give the lean pivot.
    this.tmpPivot.set(0, 0, 0);
    let pivotSamples = 0;
    for (let i = 0; i < 2; i++) {
      const index = i as 0 | 1;
      const hardPoint = this.controller.wheelHardPoint(index);
      if (!hardPoint) continue;
      const suspensionLength = this.controller.wheelSuspensionLength(index);

      this.tmpDown.copy(LOCAL_DOWN).applyQuaternion(this.renderQuat);
      this.wheelCenters[i].copy(hardPoint).addScaledVector(this.tmpDown, suspensionLength);

      const steerAngle = index === 0 ? this.controller.steerAngle : 0;
      // NEGATED, and measured rather than derived: `steerAngle` is positive
      // for a right turn (VehicleController: `steerInput * maxAngle`, and
      // steerInput = +1 turns right, see utils/Directions). But a positive
      // rotation about the up axis carries the nose from +Z toward +X, and +X
      // is the bike's LEFT. Without the sign flip the wheel visibly steered
      // the wrong way — reported by the user the moment a real wheel, with
      // features you can read the angle off, replaced the placeholder disc.
      // The axis is the model's fork axis when it supplied one, so the wheel
      // cambers as it turns like a real one; vertical otherwise.
      this.tmpSteerQuat.setFromAxisAngle(this.visuals.steeringAxis, -steerAngle);
      this.tmpSpinQuat.setFromAxisAngle(X_AXIS, this.controller.wheelRotation(index));
      this.wheelQuats[i].copy(this.renderQuat).multiply(this.tmpSteerQuat).multiply(this.tmpSpinQuat);

      // Tyre contact patch = wheel centre, one radius further down.
      this.tmpPivot
        .add(this.wheelCenters[i])
        .addScaledVector(this.tmpDown, DEFAULT_VEHICLE_CONFIG.wheelRadius);
      pivotSamples++;
    }
    // Averaged over however many wheels actually reported a hard point.
    // Dividing by a fixed 2 would put the pivot halfway to the world origin
    // if either lookup ever came back null, which would hurl the bike across
    // the map the instant it leaned.
    if (pivotSamples > 0) {
      this.tmpPivot.multiplyScalar(1 / pivotSamples);
    } else {
      this.tmpPivot.copy(this.group.position);
    }

    this.updateFrontAssembly();
    this.applyLean(dtSeconds);
  }

  /**
   * Turns the forks, bars and fender with the steering, when the model
   * supplied them. Same sign as the wheel, about the same axis, so the two stay
   * attached under full lock. The assembly arrives already straightened.
   */
  private updateFrontAssembly(): void {
    const assembly = this.visuals.frontAssembly;
    if (!assembly) return;
    assembly.object.quaternion.setFromAxisAngle(assembly.axis, -this.controller.steerAngle);
  }

  /**
   * Rolls the whole visible bike — body and both wheels — about the line
   * through its tyre contact patches.
   *
   * Rolling about the chassis centre instead would be much simpler, but the
   * contact patches would swing sideways by roughly `wheelHeight * sin(lean)`
   * — a third of a metre at full lean — so the tyres would visibly skate out
   * from under the bike and hang off the road on a hard corner. Pivoting at
   * ground level keeps them planted, which is what actually happens.
   */
  private applyLean(dtSeconds: number): void {
    this.updateVisualLean(dtSeconds);

    // Roll axis is the bike's own longitudinal axis, taken *after* terrain
    // pitch so the two compose correctly on a slope. A positive rotation
    // about local +Z carries the bike's up vector toward -X, which is the
    // bike's right (see utils/Directions) — so a positive `visualLean`
    // rotates positively, and both mean "leaned right".
    this.tmpForward.copy(LOCAL_FORWARD).applyQuaternion(this.tmpBodyQuat).normalize();
    this.tmpLeanQuat.setFromAxisAngle(this.tmpForward, this.visualLean);

    this.tmpRelative.subVectors(this.group.position, this.tmpPivot).applyQuaternion(this.tmpLeanQuat);
    this.group.position.copy(this.tmpPivot).add(this.tmpRelative);
    this.group.quaternion.premultiply(this.tmpLeanQuat);

    for (let i = 0; i < 2; i++) {
      const mesh = this.wheelObjects[i];
      this.tmpRelative.subVectors(this.wheelCenters[i], this.tmpPivot).applyQuaternion(this.tmpLeanQuat);
      mesh.position.copy(this.tmpPivot).add(this.tmpRelative);
      mesh.quaternion.copy(this.wheelQuats[i]).premultiply(this.tmpLeanQuat);
    }
  }
}
