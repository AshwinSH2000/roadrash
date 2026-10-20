import * as THREE from "three";

/**
 * A procedural, seated rider built from tapered limbs, rounded pads and a
 * helmet — no asset, no skinning. Same trick the late-90s games used: rigid body parts, each one
 * stretched between two joint positions, with the joints worked out in code.
 *
 * The pose is a set of joint positions in the bike's frame (+Z forward, +Y up,
 * +X the rider's left). Torso and head follow a lean angle; each arm and leg
 * is a two-bone chain solved from a shoulder/hip to a target (a grip on the
 * bar, a foot on the peg). A punch or kick is nothing more than moving that
 * target outward, so every attack animates from the same code as the ride pose.
 */

/** Where the hips sit in the bike's frame, in metres. See the CB750 fit notes in Bike. */
export const HIP = new THREE.Vector3(0, -0.1, -0.4);
const LEAN_DEGREES = 35;
const STAND_LEAN_DEGREES = 50;

const TORSO_LENGTH = 0.5;
const UPPER_ARM = 0.29;
const FOREARM = 0.27;
const THIGH = 0.45;
const SHIN = 0.45;

const SHOULDER_HALF_WIDTH = 0.22;
const HIP_HALF_WIDTH = 0.12;

/** Hand and foot rest positions, bike frame, for the rider's left (+X); mirrored for the right. */
export const GRIP = new THREE.Vector3(0.42, 0.08, 0.24);
export const PEG = new THREE.Vector3(0.26, -0.67, -0.11);

/** How much the hips rise (and shift back) when the rider stands on the pegs, in metres. */
const STAND_RISE = 0.2;
const STAND_BACK = 0.05;
const BATON_LENGTH = 0.7;
/** Height of the ankle joint above the ground when standing, in metres. */
export const FOOT_HEIGHT = 0.08;
/** Hip height above the ground when standing, in metres; the on-foot frame's origin is the ground under the hips. */
export const STANDING_HIP_HEIGHT = 0.84;
/** Shift from a bike-frame point to the on-foot frame once the hips are seated: hips at the standing height. */
export const SEAT_TO_RUNNER = new THREE.Vector3(0, STANDING_HIP_HEIGHT - HIP.y, -HIP.z);

/** A planted foot, bike frame: how far out from the centreline, and how far forward of the hip's own z. */
const FOOT_OUT = 0.34;
const FOOT_FORWARD = 0.0;
/** Walking the bike back: the foot's path along the ground, bike frame z, and how high it lifts on the swing. */
const PADDLE_FRONT = 0.0;
const PADDLE_BACK = -0.5;
const PADDLE_LIFT = 0.14;
/** Head turned over the shoulder to look behind while reversing, radians. */
const REVERSE_HEAD_TURN = 1.25;
const REVERSE_TORSO_TWIST = 0.45;
/** The released arm hangs this far straight down from the shoulder, and a little out (the arm is about 0.56 m long). */
const REVERSE_HANG_DROP = 0.54;
const REVERSE_HANG_OUT = 0.1;
/** Torso shift toward the planted foot at a standstill. */
const IDLE_SWAY = 0.5;

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const ROLL = new THREE.Quaternion();
const BOX = new THREE.BoxGeometry(1, 1, 1);
const HEAD = new THREE.SphereGeometry(1, 14, 10);

/**
 * Darkens a unit-height geometry from one end to the other, in vertex colours:
 * a cheap gradient that gives clothing some form without a texture. Only the
 * jacket and trousers materials read it.
 */
function shaded<T extends THREE.BufferGeometry>(geometry: T, top: number, bottom: number): T {
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const v = THREE.MathUtils.lerp(bottom, top, THREE.MathUtils.clamp(position.getY(i) + 0.5, 0, 1));
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Limb segment: +Y is the far end, a little thinner than the root, so a sleeve or leg tapers. */
const LIMB = shaded(new THREE.CylinderGeometry(0.42, 0.5, 1, 10, 1), 0.78, 1);
/** Torso: wide at the shoulders, narrower at the waist, darker toward the belt. */
const TORSO = shaded(new THREE.CylinderGeometry(0.5, 0.4, 1, 12, 1), 1, 0.72);
/** Ball: pelvis, joints, glove. */
const BALL = shaded(new THREE.SphereGeometry(0.5, 10, 8), 1, 1);
/** Short band that wraps a limb or torso: cuffs, stripes, belt, collar. */
const RING = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1);

/** Adds a band to `mesh`, in the mesh's own unit coordinates (so it follows however the part is stretched). */
function addBand(mesh: THREE.Mesh, material: THREE.Material, y: number, height: number, widthScale: number): void {
  const band = new THREE.Mesh(RING, material);
  band.position.y = y;
  band.scale.set(widthScale, height, widthScale);
  band.frustumCulled = false;
  mesh.add(band);
}

/** A trainer: rounded upper, toe cap and a pale sole. Built with the toe along +Z and the sole at -Y, centred under the ankle. */
function buildShoe(m: RiderMaterials): THREE.Group {
  const shoe = new THREE.Group();
  const piece = (geometry: THREE.BufferGeometry, material: THREE.Material, w: number, h: number, d: number, y: number, z: number): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(0, y, z);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    shoe.add(mesh);
  };
  piece(BALL, m.gear, 0.135, 0.105, 0.32, 0, 0);
  piece(BALL, m.gear, 0.12, 0.09, 0.14, -0.005, 0.13);
  piece(BOX, m.accent, 0.145, 0.028, 0.34, -0.052, 0.01);
  return shoe;
}

/** One body part: a unit shape (limb, torso, ball) stretched between two points. */
class Part {
  readonly mesh: THREE.Mesh;
  private readonly dir = new THREE.Vector3();

