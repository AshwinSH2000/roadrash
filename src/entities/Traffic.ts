import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RAPIER, type PhysicsWorld } from "../physics/PhysicsWorld";
import { GROUPS_TRAFFIC } from "../physics/CollisionGroups";
import { ROAD_HALF_WIDTH, type TrackDefinition } from "../track/TrackDefinition";
import type { Racer } from "./Racer";

/**
 * Traffic for the drag strip: cars, trucks and motorbikes driving down the
 * road in the race's direction, one stream per lane, slower than any bike.
 *
 * Each vehicle is a kinematic box: it follows a scripted speed, pushes a bike
 * or tumbling rider that runs into it, and is never pushed back. What happens
 * on a collision is decided here, just before the physics step that would
 * resolve it, so the rider is thrown at the speed they really hit it with
 * (once the step has run, the contact has already scrubbed that speed off):
 *
 * - closing speed above `CRASH_CLOSING_KPH`: the rider is thrown off over the
 *   vehicle, and the vehicle brakes to a stop at `EMERGENCY_DECEL`;
 * - below it: the vehicle eases off for a moment and the contact itself slows
 *   the bike. The rider stays on.
 *
 * Only the player's bike is solid to traffic — the bots have no way to dodge,
 * so they drive through it (`GROUPS_BIKE_GHOST`).
 */

/** Lanes across the road, left to right, as lateral offsets from the centreline in metres. */
const LANE_COUNT = 4;
const LANE_WIDTH = (ROAD_HALF_WIDTH * 2) / LANE_COUNT;
const LANE_CENTRES = Array.from({ length: LANE_COUNT }, (_, i) => -ROAD_HALF_WIDTH + LANE_WIDTH * (i + 0.5));
/** Cruising speed of each lane in km/h, slowest on the left; one speed per lane so vehicles in a lane never run into each other. */
const LANE_SPEED_KPH = [35, 45, 55, 65];

/**
 * Closing speed in km/h at and above which a collision throws the rider.
 * 40 km/h is about 11 m/s: roughly a bike running into a stopped car at a
 * brisk jog-to-sprint. Below it is a shunt, above it the bars stop and the
 * rider doesn't.
 */
export const CRASH_CLOSING_KPH = 40;

/** Hard braking from a crash: about 0.8 g, a good car on dry tarmac. */
const EMERGENCY_DECEL = 8;
/** Easing off after a shunt, and following a slower vehicle. */
const COMFORT_DECEL = 3.5;
const ACCEL = 2;
/** After a shunt a vehicle drops to this share of its speed, for this long. */
const BUMP_SPEED_SHARE = 0.55;
const BUMP_SECONDS = 1.4;
/** Gap in metres a vehicle keeps to the one ahead, bumper to bumper. */
const FOLLOW_GAP = 8;

/** The player's chassis half length and half width (`VehicleController`), for the collision test. */
const BIKE_HALF_LENGTH = 1.0;
const BIKE_HALF_WIDTH = 0.4;
/** Seconds a vehicle ignores the player after a collision, so a shunt isn't counted every step. */
const HIT_COOLDOWN = 1.5;

/** Vehicles are scattered between this far past the start and this far before the finish, in metres. */
const FIRST_VEHICLE_AHEAD = 220;
const LAST_VEHICLE_BEFORE_FINISH = 120;
/** Roughly this many metres between one vehicle and the next down the road. */
const VEHICLE_SPACING = 85;
/** A vehicle that reaches the end of the course parks this far from it. */
const END_PARKING_MARGIN = 40;

type VehicleKind = "sedan" | "truck" | "bike";

interface VehicleSpec {
  length: number;
  width: number;
  height: number;
  /** Cruise speed relative to the lane's; trucks lumber. */
  speedShare: number;
}

const SPECS: Record<VehicleKind, VehicleSpec> = {
  sedan: { length: 4.5, width: 1.8, height: 1.45, speedShare: 1 },
  truck: { length: 8.2, width: 2.4, height: 3.0, speedShare: 0.9 },
  bike: { length: 2.0, width: 0.75, height: 1.5, speedShare: 1 },
};

