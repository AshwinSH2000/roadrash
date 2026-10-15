import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld";
import { GROUPS_RIDER } from "./CollisionGroups";

/**
 * A simplified jointed ragdoll for knocked-off riders.
 *
 * Eleven bodies: pelvis, torso, head, and an upper and lower segment per limb,
 * joined by ball joints at the shoulders, hips and neck and limited hinges at
 * the elbows and knees. Limbs were a single capsule each at first, because
 * every extra joint is another constraint for the solver to fight over and
 * fewer, heavier bodies settle far more reliably — and "settles reliably" is
 * the actual requirement, since the recovery state machine can't advance
 * until the ragdoll stops moving. The hinges are limited so the extra joints
 * cannot fold the wrong way, and `fall-sim` is what proves they still settle.
 *
 * Nothing about the tumble is scripted. The bodies inherit the rider's
 * velocity at the moment of separation plus whatever impulse knocked them
 * off, so a fall at 130 km/h throws them much further than one at 40, which
 * is what the design asks for.
 */

/** Total rider mass in kg, split across the bodies below. */
const RIDER_MASS = 78;

export interface BoneSpec {
  name: string;
  /** Offset from the pelvis, in the rider's local frame, in metres. */
  offset: THREE.Vector3;
  halfHeight: number;
  radius: number;
  mass: number;
  /** Which bone this hangs from, and where the joint sits relative to each. */
  parent?: string;
  anchorOnParent?: THREE.Vector3;
  anchorOnSelf?: THREE.Vector3;
  /**
   * Elbows and knees: a hinge about the rider's X axis rather than a ball
   * joint, limited to this range of angles (radians, right-handed about +X
   * measured from the straight pose), so limbs fold the way limbs do.
   */
  hinge?: { min: number; max: number };
}

/** Knees fold the shin backward and elbows the forearm forward; neither bends the other way. */
const KNEE_LIMITS = { min: 0, max: 2.5 };
const ELBOW_LIMITS = { min: -2.5, max: 0 };

export const BONES: readonly BoneSpec[] = [
  { name: "pelvis", offset: new THREE.Vector3(0, 0, 0), halfHeight: 0.1, radius: 0.15, mass: RIDER_MASS * 0.2 },
  {
    name: "torso",
    offset: new THREE.Vector3(0, 0.38, 0),
    halfHeight: 0.16,
    radius: 0.16,
    mass: RIDER_MASS * 0.33,
    parent: "pelvis",
    anchorOnParent: new THREE.Vector3(0, 0.14, 0),
    anchorOnSelf: new THREE.Vector3(0, -0.22, 0),
  },
  {
    name: "head",
    offset: new THREE.Vector3(0, 0.72, 0),
    halfHeight: 0.06,
    radius: 0.12,
    mass: RIDER_MASS * 0.08,
    parent: "torso",
    anchorOnParent: new THREE.Vector3(0, 0.2, 0),
    anchorOnSelf: new THREE.Vector3(0, -0.14, 0),
  },
  {
    name: "upperArmLeft",
    offset: new THREE.Vector3(0.29, 0.5, 0),
    halfHeight: 0.09,
    radius: 0.07,
    mass: RIDER_MASS * 0.03,
    parent: "torso",
    anchorOnParent: new THREE.Vector3(0.17, 0.14, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.16, 0),
  },
  {
    name: "foreArmLeft",
    offset: new THREE.Vector3(0.29, 0.2, 0),
    halfHeight: 0.08,
    radius: 0.065,
    mass: RIDER_MASS * 0.02,
    parent: "upperArmLeft",
    anchorOnParent: new THREE.Vector3(0, -0.16, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.145, 0),
    hinge: ELBOW_LIMITS,
  },
  {
    name: "upperArmRight",
    offset: new THREE.Vector3(-0.29, 0.5, 0),
    halfHeight: 0.09,
    radius: 0.07,
    mass: RIDER_MASS * 0.03,
    parent: "torso",
    anchorOnParent: new THREE.Vector3(-0.17, 0.14, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.16, 0),
  },
  {
    name: "foreArmRight",
    offset: new THREE.Vector3(-0.29, 0.2, 0),
    halfHeight: 0.08,
    radius: 0.065,
    mass: RIDER_MASS * 0.02,
    parent: "upperArmRight",
    anchorOnParent: new THREE.Vector3(0, -0.16, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.145, 0),
    hinge: ELBOW_LIMITS,
  },
  {
    name: "upperLegLeft",
    offset: new THREE.Vector3(0.13, -0.3, 0),
    halfHeight: 0.12,
    radius: 0.09,
    mass: RIDER_MASS * 0.095,
    parent: "pelvis",
    anchorOnParent: new THREE.Vector3(0.11, -0.12, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.21, 0),
  },
  {
    name: "lowerLegLeft",
    offset: new THREE.Vector3(0.13, -0.7, 0),
    halfHeight: 0.12,
    radius: 0.075,
    mass: RIDER_MASS * 0.05,
    parent: "upperLegLeft",
    anchorOnParent: new THREE.Vector3(0, -0.21, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.195, 0),
    hinge: KNEE_LIMITS,
  },
  {
    name: "upperLegRight",
    offset: new THREE.Vector3(-0.13, -0.3, 0),
    halfHeight: 0.12,
    radius: 0.09,
    mass: RIDER_MASS * 0.095,
    parent: "pelvis",
    anchorOnParent: new THREE.Vector3(-0.11, -0.12, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.21, 0),
  },
  {
    name: "lowerLegRight",
    offset: new THREE.Vector3(-0.13, -0.7, 0),
    halfHeight: 0.12,
    radius: 0.075,
    mass: RIDER_MASS * 0.05,
    parent: "upperLegRight",
    anchorOnParent: new THREE.Vector3(0, -0.21, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.195, 0),
    hinge: KNEE_LIMITS,
  },
];