  constructor(
    material: THREE.Material,
    private readonly width: number,
    private readonly depth: number,
    geometry: THREE.BufferGeometry = LIMB,
  ) {
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Stretches the part from `a` to `b`, optionally twisted by `roll` radians about its own length. */
  between(a: THREE.Vector3, b: THREE.Vector3, roll = 0): void {
    this.dir.subVectors(b, a);
    const length = Math.max(this.dir.length(), 1e-4);
    this.dir.divideScalar(length);
    this.mesh.position.addVectors(a, b).multiplyScalar(0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, this.dir);
    if (roll !== 0) this.mesh.quaternion.premultiply(ROLL.setFromAxisAngle(this.dir, roll));
    this.mesh.scale.set(this.width, length, this.depth);
  }
}

/** A ball that sits at a joint: a shoulder, elbow, knee or hip pad. */
class Pad {
  readonly mesh: THREE.Mesh;

  constructor(material: THREE.Material, size: THREE.Vector3) {
    this.mesh = new THREE.Mesh(BALL, material);
    this.mesh.scale.copy(size);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }
}

/** What a limb wears beyond its two segments and end cap. */
interface LimbStyle {
  rootPad: { material: THREE.Material; size: THREE.Vector3 };
  midPad: { material: THREE.Material; size: THREE.Vector3 };
  /** Contrasting band at the far end of the lower segment: a glove cuff or boot top. */
  cuff: THREE.Material;
  endGeometry: THREE.BufferGeometry;
  /** Legs end in a shoe; arms in a glove. */
  shoe: boolean;
}

/** A two-bone limb: upper + lower segment, joint pads, plus an end cap (glove / boot). */
class Limb {
  readonly upper: Part;
  readonly lower: Part;
  readonly end: Part;
  private readonly rootPad: Pad;
  private readonly midPad: Pad;
  private readonly shoe: THREE.Group | null;
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpOffset = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly capA = new THREE.Vector3();
  private readonly capB = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  /** Unit direction the lower segment points, valid after `solve`. */
  readonly forward = new THREE.Vector3();

  constructor(
    clothing: THREE.Material,
    endMaterial: THREE.Material,
    private readonly lengthA: number,
    private readonly lengthB: number,
    thickness: number,
    endSize: THREE.Vector3,
    style: LimbStyle,
    materials: RiderMaterials,
  ) {
    this.upper = new Part(clothing, thickness, thickness);
    this.lower = new Part(clothing, thickness * 0.85, thickness * 0.85);
    this.end = new Part(endMaterial, endSize.x, endSize.z, style.endGeometry);
    this.endLength = endSize.y;
    this.rootPad = new Pad(style.rootPad.material, style.rootPad.size);
    this.midPad = new Pad(style.midPad.material, style.midPad.size);
    addBand(this.lower.mesh, style.cuff, 0.4, 0.14, 1.12);
    this.shoe = style.shoe ? buildShoe(materials) : null;
  }

  private readonly endLength: number;

  /** Solves root -> target with the joint bending toward `pole`, then places the parts. */
  solve(root: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, tip: THREE.Vector3): void {
    const toTarget = this.aim.subVectors(target, root);
    const reach = THREE.MathUtils.clamp(toTarget.length(), 0.05, this.lengthA + this.lengthB - 1e-3);
    toTarget.normalize();
    const along = (this.lengthA * this.lengthA - this.lengthB * this.lengthB + reach * reach) / (2 * reach);
    const height = Math.sqrt(Math.max(this.lengthA * this.lengthA - along * along, 0));
    const bend = this.bend.copy(pole).addScaledVector(toTarget, -pole.dot(toTarget)).normalize();

    this.mid.copy(root).addScaledVector(toTarget, along).addScaledVector(bend, height);
    // The tip lands where the chain actually reaches, not where it was asked to.
    tip.copy(root).addScaledVector(toTarget, reach);

    this.place(root, this.mid, tip);
  }

  /** Places the parts along root -> mid -> tip directly, for poses worked out by forward kinematics. */
  place(root: THREE.Vector3, mid: THREE.Vector3, tip: THREE.Vector3): void {
    this.forward.subVectors(tip, mid).normalize();
    this.rootPad.mesh.position.copy(root);
    this.midPad.mesh.position.copy(mid);
    this.upper.between(root, mid);
    this.lower.between(mid, tip);
    // The glove / boot is centred on the tip and follows the lower segment.
    this.capA.copy(tip).addScaledVector(this.forward, -this.endLength * 0.5);
    this.capB.copy(tip).addScaledVector(this.forward, this.endLength * 0.5);
    this.end.between(this.capA, this.capB);
    if (this.shoe) {
      // The foot hangs off the ankle at a right angle to the shin, so it tilts with it.
      this.tmpQuat.setFromUnitVectors(DOWN, this.forward);
      this.shoe.quaternion.copy(this.tmpQuat);
      this.shoe.position.copy(tip).add(this.tmpOffset.set(0, -0.05, 0.085).applyQuaternion(this.tmpQuat));
    }
  }

  get parts(): { mesh: THREE.Object3D }[] {
    return this.shoe ? [this.upper, this.lower, this.end, this.rootPad, this.midPad, { mesh: this.shoe }] : [this.upper, this.lower, this.end, this.rootPad, this.midPad];
  }
}

/** The five materials every rider wears, so the seated, running and tumbling figures match. */
interface RiderMaterials {
  jacket: THREE.Material;
  pants: THREE.Material;
  gear: THREE.Material;
  helmet: THREE.Material;
  visor: THREE.Material;
  baton: THREE.Material;
  /** Contrast trim: stripes, cuffs, helmet band. A light tint of the rider's colour. */
  accent: THREE.Material;
  all: THREE.Material[];
}

function createMaterials(color: number): RiderMaterials {
  const make = (c: number, roughness: number, vertexColors = false): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: c, roughness, vertexColors });
  const jacket = make(new THREE.Color(color).multiplyScalar(0.8).getHex(), 0.7, true);
  const pants = make(0x23262e, 0.85, true);
  const gear = make(0x15161a, 0.6);
  // Glossy shell, and a visor that is clearly a different surface from it.
  const helmet = new THREE.MeshStandardMaterial({ color, roughness: 0.22, metalness: 0.15 });
  const visor = new THREE.MeshStandardMaterial({ color: 0x0f1a26, roughness: 0.08, metalness: 0.4, side: THREE.DoubleSide });
  const baton = make(0x1b1c20, 0.4);
  const accent = make(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.78).getHex(), 0.5);
  return { jacket, pants, gear, helmet, visor, baton, accent, all: [jacket, pants, gear, helmet, visor, baton, accent] };
}