const BODY_COLOURS = [0xc0392b, 0x2e86c1, 0xf1c40f, 0xecf0f1, 0x27ae60, 0x7f8c8d, 0xe67e22, 0x8e44ad, 0x1c2833];

interface Vehicle {
  kind: VehicleKind;
  spec: VehicleSpec;
  lane: number;
  /** Distance of the vehicle's centre down the track, in metres. */
  distance: number;
  prevDistance: number;
  speed: number;
  cruiseSpeed: number;
  halted: boolean;
  /** While above zero the vehicle holds `bumpSpeed`; set by a shunt. */
  bumpTimer: number;
  bumpSpeed: number;
  cooldown: number;
  body: RAPIER.RigidBody;
  group: THREE.Group;
}

export interface ImpactReport {
  vehicle: "car" | "truck" | "motorbike";
  closingKph: number;
  /** True if the rider was thrown off; false for a shunt. */
  crashed: boolean;
}

export class Traffic {
  private readonly vehicles: Vehicle[] = [];
  private readonly root = new THREE.Group();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpImpulse = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly endDistance: number;

  constructor(
    private readonly physics: PhysicsWorld,
    scene: THREE.Scene,
    private readonly track: TrackDefinition,
  ) {
    scene.add(this.root);
    this.endDistance = track.finishDistance + END_PARKING_MARGIN;
    this.populate();
  }

  get count(): number {
    return this.vehicles.length;
  }