/**
 * Speeds below which the ragdoll counts as still, in m/s and rad/s.
 *
 * The angular threshold is deliberately loose. These are small bodies — an
 * arm is 7 cm across — so a few rad/s of residual spin is a couple of
 * centimetres of surface movement, invisible on screen but easily enough to
 * fail a strict test forever and leave the rider lying in the road.
 */
const SETTLE_LINEAR = 0.5;
const SETTLE_ANGULAR = 2.5;
/** How long it must stay still before the rider is allowed to get up, in seconds. */
const SETTLE_HOLD = 0.45;
/**
 * A ragdoll is force-settled after this long regardless. Without it a body
 * wedged against terrain and jittering below the velocity thresholds could
 * strand a rider for the rest of the race.
 */
const SETTLE_TIMEOUT = 6;

/** Supplies what each ragdoll body looks like; the default is a plain capsule. */
export interface RagdollVisuals {
  create(spec: BoneSpec): THREE.Object3D;
  dispose(): void;
}

interface Bone {
  spec: BoneSpec;
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  /** Body transform at the last two ticks, interpolated at render time like the bike's. */
  prevPos: THREE.Vector3;
  currPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currQuat: THREE.Quaternion;
}

export class RagdollController {
  private bones: Bone[] = [];
  private joints: RAPIER.ImpulseJoint[] = [];
  private readonly group = new THREE.Group();

  private stillFor = 0;
  private aliveFor = 0;