/** Pads: shoulders in the jacket's fabric, elbows and knees in dark armour, hips in the trousers'. */
function limbStyle(m: RiderMaterials, kind: "arm" | "leg"): LimbStyle {
  return kind === "arm"
    ? {
        rootPad: { material: m.jacket, size: new THREE.Vector3(0.14, 0.135, 0.14) },
        midPad: { material: m.gear, size: new THREE.Vector3(0.115, 0.115, 0.115) },
        cuff: m.accent,
        endGeometry: BALL,
        shoe: false,
      }
    : {
        rootPad: { material: m.pants, size: new THREE.Vector3(0.19, 0.18, 0.19) },
        midPad: { material: m.gear, size: new THREE.Vector3(0.155, 0.16, 0.155) },
        cuff: m.accent,
        endGeometry: RING,
        shoe: true,
      };
}

/** Chest stripes, a belt and a collar on a torso mesh made from `TORSO`, in its unit coordinates. */
function dressTorso(torso: THREE.Mesh, m: RiderMaterials): void {
  // The torso narrows toward the belt, so each band is sized to the radius at its height.
  const radiusAt = (y: number): number => 0.45 + 0.1 * y;
  addBand(torso, m.accent, 0.16, 0.07, 2 * radiusAt(0.16) * 1.04);
  addBand(torso, m.accent, 0.03, 0.05, 2 * radiusAt(0.03) * 1.04);
  addBand(torso, m.gear, -0.46, 0.1, 2 * radiusAt(-0.46) * 1.05);
  addBand(torso, m.gear, 0.5, 0.1, 0.44);
}

/** The helmet: glossy shell, wrap-around visor, chin guard, top stripe and a small rear spoiler. */
function buildHelmet(m: RiderMaterials): THREE.Mesh {
  const shell = new THREE.Mesh(HEAD, m.helmet);
  shell.scale.set(0.14, 0.15, 0.16);
  shell.castShadow = true;
  shell.frustumCulled = false;

  // Sphere slices hugging the shell, in its unit coordinates. +Z is forward.
  const slice = (radius: number, phi0: number, phiLen: number, theta0: number, thetaLen: number, material: THREE.Material): void => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 5, phi0, phiLen, theta0, thetaLen), material);
    mesh.frustumCulled = false;
    shell.add(mesh);
  };
  const front = Math.PI / 2;
  slice(1.025, front - 1.0, 2.0, 1.25, 0.6, m.visor);
  // Centre stripe: front wedge from the crown to the brow, back wedge to the nape.
  slice(1.012, front - 0.13, 0.26, 0, 1.15, m.accent);
  slice(1.012, front + Math.PI - 0.13, 0.26, 0, 2.3, m.accent);

  const chin = new THREE.Mesh(BALL, m.helmet);
  chin.scale.set(1.0, 0.8, 0.9);
  chin.position.set(0, -0.62, 0.55);
  chin.frustumCulled = false;
  shell.add(chin);

  const spoiler = new THREE.Mesh(BOX, m.gear);
  spoiler.scale.set(0.7, 0.1, 0.4);
  spoiler.position.set(0, 0.42, -0.88);
  spoiler.rotation.x = -0.35;
  spoiler.frustumCulled = false;
  shell.add(spoiler);
  return shell;
}

/** Just what a ragdoll bone's visual needs to know about its body. */
export interface RagdollPartSpec {
  name: string;
  halfHeight: number;
  radius: number;
}

/**
 * Dresses the physics ragdoll's bodies as the rider: each one gets the matching
 * jacket, trousers, helmet, glove or boot, sized to the capsule it replaces.
 * The physics stays one rigid capsule per limb; only what is drawn changes.
 */
export class RagdollVisuals {
  private readonly materials: RiderMaterials;

  constructor(color: number) {
    this.materials = createMaterials(color);
  }