  private populate(): void {
    const first = this.track.startDistance + FIRST_VEHICLE_AHEAD;
    const last = this.track.finishDistance - LAST_VEHICLE_BEFORE_FINISH;
    const geometry = buildGeometries();
    const bodyMaterials = BODY_COLOURS.map(
      (colour) => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.5, metalness: 0.25 }),
    );
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.6, metalness: 0.1 });

    // One vehicle per slot down the road, in a random lane. Cycling a shuffled
    // lane order first guarantees all four lanes get traffic.
    let laneBag: number[] = [];
    for (let at = first; at < last; at += VEHICLE_SPACING) {
      if (laneBag.length === 0) laneBag = shuffle([...LANE_CENTRES.keys()]);
      const lane = laneBag.pop()!;
      const roll = Math.random();
      const kind: VehicleKind = roll < 0.6 ? "sedan" : roll < 0.8 ? "truck" : "bike";
      const spec = SPECS[kind];
      const distance = at + (Math.random() - 0.5) * VEHICLE_SPACING * 0.6;
      const cruise = (LANE_SPEED_KPH[lane] / 3.6) * spec.speedShare;

      const group = new THREE.Group();
      const bodyMesh = new THREE.Mesh(geometry[kind].body, bodyMaterials[Math.floor(Math.random() * bodyMaterials.length)]);
      const darkMesh = new THREE.Mesh(geometry[kind].dark, darkMaterial);
      bodyMesh.castShadow = darkMesh.castShadow = true;
      group.add(bodyMesh, darkMesh);
      this.root.add(group);

      const position = this.track.spawnPoint(distance, LANE_CENTRES[lane], spec.height / 2);
      const rotation = this.track.spawnRotation(distance);
      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(position.x, position.y, position.z)
          .setRotation(rotation),
      );
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(spec.width / 2, spec.height / 2, spec.length / 2)
          .setFriction(0)
          .setRestitution(0)
          .setCollisionGroups(GROUPS_TRAFFIC),
        body,
      );

      this.vehicles.push({
        kind,
        spec,
        lane,
        distance,
        prevDistance: distance,
        speed: cruise,
        cruiseSpeed: cruise,
        halted: false,
        bumpTimer: 0,
        bumpSpeed: 0,
        cooldown: 0,
        body,
        group,
      });
      this.place(this.vehicles[this.vehicles.length - 1], 1);
    }
  }

  /**
   * Looks for a collision with `racer` in the physics step about to run and
   * resolves it. Call before `update` and before the step, while both the
   * bike and the vehicle are still where the last step left them.
   */
  resolvePlayerImpact(racer: Racer, dt: number): ImpactReport | null {
    const bike = racer.bike;
    const bikeSpeed = bike.forwardSpeed;
    let report: ImpactReport | null = null;

    for (const vehicle of this.vehicles) {
      if (vehicle.cooldown > 0) continue;
      const closing = bikeSpeed - vehicle.speed;
      if (closing <= 0) continue;
      const lateral = Math.abs(racer.lateralOffset - LANE_CENTRES[vehicle.lane]);
      if (lateral > vehicle.spec.width / 2 + BIKE_HALF_WIDTH) continue;

      const gap = vehicle.distance - vehicle.spec.length / 2 - (racer.distanceAlong + BIKE_HALF_LENGTH);
      // Already past it (a bike alongside, or a loose bike lying beside the road) is not a rear-end.
      if (gap < -0.5 || gap > closing * dt + 0.15) continue;

      vehicle.cooldown = HIT_COOLDOWN;
      const closingKph = closing * 3.6;
      const crashed = racer.rider.isRiding && closingKph >= CRASH_CLOSING_KPH;
      if (crashed) {
        // Over the bars: mostly up, some forward, a little to a random side.
        this.tmpForward.set(0, 0, 1).applyQuaternion(bike.worldQuaternion);
        this.tmpImpulse
          .copy(this.tmpForward)
          .multiplyScalar(180)
          .setY(300)
          .addScaledVector(this.tmpForward.set(1, 0, 0).applyQuaternion(bike.worldQuaternion), (Math.random() - 0.5) * 260);
        racer.rider.knockOff(this.tmpImpulse);
        vehicle.halted = true;
      } else {
        vehicle.bumpTimer = BUMP_SECONDS;
        vehicle.bumpSpeed = vehicle.speed * BUMP_SPEED_SHARE;
      }
      report = {
        vehicle: vehicle.kind === "sedan" ? "car" : vehicle.kind === "truck" ? "truck" : "motorbike",
        closingKph,
        crashed,
      };
    }
    return report;
  }

  /** Advances every vehicle by one fixed step and tells the physics body where to be next. */
  update(dt: number): void {
    // Per lane, nearest-ahead leader for the following rule.
    const byLane: Vehicle[][] = Array.from({ length: LANE_COUNT }, () => []);
    for (const v of this.vehicles) byLane[v.lane].push(v);
    for (const lane of byLane) lane.sort((a, b) => a.distance - b.distance);

    for (const lane of byLane) {
      for (let i = 0; i < lane.length; i++) {
        const v = lane[i];
        const leader = lane[i + 1] ?? null;
        v.cooldown = Math.max(0, v.cooldown - dt);
        v.prevDistance = v.distance;

        let target = v.cruiseSpeed;
        if (v.distance >= this.endDistance) target = 0;
        if (v.bumpTimer > 0) {
          v.bumpTimer -= dt;
          target = Math.min(target, v.bumpSpeed);
        }
        if (leader) {
          const gap = leader.distance - leader.spec.length / 2 - (v.distance + v.spec.length / 2);
          // Fastest speed from which this vehicle can still stop short of the gap it wants to keep.
          const room = Math.max(0, gap - FOLLOW_GAP);
          target = Math.min(target, leader.speed + Math.sqrt(2 * COMFORT_DECEL * room));
        }
        if (v.halted) target = 0;

        const decel = v.halted ? EMERGENCY_DECEL : COMFORT_DECEL;
        if (v.speed > target) v.speed = Math.max(target, v.speed - decel * dt);
        else v.speed = Math.min(target, v.speed + ACCEL * dt);
        v.distance += v.speed * dt;

        const position = this.track.spawnPoint(v.distance, LANE_CENTRES[v.lane], v.spec.height / 2);
        v.body.setNextKinematicTranslation(position);
      }
    }
  }

  /** Draws every vehicle between its previous and current step, so slow movement stays smooth at any frame rate. */
  syncRender(alpha: number): void {
    for (const v of this.vehicles) this.place(v, alpha);
  }

  private place(v: Vehicle, alpha: number): void {
    const distance = THREE.MathUtils.lerp(v.prevDistance, v.distance, alpha);
    this.tmpPos.copy(this.track.spawnPoint(distance, LANE_CENTRES[v.lane], 0));
    this.tmpQuat.copy(this.track.spawnRotation(distance));
    v.group.position.copy(this.tmpPos);
    v.group.quaternion.copy(this.tmpQuat);
  }
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