  private readonly tmpVec = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly color: number,
    private readonly visuals: RagdollVisuals | null = null,
  ) {
    this.scene.add(this.group);
  }

  get isActive(): boolean {
    return this.bones.length > 0;
  }

  /** World position of the pelvis — what the camera follows during a fall. */
  get pelvisPosition(): THREE.Vector3 {
    const pelvis = this.bones[0];
    if (!pelvis) return this.tmpVec.set(0, 0, 0);
    const t = pelvis.body.translation();
    return this.tmpVec.set(t.x, t.y, t.z);
  }

  /**
   * Builds the ragdoll at `origin`, facing `orientation`, already moving at
   * `velocity` with `impulse` applied to the torso.
   *
   * The inherited velocity is the whole point: the fall's distance and
   * direction emerge from the momentum the rider actually had, rather than
   * from a canned animation.
   */
  spawn(
    origin: THREE.Vector3,
    orientation: THREE.Quaternion,
    velocity: THREE.Vector3,
    impulse: THREE.Vector3,
  ): void {
    if (this.isActive) this.despawn();
    this.stillFor = 0;
    this.aliveFor = 0;

    const byName = new Map<string, Bone>();
    const worldOffset = new THREE.Vector3();

    for (const spec of BONES) {
      worldOffset.copy(spec.offset).applyQuaternion(orientation);
      const position = worldOffset.add(origin);

      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(position.x, position.y, position.z)
          .setRotation({ x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w })
          .setLinvel(velocity.x, velocity.y, velocity.z)
          .setLinearDamping(0.45)
          // Generous angular damping: a tumbling ragdoll that keeps spinning
          // never satisfies the settle test, and a rider who never gets up is
          // worse than one who tumbles slightly less dramatically.
          .setAngularDamping(1.6)
          .setCcdEnabled(true),
      );

      this.physics.world.createCollider(
        RAPIER.ColliderDesc.capsule(spec.halfHeight, spec.radius)
          .setMass(spec.mass)
          .setFriction(1.2)
          .setRestitution(0.02)
          .setCollisionGroups(GROUPS_RIDER),
        body,
      );

      const mesh = this.visuals ? this.visuals.create(spec) : this.capsuleVisual(spec);
      this.group.add(mesh);

      const bone: Bone = {
        spec,
        body,
        mesh,
        prevPos: position.clone(),
        currPos: position.clone(),
        prevQuat: orientation.clone(),
        currQuat: orientation.clone(),
      };
      this.bones.push(bone);
      byName.set(spec.name, bone);
    }

    for (const bone of this.bones) {
      const { spec } = bone;
      if (!spec.parent || !spec.anchorOnParent || !spec.anchorOnSelf) continue;
      const parent = byName.get(spec.parent);
      if (!parent) continue;
      const hinge = spec.hinge;
      const data = hinge
        ? RAPIER.JointData.revolute(spec.anchorOnParent, spec.anchorOnSelf, { x: 1, y: 0, z: 0 })
        : RAPIER.JointData.spherical(spec.anchorOnParent, spec.anchorOnSelf);
      const joint = this.physics.world.createImpulseJoint(data, parent.body, bone.body, true);
      if (hinge) (joint as RAPIER.RevoluteImpulseJoint).setLimits(hinge.min, hinge.max);
      this.joints.push(joint);
    }

    const torso = byName.get("torso");
    torso?.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  private capsuleVisual(spec: BoneSpec): THREE.Object3D {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(spec.radius, spec.halfHeight * 2, 4, 10),
      new THREE.MeshStandardMaterial({
        color: spec.name === "head" ? 0xe0c8a0 : this.color,
        roughness: 0.8,
      }),
    );
    mesh.castShadow = true;
    return mesh;
  }

  /** Advances the settle test. Returns true once the rider may start getting up. */
  tick(dtSeconds: number): boolean {
    if (!this.isActive) return false;
    this.aliveFor += dtSeconds;
    this.captureBones();

    let moving = false;
    for (const bone of this.bones) {
      const v = bone.body.linvel();
      const w = bone.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) > SETTLE_LINEAR || Math.hypot(w.x, w.y, w.z) > SETTLE_ANGULAR) {
        moving = true;
        break;
      }
    }

    this.stillFor = moving ? 0 : this.stillFor + dtSeconds;
    return this.stillFor >= SETTLE_HOLD || this.aliveFor >= SETTLE_TIMEOUT;
  }

  /**
   * Shifts each body's current transform into "previous" and reads the new
   * one. Called once per physics step, before it, so the bodies are as the
   * last step left them.
   */
  private captureBones(): void {
    for (const bone of this.bones) {
      bone.prevPos.copy(bone.currPos);
      bone.prevQuat.copy(bone.currQuat);
      const t = bone.body.translation();
      const r = bone.body.rotation();
      bone.currPos.set(t.x, t.y, t.z);
      bone.currQuat.set(r.x, r.y, r.z, r.w);
    }
  }

  /**
   * Draws the bodies between their last two physics states. Without this a
   * fast tumble is drawn straight off the 60 Hz physics, which judders on any
   * display that isn't locked to that rate.
   */
  syncRender(alpha: number): void {
    for (const bone of this.bones) {
      bone.mesh.position.lerpVectors(bone.prevPos, bone.currPos, alpha);
      bone.mesh.quaternion.slerpQuaternions(bone.prevQuat, bone.currQuat, alpha);
    }
  }

  despawn(): void {
    for (const joint of this.joints) this.physics.world.removeImpulseJoint(joint, true);
    this.joints = [];
    for (const bone of this.bones) {
      // Removing the body removes its colliders with it.
      this.physics.world.removeRigidBody(bone.body);
      this.group.remove(bone.mesh);
      // Only the plain-capsule fallback owns its geometry and material; custom visuals share theirs.
      if (!this.visuals) {
        const mesh = bone.mesh as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }
    this.bones = [];
  }

  /** Despawns and releases everything the controller owns. */
  dispose(): void {
    this.despawn();
    this.visuals?.dispose();
    this.scene.remove(this.group);
  }

  /** Fastest-moving body right now, for diagnosing why a ragdoll won't settle. */
  get peakSpeeds(): { linear: number; angular: number } {
    let linear = 0;
    let angular = 0;
    for (const bone of this.bones) {
      const v = bone.body.linvel();
      const w = bone.body.angvel();
      linear = Math.max(linear, Math.hypot(v.x, v.y, v.z));
      angular = Math.max(angular, Math.hypot(w.x, w.y, w.z));
    }
    return { linear, angular };
  }

  /** Elbow and knee angles right now (radians about the hinge axis), for checking the limits hold. */
  get hingeAngles(): Array<{ name: string; angle: number }> {
    const byName = new Map(this.bones.map((b) => [b.spec.name, b]));
    const out: Array<{ name: string; angle: number }> = [];
    for (const bone of this.bones) {
      if (!bone.spec.hinge || !bone.spec.parent) continue;
      const parent = byName.get(bone.spec.parent);
      if (!parent) continue;
      const pr = parent.body.rotation();
      const cr = bone.body.rotation();
      const relative = new THREE.Quaternion(pr.x, pr.y, pr.z, pr.w).invert().multiply(new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w));
      // A hinge about X leaves only the x and w components.
      out.push({ name: bone.spec.name, angle: 2 * Math.atan2(relative.x, relative.w) });
    }
    return out;
  }

  /** Number of live bodies — asserted to return to zero after teardown. */
  get bodyCount(): number {
    return this.bones.length;
  }
}