  create(spec: RagdollPartSpec): THREE.Object3D {
    const m = this.materials;
    const part = new THREE.Group();
    /** A shape of the given size, `y` up the bone. `flip` turns it end for end, so a limb's thin end points away from the body. */
    const shape = (geometry: THREE.BufferGeometry, material: THREE.Material, w: number, h: number, d: number, y = 0, flip = false): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(w, h, d);
      mesh.position.y = y;
      if (flip) mesh.rotation.x = Math.PI;
      mesh.castShadow = true;
      return mesh;
    };
    if (spec.name === "pelvis") {
      part.add(shape(BALL, m.pants, 0.34, 0.26, 0.23));
    } else if (spec.name === "torso") {
      const torso = shape(TORSO, m.jacket, 0.38, 0.6, 0.22);
      dressTorso(torso, m);
      part.add(torso);
    } else if (spec.name === "head") {
      part.add(buildHelmet(m));
    } else if (spec.name.startsWith("upperArm")) {
      // The shoulder is at the +Y end.
      part.add(shape(LIMB, m.jacket, 0.13, 0.3, 0.13, 0, true));
      part.add(shape(BALL, m.jacket, 0.14, 0.135, 0.14, 0.16));
    } else if (spec.name.startsWith("foreArm")) {
      // The elbow is at the +Y end, the hand at -Y.
      part.add(shape(LIMB, m.jacket, 0.11, 0.26, 0.11, 0.03, true));
      part.add(shape(BALL, m.gear, 0.115, 0.115, 0.115, 0.145));
      const cuff = new THREE.Mesh(RING, m.accent);
      cuff.scale.set(0.12, 0.035, 0.12);
      cuff.position.y = -0.085;
      part.add(cuff);
      part.add(shape(BALL, m.gear, 0.11, 0.1, 0.11, -spec.halfHeight - spec.radius + 0.05));
    } else if (spec.name.startsWith("upperLeg")) {
      part.add(shape(LIMB, m.pants, 0.18, 0.4, 0.18, 0, true));
    } else {
      // Knee at +Y, boot at -Y.
      part.add(shape(LIMB, m.pants, 0.155, 0.28, 0.155, 0.05, true));
      part.add(shape(BALL, m.gear, 0.155, 0.16, 0.155, 0.195));
      const top = new THREE.Mesh(RING, m.accent);
      top.scale.set(0.15, 0.035, 0.15);
      top.position.y = -0.1;
      part.add(top);
      part.add(shape(RING, m.gear, 0.14, 0.12, 0.15, -0.13));
      const shoe = buildShoe(m);
      shoe.position.set(0, -spec.halfHeight - spec.radius - 0.05, 0.085);
      part.add(shoe);
    }
    return part;
  }

  dispose(): void {
    // Box and sphere geometry are shared module-wide; only materials are owned.
    for (const material of this.materials.all) material.dispose();
  }
}

export type StrikeKind = "punch" | "kick";

/** Seconds of each attack phase; structurally the same as the combat system's attack definitions. */
export interface AttackTiming {
  windup: number;
  active: number;
  recovery: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 0 before `a`, 1 after `b`, linear between. */
const seg = (e: number, a: number, b: number): number => (b <= a ? (e >= b ? 1 : 0) : clamp01((e - a) / (b - a)));
const smooth = (u: number): number => u * u * (3 - 2 * u);
/** Slow start, fast finish: a swing that peaks in speed at the moment of impact. */
const whip = (u: number): number => u * u * u;
const lerp = THREE.MathUtils.lerp;

/**
 * A punch is a baton, and a kick is thrown standing on the pegs. Both land at
 * the end of the wind-up, which is the instant the combat system resolves the
 * hit, so the visible blow and the fall it causes happen together.
 */
export class RiderModel {
  /** Add this to the bike's group. Hidden while the rider is off the bike. */
  readonly object = new THREE.Group();

  private readonly materials: RiderMaterials;
  private readonly torso: Part;
  private readonly pelvis: Part;
  private readonly baton: Part;
  private readonly helmet: THREE.Mesh;
  /** Index 0 = rider's left (+X), 1 = right (-X). */
  private readonly arms: Limb[];
  private readonly legs: Limb[];

  /** Where each hand holds the bar right now; moved by `setGrips` as the bars turn. */
  private readonly grips = [GRIP.clone(), GRIP.clone().setX(-GRIP.x)];
  private readonly pegs = [PEG.clone(), PEG.clone().setX(-PEG.x)];

  private attackKind: StrikeKind | null = null;
  /** -1 or +1: which x side (rider's left = +1) the thrown limb is on. */
  private attackSign = 0;
  private attackTime = 0;
  private timing: AttackTiming = { windup: 0.3, active: 0.1, recovery: 0.3 };

  // Posture, recomputed from the attack each update.
  private stand = 0;
  private twist = 0;
  private sway = 0;
  private batonShown = false;

  // Feet on the ground: a stopped bike has one foot down, a reversing one has both paddling.
  /** 0..1: how far the planted foot is down (stationary). */
  private footDown = 0;
  /** Which leg is planted when stationary: +1 rider's left (+X), -1 right. */
  private footSide = 1;
  /** 0..1: how far into reversing the rider is. */
  private reverseAmount = 0;
  /** Paddle cycle, radians; one full turn is one step with each foot. */
  private paddlePhase = 0;
  /** A point on the ground under the bike and its normal, in bike frame. */
  private readonly groundPoint = new THREE.Vector3(0, -0.96, 0);
  private readonly groundNormal = new THREE.Vector3(0, 1, 0);

  private readonly shoulder = new THREE.Vector3();
  private readonly hip = new THREE.Vector3();
  private readonly hipCentre = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly tip = new THREE.Vector3();
  private readonly base = new THREE.Vector3();
  private readonly top = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();

  constructor(color: number) {
    const m = (this.materials = createMaterials(color));
    const { jacket, pants, gear } = m;
    const batonMaterial = m.baton;

    this.pelvis = new Part(pants, 0.32, 0.22, BALL);
    this.torso = new Part(jacket, 0.38, 0.22, TORSO);
    dressTorso(this.torso.mesh, m);
    this.baton = new Part(batonMaterial, 0.05, 0.05);
    this.baton.mesh.visible = false;
    this.object.add(this.pelvis.mesh, this.torso.mesh, this.baton.mesh);

    this.helmet = buildHelmet(m);
    this.object.add(this.helmet);

    this.arms = [0, 1].map(
      () => new Limb(jacket, gear, UPPER_ARM, FOREARM, 0.13, new THREE.Vector3(0.11, 0.1, 0.11), limbStyle(m, "arm"), m),
    );
    this.legs = [0, 1].map(
      () => new Limb(pants, gear, THIGH, SHIN, 0.18, new THREE.Vector3(0.13, 0.12, 0.13), limbStyle(m, "leg"), m),
    );
    for (const limb of [...this.arms, ...this.legs]) for (const part of limb.parts) this.object.add(part.mesh);

    this.update();
  }