type Parts = { body: THREE.BufferGeometry; dark: THREE.BufferGeometry };

/** Boxes and wheels merged into two geometries per kind: the painted body, and the dark wheels and glass. Local +Z is forward, origin on the ground at the centre. */
function buildGeometries(): Record<VehicleKind, Parts> {
  const box = (w: number, h: number, l: number, x: number, y: number, z: number): THREE.BufferGeometry =>
    new THREE.BoxGeometry(w, h, l).translate(x, y, z);
  const wheel = (radius: number, width: number, x: number, z: number): THREE.BufferGeometry =>
    new THREE.CylinderGeometry(radius, radius, width, 14).rotateZ(Math.PI / 2).translate(x, radius, z);
  const merge = (list: THREE.BufferGeometry[]): THREE.BufferGeometry => mergeGeometries(list)!;

  const sedan = SPECS.sedan;
  const truck = SPECS.truck;

  return {
    sedan: {
      body: merge([
        box(sedan.width, 0.62, sedan.length, 0, 0.62, 0),
        box(sedan.width * 0.9, 0.08, sedan.length * 0.46, 0, 1.4, -0.2),
      ]),
      dark: merge([
        box(sedan.width * 0.93, 0.4, sedan.length * 0.44, 0, 1.15, -0.2),
        wheel(0.33, 0.24, sedan.width / 2 - 0.05, 1.4),
        wheel(0.33, 0.24, -sedan.width / 2 + 0.05, 1.4),
        wheel(0.33, 0.24, sedan.width / 2 - 0.05, -1.4),
        wheel(0.33, 0.24, -sedan.width / 2 + 0.05, -1.4),
      ]),
    },
    truck: {
      body: merge([
        box(truck.width, 2.2, truck.length - 2.2, 0, 1.75, -1.1),
        box(truck.width, 1.5, 2.0, 0, 1.4, truck.length / 2 - 1.0),
      ]),
      dark: merge([
        box(truck.width * 0.9, 0.6, 0.1, 0, 2.0, truck.length / 2 + 0.01),
        wheel(0.5, 0.3, truck.width / 2 - 0.1, 2.6),
        wheel(0.5, 0.3, -truck.width / 2 + 0.1, 2.6),
        wheel(0.5, 0.3, truck.width / 2 - 0.1, -2.4),
        wheel(0.5, 0.3, -truck.width / 2 + 0.1, -2.4),
        wheel(0.5, 0.3, truck.width / 2 - 0.1, -3.4),
        wheel(0.5, 0.3, -truck.width / 2 + 0.1, -3.4),
      ]),
    },
    bike: {
      body: merge([box(0.3, 0.35, 0.8, 0, 0.75, 0.15), box(0.22, 0.2, 0.6, 0, 0.62, -0.5)]),
      dark: merge([
        wheel(0.32, 0.13, 0, 0.7),
        wheel(0.32, 0.13, 0, -0.7),
        box(0.4, 0.62, 0.3, 0, 1.2, -0.15),
        new THREE.SphereGeometry(0.17, 10, 8).translate(0, 1.65, -0.05),
        box(0.14, 0.5, 0.14, 0.17, 0.75, -0.15),
        box(0.14, 0.5, 0.14, -0.17, 0.75, -0.15),
      ]),
    },
  };
}
