import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld";
import { GROUPS_RIDER } from "./CollisionGroups";

/**
 * A simplified jointed ragdoll for knocked-off riders.
 *
 * Seven bodies, six spherical joints. The plan's 6–9 range was deliberate and
 * this sits in it: limbs are one segment each rather than upper/lower pairs,
 * because every extra joint is another constraint for the solver to fight
 * over, and at the size a rider occupies on screen an elbow reads as noise.
 * Fewer, heavier bodies also settle far more reliably, and "settles reliably"
 * is the actual requirement — the recovery state machine can't advance until
 * the ragdoll stops moving.
 *
 * Nothing about the tumble is scripted. The bodies inherit the rider's
 * velocity at the moment of separation plus whatever impulse knocked them
 * off, so a fall at 130 km/h throws them much further than one at 40, which
 * is what the design asks for.
 */

/** Total rider mass in kg, split across the bodies below. */
const RIDER_MASS = 78;

interface BoneSpec {
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
}

const BONES: readonly BoneSpec[] = [
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
    name: "armLeft",
    offset: new THREE.Vector3(0.29, 0.4, 0),
    halfHeight: 0.19,
    radius: 0.07,
    mass: RIDER_MASS * 0.05,
    parent: "torso",
    anchorOnParent: new THREE.Vector3(0.17, 0.14, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.2, 0),
  },
  {
    name: "armRight",
    offset: new THREE.Vector3(-0.29, 0.4, 0),
    halfHeight: 0.19,
    radius: 0.07,
    mass: RIDER_MASS * 0.05,
    parent: "torso",
    anchorOnParent: new THREE.Vector3(-0.17, 0.14, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.2, 0),
  },
  {
    name: "legLeft",
    offset: new THREE.Vector3(0.13, -0.42, 0),
    halfHeight: 0.24,
    radius: 0.09,
    mass: RIDER_MASS * 0.145,
    parent: "pelvis",
    anchorOnParent: new THREE.Vector3(0.11, -0.12, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.28, 0),
  },
  {
    name: "legRight",
    offset: new THREE.Vector3(-0.13, -0.42, 0),
    halfHeight: 0.24,
    radius: 0.09,
    mass: RIDER_MASS * 0.145,
    parent: "pelvis",
    anchorOnParent: new THREE.Vector3(-0.11, -0.12, 0),
    anchorOnSelf: new THREE.Vector3(0, 0.28, 0),
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

interface Bone {
  spec: BoneSpec;
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
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

      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(spec.radius, spec.halfHeight * 2, 4, 10),
        new THREE.MeshStandardMaterial({
          color: spec.name === "head" ? 0xe0c8a0 : this.color,
          roughness: 0.8,
        }),
      );
      mesh.castShadow = true;
      this.group.add(mesh);

      const bone: Bone = { spec, body, mesh };
      this.bones.push(bone);
      byName.set(spec.name, bone);
    }

    for (const bone of this.bones) {
      const { spec } = bone;
      if (!spec.parent || !spec.anchorOnParent || !spec.anchorOnSelf) continue;
      const parent = byName.get(spec.parent);
      if (!parent) continue;
      this.joints.push(
        this.physics.world.createImpulseJoint(
          RAPIER.JointData.spherical(spec.anchorOnParent, spec.anchorOnSelf),
          parent.body,
          bone.body,
          true,
        ),
      );
    }

    const torso = byName.get("torso");
    torso?.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  /** Advances the settle test. Returns true once the rider may start getting up. */
  tick(dtSeconds: number): boolean {
    if (!this.isActive) return false;
    this.aliveFor += dtSeconds;

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

  syncRender(): void {
    for (const bone of this.bones) {
      const t = bone.body.translation();
      const r = bone.body.rotation();
      bone.mesh.position.set(t.x, t.y, t.z);
      bone.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  despawn(): void {
    for (const joint of this.joints) this.physics.world.removeImpulseJoint(joint, true);
    this.joints = [];
    for (const bone of this.bones) {
      // Removing the body removes its colliders with it.
      this.physics.world.removeRigidBody(bone.body);
      this.group.remove(bone.mesh);
      bone.mesh.geometry.dispose();
      (bone.mesh.material as THREE.Material).dispose();
    }
    this.bones = [];
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

  /** Number of live bodies — asserted to return to zero after teardown. */
  get bodyCount(): number {
    return this.bones.length;
  }
}