  /**
   * Plays an attack at `elapsed` seconds in. `side` follows `Bike.setStrike`:
   * +1 throws to the bike's right (-X), -1 to its left. `kind` null returns
   * the rider to the plain ride pose.
   */
  setAttack(kind: StrikeKind | null, side: number, elapsed: number, timing: AttackTiming): void {
    const active = kind !== null && side !== 0;
    const nextKind = active ? kind : null;
    const sign = active ? -Math.sign(side) : 0;
    if (nextKind === this.attackKind && sign === this.attackSign && Math.abs(elapsed - this.attackTime) < 1e-4) return;
    this.attackKind = nextKind;
    this.attackSign = sign;
    this.attackTime = elapsed;
    this.timing = timing;
    this.update();
  }

  /**
   * Moves both hands to where the bar grips now are (bike frame). Called as
   * the handlebar turns, so the arms follow it. A no-op when nothing moved.
   */
  setGrips(left: THREE.Vector3, right: THREE.Vector3): void {
    if (this.grips[0].distanceToSquared(left) < 1e-8 && this.grips[1].distanceToSquared(right) < 1e-8) return;
    this.grips[0].copy(left);
    this.grips[1].copy(right);
    this.update();
  }

  /**
   * Puts feet on the ground. `footDown` (0..1) plants one foot at a standstill,
   * on `footSide` (+1 left, -1 right); `reverse` (0..1) puts both down and
   * walks the bike backwards, `phase` being where in the paddle cycle they
   * are. `groundPoint` and `groundNormal` describe the road in bike frame, so
   * the feet land on it however the bike is leaned or pitched.
   */
  setStance(
    footDown: number,
    footSide: number,
    reverse: number,
    phase: number,
    groundPoint: THREE.Vector3,
    groundNormal: THREE.Vector3,
  ): void {
    if (
      Math.abs(footDown - this.footDown) < 1e-4 &&
      footSide === this.footSide &&
      Math.abs(reverse - this.reverseAmount) < 1e-4 &&
      (reverse < 1e-4 || Math.abs(phase - this.paddlePhase) < 1e-4) &&
      this.groundPoint.distanceToSquared(groundPoint) < 1e-8 &&
      this.groundNormal.distanceToSquared(groundNormal) < 1e-8
    ) {
      return;
    }
    this.footDown = footDown;
    this.footSide = footSide;
    this.reverseAmount = reverse;
    this.paddlePhase = phase;
    this.groundPoint.copy(groundPoint);
    this.groundNormal.copy(groundNormal);
    this.update();
  }

  /** Height of the ground in bike frame at lateral position `x`, plus a foot's own thickness. */
  private groundHeight(x: number): number {
    const n = this.groundNormal;
    return this.groundPoint.y - (n.x / Math.max(n.y, 0.2)) * (x - this.groundPoint.x) + FOOT_HEIGHT;
  }

  /** Writes where the foot on `sign`'s side should be on the ground into `out`, for the current stance. */
  private groundFoot(out: THREE.Vector3, sign: number): THREE.Vector3 {
    const x = sign * FOOT_OUT;
    // Paddling: half a cycle apart. A planted foot slides forward relative to
    // the bike as the bike goes back; the swing lifts it and carries it back.
    const cycle = ((((this.paddlePhase / (2 * Math.PI)) + (sign > 0 ? 0 : 0.5)) % 1) + 1) % 1;
    let z = FOOT_FORWARD;
    let lift = 0;
    if (this.reverseAmount > 0) {
      if (cycle < 0.5) {
        z = lerp(PADDLE_BACK, PADDLE_FRONT, cycle / 0.5);
      } else {
        const v = (cycle - 0.5) / 0.5;
        z = lerp(PADDLE_FRONT, PADDLE_BACK, smooth(v));
        lift = PADDLE_LIFT * Math.sin(Math.PI * v);
      }
      z = lerp(FOOT_FORWARD, z, this.reverseAmount);
      lift *= this.reverseAmount;
    }
    return out.set(x, this.groundHeight(x) + lift, z);
  }

  /** Sets stand / twist / sway / baton for the current attack time. */
  private computePosture(): void {
    this.stand = 0;
    this.twist = 0;
    this.sway = 0;
    this.batonShown = false;
    this.twist += REVERSE_TORSO_TWIST * this.reverseAmount;
    this.sway += this.footSide * IDLE_SWAY * this.footDown * (1 - this.reverseAmount);
    if (!this.attackKind) return;

    const e = this.attackTime;
    const { windup: W, active: A, recovery: R } = this.timing;
    const s = this.attackSign;
    const end = W + A;

    if (this.attackKind === "punch") {
      const draw = 0.35 * W;
      const cock = 0.7 * W;
      // Half-rise onto the pegs for leverage, held through the follow-through.
      this.stand = 0.55 * smooth(seg(e, 0, 0.7 * W)) * (1 - smooth(seg(e, end, end + 0.6 * R)));
      // Chest winds away from the target, then whips through it.
      let twist: number;
      if (e < cock) twist = lerp(0, -0.45, smooth(seg(e, draw, cock)));
      else if (e < W) twist = lerp(-0.45, 0.4, whip(seg(e, cock, W)));
      else if (e < end) twist = lerp(0.4, 0.45, seg(e, W, end));
      else twist = 0.45 * (1 - smooth(seg(e, end, end + 0.8 * R)));
      this.twist += s * twist;
      this.batonShown = e > 0.8 * draw && e < end + 0.45 * R;
    } else {
      this.stand = smooth(seg(e, 0, 0.55 * W)) * (1 - smooth(seg(e, end + 0.15 * R, end + 0.75 * R)));
      let k: number;
      if (e < 0.35 * W) k = 0;
      else if (e < 0.72 * W) k = lerp(0, 0.4, smooth(seg(e, 0.35 * W, 0.72 * W)));
      else if (e < W) k = lerp(0.4, 1, whip(seg(e, 0.72 * W, W)));
      else if (e < end) k = 1;
      else k = 1 - smooth(seg(e, end, end + 0.5 * R));
      // Throws the upper body away from the kick to counterbalance it.
      this.sway += -s * k;
      this.twist += s * 0.25 * k;
    }
  }

  /** Writes where the thrown hand should be into `out` (bike frame), for a punch at the current time. */
  private punchHand(out: THREE.Vector3, grip: THREE.Vector3): void {
    const e = this.attackTime;
    const { windup: W, active: A, recovery: R } = this.timing;
    const s = this.attackSign;
    const end = W + A;
    const draw = 0.35 * W;
    const cockEnd = 0.7 * W;

    const belt = this.a.set(s * 0.1, this.hipCentre.y + 0.12, this.hipCentre.z + 0.2);
    const cock = this.b.copy(this.top).add(this.scratch.set(s * 0.3, 0.3, -0.2));
    const impact = this.c.set(s * 0.62, this.top.y - 0.25, 0.3);
    const follow = this.scratch.set(s * 0.62, this.top.y - 0.55, 0.45);

    if (e < draw) {
      out.lerpVectors(grip, belt, smooth(seg(e, 0, draw)));
    } else if (e < cockEnd) {
      out.lerpVectors(belt, cock, smooth(seg(e, draw, cockEnd)));
    } else if (e < W) {
      // Quadratic arc up and out, then down into the blow.
      const u = whip(seg(e, cockEnd, W));
      const control = out.copy(this.top).add(this.tip.set(s * 0.55, 0.3, 0.1));
      const k0 = (1 - u) * (1 - u);
      const k1 = 2 * (1 - u) * u;
      const k2 = u * u;
      out.set(
        cock.x * k0 + control.x * k1 + impact.x * k2,
        cock.y * k0 + control.y * k1 + impact.y * k2,
        cock.z * k0 + control.z * k1 + impact.z * k2,
      );
    } else if (e < end) {
      out.lerpVectors(impact, follow, smooth(seg(e, W, end)));
    } else if (e < end + 0.45 * R) {
      out.lerpVectors(follow, belt, smooth(seg(e, end, end + 0.45 * R)));
    } else {
      out.lerpVectors(belt, grip, smooth(seg(e, end + 0.45 * R, end + 0.85 * R)));
    }
  }

  /** Writes where the kicking foot should be into `out` (bike frame) at the current time. */
  private kickFoot(out: THREE.Vector3, peg: THREE.Vector3): void {
    const e = this.attackTime;
    const { windup: W, active: A, recovery: R } = this.timing;
    const s = this.attackSign;
    const end = W + A;

    const chamber = this.a.set(s * 0.28, this.hip.y - 0.1, this.hip.z + 0.5);
    const impact = this.b.set(s * 1.12, this.hip.y - 0.05, this.hip.z + 0.22);

    if (e < 0.35 * W) {
      out.copy(peg);
    } else if (e < 0.72 * W) {
      out.lerpVectors(peg, chamber, smooth(seg(e, 0.35 * W, 0.72 * W)));
    } else if (e < W) {
      out.lerpVectors(chamber, impact, whip(seg(e, 0.72 * W, W)));
    } else if (e < end) {
      out.copy(impact).add(this.scratch.set(s * 0.05, 0.03, 0.05).multiplyScalar(seg(e, W, end)));
    } else if (e < end + 0.3 * R) {
      out.lerpVectors(impact, chamber, smooth(seg(e, end, end + 0.3 * R)));
    } else {
      out.lerpVectors(chamber, peg, smooth(seg(e, end + 0.3 * R, end + 0.7 * R)));
    }
  }

  /**
   * Places pelvis, torso and head from `hipCentre`: the spine tipped forward
   * by `lean` (radians) and sideways by `sway`, the chest twisted by `twist`.
   * Leaves `base` and `top` set for the callers' shoulder maths.
   */
  private placeBody(lean: number, twist: number, sway: number): void {
    const sin = Math.sin(lean);
    const cos = Math.cos(lean);
    this.base.copy(this.hipCentre).add(this.scratch.set(0, 0.06, 0));
    this.top.copy(this.base).add(this.scratch.set(sway * 0.18, cos * TORSO_LENGTH, sin * TORSO_LENGTH));
    this.pelvis.between(this.scratch.copy(this.hipCentre).add(this.hip.set(0, -0.04, 0)), this.base);
    this.torso.between(this.base, this.top, twist);

    // Head sits on the shoulders, tilted up from the torso so the rider looks ahead.
    this.helmet.position.copy(this.top).add(this.scratch.set(0, 0.12, 0.07));
    // Looks back over the left shoulder while reversing.
    this.helmet.rotation.set(lean * 0.3, twist * 0.7 + REVERSE_HEAD_TURN * this.reverseAmount, 0);
  }

  /** Where a shoulder sits on the (possibly twisted) torso; `sign` +1 left, -1 right. */
  private shoulderPoint(out: THREE.Vector3, sign: number): THREE.Vector3 {
    return out
      .set(sign * SHOULDER_HALF_WIDTH, TORSO_LENGTH * 0.5 - 0.05, 0)
      .applyQuaternion(this.torso.mesh.quaternion)
      .add(this.torso.mesh.position);
  }

  /** Re-solves every joint from the current attack, lean and grips. */
  private update(): void {
    this.computePosture();

    const lean = THREE.MathUtils.degToRad(lerp(LEAN_DEGREES, STAND_LEAN_DEGREES, this.stand));
    // Standing on the pegs lifts and shifts the hips; sway shifts them sideways.
    this.hipCentre.copy(HIP).add(this.scratch.set(this.sway * 0.06, STAND_RISE * this.stand, -STAND_BACK * this.stand));
    this.placeBody(lean, this.twist, this.sway);

    // sign = +1 left (+X), -1 right (-X).
    for (const [index, sign] of [[0, 1], [1, -1]] as const) {
      const striking = this.attackKind !== null && this.attackSign === sign;

      // Arm: shoulder follows the (twisted) torso.
      this.shoulderPoint(this.shoulder, sign);
      if (striking && this.attackKind === "punch") this.punchHand(this.target, this.grips[index]);
      else this.target.copy(this.grips[index]);
      // Reversing, the arm on the side he is looking over lets go of the bar
      // and simply hangs from the shoulder.
      if (sign > 0 && this.reverseAmount > 0 && !(striking && this.attackKind === "punch")) {
        this.target.lerp(this.a.copy(this.shoulder).add(this.scratch.set(sign * REVERSE_HANG_OUT, -REVERSE_HANG_DROP, 0)), smooth(clamp01(this.reverseAmount)));
      }
      this.pole.set(sign, -0.5, -0.2);
      this.arms[index].solve(this.shoulder, this.target, this.pole, this.tip);
      if (striking && this.attackKind === "punch") {
        // The baton continues the forearm from inside the fist.
        const f = this.arms[index].forward;
        this.a.copy(this.tip).addScaledVector(f, -0.08);
        this.b.copy(this.tip).addScaledVector(f, BATON_LENGTH);
        this.baton.between(this.a, this.b);
      }

      // Leg: hip -> peg, or thrown out in a kick.
      this.hip.copy(this.hipCentre).add(this.scratch.set(sign * HIP_HALF_WIDTH, 0, 0));
      if (striking && this.attackKind === "kick") this.kickFoot(this.target, this.pegs[index]);
      else {
        this.target.copy(this.pegs[index]);
        // Feet down: the planted one at a standstill, both when reversing.
        const down = Math.max(this.reverseAmount, sign === this.footSide ? this.footDown : 0);
        if (down > 0) this.target.lerp(this.groundFoot(this.c, sign), smooth(clamp01(down)));
      }
      this.pole.set(sign * 0.3, 0.2, 1);
      this.legs[index].solve(this.hip, this.target, this.pole, this.tip);
    }
    this.baton.mesh.visible = this.batonShown;
  }

  /**
   * On-foot poses, for the rider after a fall. These use a different frame to
   * the seated rider: the origin is on the ground under the hips, +Z forward.
   * Legs are IK to feet that follow a stride path (planted in stance, lifted
   * and swung forward in the air), arms are forward kinematics pumping in
   * opposition to the legs, and the hips bob twice per stride.
   */

  /** A run cycle: `phase` in radians (one stride = 2π), `amplitude` 0 (standing) to 1 (full run). */
  setRun(phase: number, amplitude: number): void {
    this.batonOff();
    const a = clamp01(amplitude);
    this.hipCentre.set(0, STANDING_HIP_HEIGHT - 0.04 * a * Math.cos(2 * phase - 0.8 * Math.PI), 0);
    this.placeBody(THREE.MathUtils.degToRad(3 + 11 * a), 0.3 * a * Math.sin(phase), 0);

    const stance = 0.35;
    const half = 0.45 * a;
    for (const [index, sign] of [[0, 1], [1, -1]] as const) {
      // Foot: on the ground and sliding back during stance, then lifted and swung forward.
      const cycle = (((phase + (sign > 0 ? 0 : Math.PI)) / (2 * Math.PI)) % 1 + 1) % 1;
      let z: number;
      let lift = 0;
      if (cycle < stance) {
        z = lerp(half, -half, cycle / stance);
      } else {
        const v = (cycle - stance) / (1 - stance);
        z = lerp(-half, half, smooth(v));
        lift = 0.32 * a * Math.sin(Math.PI * v);
      }
      this.hip.set(sign * HIP_HALF_WIDTH, this.hipCentre.y, 0);
      this.target.set(sign * HIP_HALF_WIDTH, FOOT_HEIGHT + lift, z);
      this.pole.set(sign * 0.15, 0.1, 1);
      this.legs[index].solve(this.hip, this.target, this.pole, this.tip);

      // Arm: swings opposite to the same-side leg, elbow bent about a right angle when running.
      const swing = -sign * 0.7 * a * Math.cos(phase);
      this.pumpArm(index, sign, swing, lerp(0.35, 1.35, a) - 0.2 * swing);
    }
  }

  /** Getting up off the ground: `progress` 0 (crouched, hands pushing) to 1 (standing). */
  setGetUp(progress: number): void {
    this.batonOff();
    const p = smooth(clamp01(progress));
    this.hipCentre.set(0, lerp(0.3, STANDING_HIP_HEIGHT, p), lerp(-0.12, 0, p));
    this.placeBody(THREE.MathUtils.degToRad(lerp(80, 14, p)), 0, 0);

    for (const [index, sign] of [[0, 1], [1, -1]] as const) {
      // Feet tucked under and behind the hips so the knees fold forward.
      this.hip.set(sign * HIP_HALF_WIDTH, this.hipCentre.y, this.hipCentre.z);
      this.target.set(sign * HIP_HALF_WIDTH, FOOT_HEIGHT, lerp(-0.25, 0, p));
      this.pole.set(sign * 0.15, 0.1, 1);
      this.legs[index].solve(this.hip, this.target, this.pole, this.tip);

      // Hands on the ground ahead at first, then released to hang.
      this.shoulderPoint(this.shoulder, sign);
      const hang = this.a.copy(this.shoulder).add(this.scratch.set(sign * 0.04, -0.5, 0.12));
      this.target.set(sign * 0.24, 0.05, this.shoulder.z + 0.1);
      this.target.lerp(hang, smooth(seg(progress, 0.45, 0.95)));
      this.pole.set(sign, -0.5, -0.3);
      this.arms[index].solve(this.shoulder, this.target, this.pole, this.tip);
    }
  }

  /**
   * Bending down to haul a fallen bike upright: crouched with the chest
   * tipped over at first, rising as the bike comes up. Hands go to the two
   * targets (runner-local frame), assigned to whichever hand is nearer each.
   */
  setPickUp(progress: number, targetA: THREE.Vector3, targetB: THREE.Vector3): void {
    this.batonOff();
    const crouch = smooth(seg(progress, 0, 0.3));
    const rise = smooth(seg(progress, 0.3, 1));
    const hipY = lerp(lerp(STANDING_HIP_HEIGHT, 0.46, crouch), 0.64, rise);
    const lean = THREE.MathUtils.degToRad(lerp(lerp(14, 62, crouch), 42, rise));
    this.hipCentre.set(0, hipY, -0.12 * crouch * (1 - rise));
    this.placeBody(lean, 0, 0);

    const leftFirst = targetA.x >= targetB.x;
    for (const [index, sign] of [[0, 1], [1, -1]] as const) {
      // Staggered stance, knees folding forward.
      this.hip.set(sign * HIP_HALF_WIDTH, this.hipCentre.y, this.hipCentre.z);
      this.target.set(sign * 0.16, FOOT_HEIGHT, sign > 0 ? 0.12 : -0.14);
      this.pole.set(sign * 0.15, 0.1, 1);
      this.legs[index].solve(this.hip, this.target, this.pole, this.tip);

      this.shoulderPoint(this.shoulder, sign);
      this.target.copy((sign > 0) === leftFirst ? targetA : targetB);
      this.pole.set(sign, -0.5, -0.3);
      this.arms[index].solve(this.shoulder, this.target, this.pole, this.tip);
    }
  }

  /**
   * The hurried hop onto the seat. The figure's frame is the runner's
   * (origin on the ground under the hips) and is expected to be carried along
   * a path that ends with the hips on the seat, facing along the bike; at
   * progress 1 this pose is the seated ride pose, so the swap to the seated
   * model is seamless. Seated joint positions are the bike-frame ones shifted
   * by `SEAT_TO_RUNNER`.
   */
  setHop(progress: number): void {
    this.batonOff();
    const p = clamp01(progress);
    this.hipCentre.set(0, STANDING_HIP_HEIGHT, 0);
    this.placeBody(THREE.MathUtils.degToRad(lerp(14, LEAN_DEGREES, smooth(p))), 0, 0);

    const legTuck = Math.sin(Math.PI * p);
    for (const [index, sign] of [[0, 1], [1, -1]] as const) {
      // Feet leave the ground, swing up and over, and land on the pegs.
      this.hip.set(sign * HIP_HALF_WIDTH, this.hipCentre.y, 0);
      const swing = smooth(seg(p, 0.1, 0.9));
      this.target.set(
        lerp(sign * 0.12, sign * PEG.x, swing),
        lerp(FOOT_HEIGHT, PEG.y + SEAT_TO_RUNNER.y, swing) + 0.3 * legTuck,
        lerp(0, PEG.z + SEAT_TO_RUNNER.z, swing) + 0.1 * legTuck,
      );
      this.pole.set(sign * 0.3, 0.2, 1);
      this.legs[index].solve(this.hip, this.target, this.pole, this.tip);

      // Hands grab the bars as the body arrives.
      this.shoulderPoint(this.shoulder, sign);
      const hang = this.a.copy(this.shoulder).add(this.scratch.set(sign * 0.04, -0.5, 0.12));
      this.target.set(sign * GRIP.x, GRIP.y + SEAT_TO_RUNNER.y, GRIP.z + SEAT_TO_RUNNER.z);
      hang.lerp(this.target, smooth(seg(p, 0.15, 0.7)));
      this.pole.set(sign, -0.5, -0.2);
      this.arms[index].solve(this.shoulder, hang, this.pole, this.tip);
    }
  }

  /** Forward-kinematic arm: upper arm swung `swing` radians forward of hanging, forearm bent `bend` further. */
  private pumpArm(index: number, sign: number, swing: number, bend: number): void {
    this.shoulderPoint(this.shoulder, sign);
    this.a.copy(this.shoulder).add(this.scratch.set(sign * 0.05, -Math.cos(swing) * UPPER_ARM, Math.sin(swing) * UPPER_ARM));
    this.b
      .copy(this.a)
      .add(this.scratch.set(0, -Math.cos(swing + bend) * FOREARM, Math.sin(swing + bend) * FOREARM));
    this.arms[index].place(this.shoulder, this.a, this.b);
  }

  private batonOff(): void {
    this.batonShown = false;
    this.baton.mesh.visible = false;
  }

  /** Key joint positions in the bike's frame — for the pose probe. */
  jointPositions(): Record<string, THREE.Vector3> {
    const out: Record<string, THREE.Vector3> = {};
    out.hips = this.hipCentre.clone();
    out.head = this.helmet.position.clone();
    for (const [name, limb] of [["armL", this.arms[0]], ["armR", this.arms[1]], ["legL", this.legs[0]], ["legR", this.legs[1]]] as const) {
      out[`${name}.end`] = limb.end.mesh.position.clone();
    }
    if (this.batonShown) out.baton = this.baton.mesh.position.clone();
    return out;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  /** The helmet, whose position and yaw a first-person camera follows. */
  get head(): THREE.Object3D {
    return this.helmet;
  }

  setHeadVisible(visible: boolean): void {
    this.helmet.visible = visible;
  }

  dispose(): void {
    this.object.removeFromParent();
    // Box and sphere geometry are shared module-wide; only materials are owned.
    for (const material of this.materials.all) material.dispose();
  }
}
