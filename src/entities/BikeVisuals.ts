import * as THREE from "three";
import { DEFAULT_VEHICLE_CONFIG } from "../physics/VehicleController";

/**
 * The seam between the physics-driven bike and whatever is actually drawn for
 * it. `Bike` owns the transforms and knows nothing about where the meshes came
 * from; a `BikeVisuals` supplies the meshes and nothing else. Swapping the
 * placeholder boxes for a loaded model is therefore a change of factory, not a
 * change to any of the lean/pitch/suspension maths in `Bike`.
 *
 * The split between `body` and `wheels` is not cosmetic. The body rides with
 * the chassis and is parented to the bike's group, so it inherits terrain pitch
 * and cornering lean for free. The wheels do NOT: they hang on independent
 * suspension and are placed in *world* space every frame (see `Bike.applyLean`),
 * because their height comes from each wheel's own raycast rather than from the
 * chassis. A wheel parented to the body would ride at a fixed height and sink
 * into every crest.
 */
export interface BikeVisuals {
  /** Frame, tank, bodywork — everything that moves rigidly with the chassis. */
  body: THREE.Object3D;
  /**
   * Front (0) and rear (1). Their local transform is written directly as a
   * world transform, so they must be added to the scene root, never to `body`.
   * Each one's origin must sit at its own hub, since that is the point `Bike`
   * positions and the axis it spins about.
   */
  wheels: [THREE.Object3D, THREE.Object3D];
  /**
   * Axis the front wheel steers about, unit length, in the bike's own frame.
   * Vertical for the placeholder; a loaded model supplies its real, raked fork
   * axis so the wheel gains the camber a turned motorcycle wheel actually has.
   */
  steeringAxis: THREE.Vector3;
  /**
   * Forks, bars, fender and whatever else turns with the steering, when the
   * model yielded them. Lives inside `body` with its origin at the front hub,
   * already straightened; `Bike` sets its quaternion every frame to the live
   * steer angle about `axis` (unit, in the assembly's parent space).
   */
  frontAssembly?: {
    object: THREE.Object3D;
    axis: THREE.Vector3;
  };
  dispose(): void;
}

/** Builds a fresh, independent set of visuals tinted with one rider's colour. */
export type BikeVisualsFactory = (color: number) => BikeVisuals;

/**
 * Where a wheel hub sits, relative to the chassis origin, with the suspension
 * at rest. Derived rather than written down: the wheels mount at the chassis's
 * local *bottom* (`-halfExtents.y`, see `VehicleController`'s `mountY`) and
 * then hang one rest-length below that. A model is fitted so its own hubs land
 * here, which is what makes the loaded mesh line up with the placeholder it
 * replaces instead of floating or sinking.
 */
export const REST_HUB_Y =
  -DEFAULT_VEHICLE_CONFIG.chassisHalfExtents.y - DEFAULT_VEHICLE_CONFIG.suspensionRestLength;

/** Disposes geometry and materials the visuals own outright. */
function disposeOwned(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
  });
}

function enableShadows(root: THREE.Object3D): void {
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) node.castShadow = true;
  });
}

/**
 * The original box-and-cylinder bike. Still the default, and still what every
 * headless simulation runs against — the sims construct a `Bike` with no
 * visuals argument, and must never require a GLTF file or a DOM to do it.
 */
export function createPlaceholderBikeVisuals(color: number): BikeVisuals {
  const body = new THREE.Group();

  const half = DEFAULT_VEHICLE_CONFIG.chassisHalfExtents;
  const bodyMesh = new THREE.Mesh(
    new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
    new THREE.MeshStandardMaterial({ color }),
  );
  body.add(bodyMesh);

  // Nose indicator mounted on TOP of the front half, tall enough to rise above the
  // box's own roofline — a forward-pointing cone at body height would be fully hidden
  // behind the box from a rear chase camera, so this pokes up instead, visible from behind.
  const noseMesh = new THREE.Mesh(
    new THREE.ConeGeometry(half.x * 0.6, half.y * 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0xffcc00 }),
  );
  noseMesh.position.set(0, half.y + (half.y * 1.2) / 2, half.z * 0.5);
  body.add(noseMesh);

  const wheelGeometry = new THREE.CylinderGeometry(
    DEFAULT_VEHICLE_CONFIG.wheelRadius,
    DEFAULT_VEHICLE_CONFIG.wheelRadius,
    0.22,
    16,
  );
  wheelGeometry.rotateZ(Math.PI / 2);
  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3a3a });
  const wheels: [THREE.Object3D, THREE.Object3D] = [
    new THREE.Mesh(wheelGeometry, wheelMaterial),
    new THREE.Mesh(wheelGeometry, wheelMaterial),
  ];

  enableShadows(body);
  wheels.forEach(enableShadows);

  return {
    body,
    wheels,
    steeringAxis: new THREE.Vector3(0, 1, 0),
    dispose(): void {
      disposeOwned(body);
      // Both wheels share one geometry and one material, so dispose once.
      wheelGeometry.dispose();
      wheelMaterial.dispose();
    },
  };
}

/**
 * The handful of numbers that cannot be measured off a model and have to be
 * eyeballed. Everything else — scale, heading, ride height — is derived from
 * the model's own wheel hubs in `makeGltfBikeVisualsFactory`.
 */
export interface BikeFitting {
  /** Case-insensitive substring matching the front wheel's node name, when the model has one. */
  frontWheelNode: string;
  /** Case-insensitive substring matching the rear wheel's node name, when the model has one. */
  rearWheelNode: string;
  /** Extra yaw in degrees on top of the auto-derived heading. 180 flips a bike that faces backwards. */
  yawOffsetDeg: number;
  /** Multiplier on the auto-derived scale. */
  scaleAdjust: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export const DEFAULT_BIKE_FITTING: BikeFitting = {
  frontWheelNode: "wheel_front",
  rearWheelNode: "wheel_rear",
  yawOffsetDeg: 0,
  scaleAdjust: 1,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
};

/** Thrown when a model can't be fitted; the caller falls back to the placeholder. */
export class BikeFitError extends Error {}

export interface BikeFitReport {
  /** Which route produced the wheels — named nodes, or the geometric splitter. */
  strategy: "named-nodes" | "auto-split";
  measuredWheelBase: number;
  autoScale: number;
  headingDeg: number;
  fittedWheelRadius: number;
  expectedWheelRadius: number;
  /** Only meaningful for `auto-split`: which meshes were separated, and what stayed on the body. */
  splitMeshes?: string[];
  splitTriangles?: number;
  /** Meshes that sat inside the wheel discs but were kept on the body for not wrapping the hub. */
  spinRejected?: string[];
  /** How far off-axis each wheel was modelled, in degrees, before being straightened. */
  frontPoseDeg?: number;
  rearPoseDeg?: number;
  /** Steering geometry recovered from the fork tubes, when it was. */
  steering?: {
    rakeDeg: number;
    /** How far the whole front end was modelled turned, in degrees, before being straightened. */
    posedTurnDeg: number;
    parts: number;
    triangles: number;
    /** Sideways shift applied after un-posing to put the fork tubes on the midplane, in model units. */
    lateralCorrection: number;
    /** Parts near the fork axis that were left on the frame because they were symmetric *before* un-posing. */
    frameParts: number;
    /** Per-part detail for the fit report, in un-posed root space. */
    detail: { name: string; triangles: number; steers: boolean; min: THREE.Vector3; max: THREE.Vector3 }[];
  };
}

function findNode(root: THREE.Object3D, needle: string): THREE.Object3D | null {
  const wanted = needle.trim().toLowerCase();
  if (!wanted) return null;
  let exact: THREE.Object3D | null = null;
  let partial: THREE.Object3D | null = null;
  root.traverse((node) => {
    const name = node.name.toLowerCase();
    if (name === wanted) exact ??= node;
    else if (name.includes(wanted)) partial ??= node;
  });
  return exact ?? partial;
}

/** Every named node in the model, for reporting when the wheel names don't match. */
export function listNodeNames(root: THREE.Object3D): string[] {
  const names: string[] = [];
  root.traverse((node) => {
    if (node.name) names.push(`${node.name}${(node as THREE.Mesh).isMesh ? " (mesh)" : ""}`);
  });
  return names;
}

function hubOf(node: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
}

/** One triangle of a mesh, already flattened into the model root's space. */
interface Triangle {
  /** Vertex indices into the source geometry. */
  a: number;
  b: number;
  c: number;
  centroid: THREE.Vector3;
}

/** A mesh's triangles in root space, plus what's needed to rebuild a subset of them. */
interface MeshTriangles {
  mesh: THREE.Mesh;
  toRoot: THREE.Matrix4;
  triangles: Triangle[];
  /** Every vertex of the geometry in root space, xyz interleaved. */
  rootPositions: Float32Array;
}

/** Reads every mesh under `root`, flattening its triangles into root space. */
function collectTriangles(root: THREE.Object3D): MeshTriangles[] {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const out: MeshTriangles[] = [];

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;

    const toRoot = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
    const rootPositions = new Float32Array(position.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(toRoot);
      rootPositions[i * 3] = v.x;
      rootPositions[i * 3 + 1] = v.y;
      rootPositions[i * 3 + 2] = v.z;
    }

    const index = mesh.geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const triangles: Triangle[] = [];
    for (let t = 0; t < triangleCount; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const centroid = new THREE.Vector3();
      for (const vi of [a, b, c]) {
        centroid.x += rootPositions[vi * 3];
        centroid.y += rootPositions[vi * 3 + 1];
        centroid.z += rootPositions[vi * 3 + 2];
      }
      centroid.multiplyScalar(1 / 3);
      triangles.push({ a, b, c, centroid });
    }
    out.push({ mesh, toRoot, triangles, rootPositions });
  });

  return out;
}

/** A mesh must be at least this proportion wheel to be split off; anything less stays on the body. */
const WHEEL_PURITY = 0.95;
/** Slack on the wheel radius when deciding what belongs to a wheel. */
const WHEEL_RADIUS_MARGIN = 1.05;
/** Angular sectors around a hub used to test whether a part actually wraps it. */
const ANGULAR_BINS = 16;
/** Fraction of those sectors a part must occupy to count as a solid of revolution. */
const MIN_ANGULAR_COVERAGE = 0.75;
/** Below this many triangles a lobe is a fitting or a bolt, not a wheel. */
const MIN_LOBE_TRIANGLES = 12;
/** A wheel lobe's height and length must agree to within this ratio — a wheel is round. */
const DISC_ASPECT = 0.7;
/** The two lobes of a wheel mesh must be within this much of the same size. */
const LOBE_SIZE_AGREEMENT = 0.75;
/** How close to the ground the outermost wheel must come, as a fraction of model height. */
const GROUND_TOLERANCE = 0.08;
/** A fork tube is at least this tall, in wheel radii, and at most this wide. */
const FORK_MIN_HEIGHT = 1.2;
const FORK_MAX_WIDTH = 0.6;
/** Everything within this many wheelbases of the fork axis, and ahead of the bike's middle, steers. */
const STEER_ASSEMBLY_RADIUS = 0.39;
/** Below this posed turn the symmetry test has nothing to work with and is skipped. */
const MIN_POSE_FOR_SYMMETRY_DEG = 10;
/** A part is "on the midplane" if its centre is within this many wheelbases of it. */
const MIDPLANE_TOLERANCE = 0.025;
/** Centred parts wider than this many wheelbases are handlebars, which are centred by design. */
const MIDPLANE_MAX_WIDTH = 0.2;
/** Parts closer than this many wheelbases to the fork axis stay on the assembly whatever their symmetry. */
const ON_AXIS_RADIUS = 0.15;
/** A narrow centreline part this far behind the head stock (in wheelbases) is on the tank, not the bars. */
const BEHIND_HEADSTOCK = 0.03;
/** How far off the centreline a part can be and still count as "on it", in wheelbases. */
const CENTRELINE_HALF_WIDTH = 0.1;

interface HubGeometry {
  /** Where the front wheel *should* be: on the bike's midplane. */
  frontHub: THREE.Vector3;
  /** Where the front wheel's geometry actually is — a posed front end drags its hub sideways. */
  frontOrigin: THREE.Vector3;
  rearHub: THREE.Vector3;
  radius: number;
}

interface Lobe {
  center: THREE.Vector3;
  /** Extent along the wheelbase axis. */
  length: number;
  /** Extent in Y. */
  height: number;
  bottom: number;
}

/** Splits a mesh's triangles at their widest gap along `axis`, if there is a clean one. */
function splitAtWidestGap(triangles: Triangle[], axis: "x" | "z"): [Lobe, Lobe] | null {
  if (triangles.length < 24) return null;
  const sorted = [...triangles].sort((a, b) => a.centroid[axis] - b.centroid[axis]);
  const span = sorted[sorted.length - 1].centroid[axis] - sorted[0].centroid[axis];
  if (span <= 0) return null;

  // Only the middle half is considered, so a sparse fringe at either end can't
  // masquerade as the gap between two wheels.
  let cut = -1;
  let widest = 0;
  const lo = Math.floor(sorted.length * 0.25);
  const hi = Math.floor(sorted.length * 0.75);
  for (let i = lo; i < hi; i++) {
    const gap = sorted[i + 1].centroid[axis] - sorted[i].centroid[axis];
    if (gap > widest) {
      widest = gap;
      cut = i;
    }
  }
  if (cut < 0 || widest < span * 0.15) return null;

  const measure = (group: Triangle[]): Lobe => {
    const box = new THREE.Box3();
    for (const t of group) box.expandByPoint(t.centroid);
    const size = box.getSize(new THREE.Vector3());
    return {
      center: box.getCenter(new THREE.Vector3()),
      length: size[axis],
      height: size.y,
      bottom: box.min.y,
    };
  };

  return [measure(sorted.slice(0, cut + 1)), measure(sorted.slice(cut + 1))];
}

/**
 * Locates the two wheels by finding the mesh that *is* the wheels.
 *
 * The first version of this measured a thin slab just above the model's lowest
 * point, on the reasoning that only the tyres touch the ground. On a real bike
 * that is false, and `npm run check:bike` caught it: the exhaust and the frame
 * also reach the floor, so the slab picked up a long smear of pipe, which
 * dragged the two cluster centres together and inflated the fitted radius by
 * 40% — a wheelbase of 1.15 m where the model's own is 1.42 m.
 *
 * Keying off a whole mesh instead is far more robust, because a wheel mesh has
 * a signature nothing else on a bike has: its triangles fall into two
 * well-separated groups along the wheelbase, each as tall as it is long (a
 * disc), both the same size as each other, with the lower edge on the ground.
 * The exhaust fails it, the frame fails it, and the tyres pass it cleanly.
 *
 * Where several meshes qualify — tyres, rims and hubs are usually separate
 * materials, so all three do — the largest radius wins, since that is the
 * outer edge of the wheel and the radius everything else is judged against.
 */
function findHubs(meshes: MeshTriangles[], bounds: THREE.Box3): HubGeometry | null {
  const size = bounds.getSize(new THREE.Vector3());
  // The long horizontal axis is the wheelbase direction. Everything below
  // works in that axis and in Y; the third axis is the axle and is ignored.
  const longAxis: "x" | "z" = size.z >= size.x ? "z" : "x";
  const groundY = bounds.min.y;

  let best: HubGeometry | null = null;

  for (const entry of meshes) {
    const lobes = splitAtWidestGap(entry.triangles, longAxis);
    if (!lobes) continue;
    const [a, b] = lobes;

    // Both lobes round, in agreement with each other, and on the ground.
    const round = (l: Lobe): boolean =>
      l.height > 0 && l.length > 0 && Math.min(l.height, l.length) / Math.max(l.height, l.length) >= DISC_ASPECT;
    if (!round(a) || !round(b)) continue;
    if (Math.min(a.height, b.height) / Math.max(a.height, b.height) < LOBE_SIZE_AGREEMENT) continue;
    if (Math.min(a.bottom, b.bottom) - groundY > size.y * GROUND_TOLERANCE) continue;

    // Centroids sit a little inside the true silhouette, so the radius is
    // taken from the lobe's full height rather than half its centroid spread.
    const radius = (a.height + b.height) / 4;
    if (best && radius <= best.radius) continue;

    const hubA = a.center.clone();
    const hubB = b.center.clone();
    hubA.y = hubB.y = groundY + radius;
    best = { frontHub: hubA, frontOrigin: hubA.clone(), rearHub: hubB, radius };
  }

  if (!best) return null;

  // Which end is the front? The forks and handlebars stand well above the
  // front wheel; behind, there is only a seat and a mudguard. So compare how
  // tall the model is over each hub, ignoring the wheel itself.
  const heightOver = (hub: THREE.Vector3): number => {
    let tallest = groundY;
    const window = Math.abs(best!.frontHub[longAxis] - best!.rearHub[longAxis]) * 0.3;
    for (const entry of meshes) {
      for (const tri of entry.triangles) {
        if (Math.abs(tri.centroid[longAxis] - hub[longAxis]) > window) continue;
        if (tri.centroid.y < hub.y + best!.radius) continue;
        tallest = Math.max(tallest, tri.centroid.y);
      }
    }
    return tallest;
  };

  if (heightOver(best.rearHub) > heightOver(best.frontHub)) {
    const swap = best.frontHub;
    best.frontHub = best.rearHub;
    best.rearHub = swap;
  }
  // The rear wheel is never posed, so its lateral position is the bike's
  // midplane. The front hub is forced onto it: a posed front end carries its
  // hub sideways, and the wheel must be placed where the bike's centreline
  // is, not where the display pose left it. Its geometry is still built about
  // where it actually sits (`frontOrigin`), or it would spin off-centre.
  best.frontOrigin = best.frontHub.clone();
  const axleAxis = longAxis === "z" ? "x" : "z";
  best.frontHub[axleAxis] = best.rearHub[axleAxis];
  return best;
}

/**
 * What fraction of the sectors around a hub a set of triangles occupies.
 *
 * This is the test that separates a wheel from something merely parked next to
 * one. Every part that genuinely turns with a wheel — tyre, rim, hub, brake
 * disc — is a solid of revolution about the axle, so its triangles are spread
 * right around the hub. A mudguard covers the top arc and nothing else; a
 * silencer or a fitting bolted near the axle covers a single sector. Being
 * *inside* the wheel's disc is not enough, and the first version of this
 * splitter shipped with exactly that hole: it spun a mudguard stay and a small
 * side fitting along with the wheels.
 *
 * Sectors are capped at the triangle count so a genuinely low-poly wheel isn't
 * failed for having fewer faces than there are bins.
 */
function angularCoverage(triangles: Triangle[], hub: THREE.Vector3, longAxis: "x" | "z"): number {
  const bins = Math.min(ANGULAR_BINS, triangles.length);
  const occupied = new Set<number>();
  for (const tri of triangles) {
    const angle = Math.atan2(tri.centroid.y - hub.y, tri.centroid[longAxis] - hub[longAxis]);
    occupied.add(Math.floor(((angle + Math.PI) / (2 * Math.PI)) * bins) % bins);
  }
  return occupied.size / bins;
}

/** Covariance of a point cloud, lightly regularised so a flat cloud still inverts. */
function covarianceOf(points: THREE.Vector3[]): THREE.Matrix3 {
  const mean = new THREE.Vector3();
  for (const p of points) mean.add(p);
  mean.multiplyScalar(1 / points.length);

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  const d = new THREE.Vector3();
  for (const p of points) {
    d.subVectors(p, mean);
    xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z;
    yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
  }
  const eps = (xx + yy + zz) * 1e-6 + 1e-12;
  return new THREE.Matrix3().set(
    xx + eps, xy, xz,
    xy, yy + eps, yz,
    xz, yz, zz + eps,
  );
}

/**
 * The axle direction of a wheel, from its geometry alone.
 *
 * A wheel is flat: its triangles spread widely in two directions and hardly at
 * all in the third, which is the axle. That is the smallest-variance axis of
 * the centroid cloud — the least eigenvector of the covariance — found here by
 * inverse power iteration, which converges in a handful of steps precisely
 * because the wheel is so much wider than it is thick. The result is signed to
 * agree with `hint` so a wheel is never straightened by turning it 180°.
 *
 * This exists because downloaded models are posed. The CB 750 arrived with its
 * front wheel turned 26.6° and cambered 14.4° — a display pose — so every
 * steering input was applied on top of a wheel that already started turned.
 */
function fitAxle(triangles: Triangle[], hint: THREE.Vector3): THREE.Vector3 {
  const inverse = covarianceOf(triangles.map((t) => t.centroid)).invert();
  const axle = hint.clone().normalize();
  for (let i = 0; i < 40; i++) axle.applyMatrix3(inverse).normalize();
  if (axle.dot(hint) < 0) axle.negate();
  return axle;
}

/** The long axis of an elongated part — the direction of a tube. */
function principalAxis(points: THREE.Vector3[], hint: THREE.Vector3): THREE.Vector3 {
  const covariance = covarianceOf(points);
  const axis = hint.clone().normalize();
  for (let i = 0; i < 60; i++) axis.applyMatrix3(covariance).normalize();
  if (axis.dot(hint) < 0) axis.negate();
  return axis;
}

/** Distance from a hub in the plane perpendicular to the axle. */
function radialDistance(point: THREE.Vector3, hub: THREE.Vector3, longAxis: "x" | "z"): number {
  return Math.hypot(point.y - hub.y, point[longAxis] - hub[longAxis]);
}

/** Distance from a line through `origin` along unit `direction`. */
function distanceFromLine(point: THREE.Vector3, origin: THREE.Vector3, direction: THREE.Vector3): number {
  const d = point.clone().sub(origin);
  return d.addScaledVector(direction, -d.dot(direction)).length();
}

/**
 * Builds a mesh from a subset of another mesh's triangles, baked into root
 * space. Always non-indexed — the subsets are small (a few thousand triangles
 * for a whole wheel) and rebuilding an index would buy nothing.
 */
function buildSubsetMesh(
  entry: MeshTriangles,
  triangles: Triangle[],
  origin: THREE.Vector3,
  /** Extra rigid transform in root space, applied before `origin` is subtracted. */
  adjust: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Mesh {
  const source = entry.mesh.geometry;
  const position = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  const uv = source.getAttribute("uv");

  const positions = new Float32Array(triangles.length * 9);
  const normals = normal ? new Float32Array(triangles.length * 9) : null;
  const uvs = uv ? new Float32Array(triangles.length * 6) : null;

  const full = new THREE.Matrix4().multiplyMatrices(adjust, entry.toRoot);
  // Normals rotate but must not pick up the translation or a non-uniform scale.
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(full);
  const v = new THREE.Vector3();

  triangles.forEach((tri, t) => {
    [tri.a, tri.b, tri.c].forEach((vi, k) => {
      v.fromBufferAttribute(position, vi).applyMatrix4(full).sub(origin);
      positions.set([v.x, v.y, v.z], t * 9 + k * 3);
      if (normal && normals) {
        v.fromBufferAttribute(normal, vi).applyMatrix3(normalMatrix).normalize();
        normals.set([v.x, v.y, v.z], t * 9 + k * 3);
      }
      if (uv && uvs) uvs.set([uv.getX(vi), uv.getY(vi)], t * 6 + k * 2);
    });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  else geometry.computeVertexNormals();
  if (uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

  const mesh = new THREE.Mesh(geometry, entry.mesh.material);
  mesh.name = entry.mesh.name;
  return mesh;
}

/** A vertex-connected piece of one mesh — an original part of a material-merged model. */
interface Part {
  entry: MeshTriangles;
  triangles: Triangle[];
  /** Root-space bounds of the part's vertices. */
  box: THREE.Box3;
}

/**
 * Recovers a mesh's original parts as vertex-connected components.
 *
 * A material merge concatenates objects; it does not weld them. So every fork
 * tube, mirror and bracket that was a separate object before the merge is
 * still a separate island of connected triangles afterwards, which is what
 * makes it possible to move a *whole* part rather than guessing per triangle.
 * Vertices are welded by position first, because an OBJ export splits them
 * along normal and UV seams and a tube would otherwise fall apart into strips.
 */
function connectedParts(entry: MeshTriangles, triangles: Triangle[]): Part[] {
  const positions = entry.rootPositions;
  const vertexCount = positions.length / 3;

  const welded = new Int32Array(vertexCount);
  const byKey = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const key = `${positions[i * 3].toFixed(5)},${positions[i * 3 + 1].toFixed(5)},${positions[i * 3 + 2].toFixed(5)}`;
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, i);
    welded[i] = seen ?? i;
  }

  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  for (const tri of triangles) {
    union(welded[tri.a], welded[tri.b]);
    union(welded[tri.b], welded[tri.c]);
  }

  const groups = new Map<number, Part>();
  const v = new THREE.Vector3();
  for (const tri of triangles) {
    const root = find(welded[tri.a]);
    let part = groups.get(root);
    if (!part) {
      part = { entry, triangles: [], box: new THREE.Box3() };
      groups.set(root, part);
    }
    part.triangles.push(tri);
    for (const vi of [tri.a, tri.b, tri.c]) {
      part.box.expandByPoint(v.set(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]));
    }
  }
  return [...groups.values()];
}

/** Every vertex of a part, in root space. */
function partVertices(part: Part): THREE.Vector3[] {
  const positions = part.entry.rootPositions;
  const seen = new Set<number>();
  const out: THREE.Vector3[] = [];
  for (const tri of part.triangles) {
    for (const vi of [tri.a, tri.b, tri.c]) {
      if (seen.has(vi)) continue;
      seen.add(vi);
      out.push(new THREE.Vector3(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]));
    }
  }
  return out;
}

interface SteeringGeometry {
  /** Unit direction of the fork axis, pointing up, lying in the bike's midplane, in root space. */
  axis: THREE.Vector3;
  rakeDeg: number;
  /** Rigid root-space transform that puts the posed front end straight and centred. */
  unpose: THREE.Matrix4;
  posedTurnDeg: number;
  lateralCorrection: number;
  parts: Part[];
  /** Candidates left on the frame by the symmetry test. */
  frameParts: Part[];
  /** Root-space bounds of each part *after* un-posing, for the fit report. */
  unposedBox: (p: Part) => THREE.Box3;
}

/**
 * Recovers the steering geometry of a material-merged model: the fork axis,
 * how far the front end was posed turned about it, and every part that turns
 * with the bars.
 *
 * **The axis** comes from the fork tubes, which are the only tall, thin,
 * upright parts standing over the front wheel. Their long axis *is* the
 * steering axis, and usefully it is immune to the pose — a tube rotated about
 * an axis parallel to itself keeps its direction. The line is then placed
 * through the front hub rather than through the tubes themselves. The real
 * axis passes a few centimetres from the hub, but the hub is where the physics
 * puts the wheel, and rotating the forks about the same line the wheel steers
 * about is what keeps the two attached under full lock.
 *
 * **The pose** is the angle about that axis that brings the front wheel's
 * fitted axle back to straight-ahead. On the CB 750 this came out at 28.9°,
 * independently agreeing with the 30° the wheel fit had found.
 *
 * **The parts** are every original object lying entirely within
 * `STEER_ASSEMBLY_RADIUS` of the axis and ahead of the bike's midpoint. Whole
 * parts, because the bars reach well behind the axis and the fender well
 * ahead of it, and no per-triangle rule captures both without also taking the
 * tank. The audit on the CB 750 found that nothing tall or long other than
 * forks, fender and fork lowers falls inside — the frame doesn't reach the
 * head stock as a separable part at all.
 */
function findSteeringGeometry(
  parts: Part[],
  hubs: HubGeometry,
  longAxis: "x" | "z",
  frontAxle: THREE.Vector3,
): SteeringGeometry | null {
  const axleAxis = longAxis === "z" ? "x" : "z";
  const wheelBase = Math.abs(hubs.frontHub[longAxis] - hubs.rearHub[longAxis]);
  const mid = (hubs.frontHub[longAxis] + hubs.rearHub[longAxis]) / 2;
  const forwardSign = Math.sign(hubs.frontHub[longAxis] - mid);
  const midplane = hubs.rearHub[axleAxis];

  const size = (p: Part): THREE.Vector3 => p.box.getSize(new THREE.Vector3());
  const center = (p: Part): THREE.Vector3 => p.box.getCenter(new THREE.Vector3());

  const tubes = parts.filter((p) => {
    if (p.triangles.length < 60) return false;
    const s = size(p);
    const c = center(p);
    const tall = s.y > FORK_MIN_HEIGHT * hubs.radius && s[axleAxis] < FORK_MAX_WIDTH * hubs.radius;
    const upright = s.y > 1.8 * Math.max(s[axleAxis], 0.5 * s[longAxis]);
    const overFrontHalf = (c[longAxis] - mid) * forwardSign > 0.5 * (wheelBase / 2);
    const midHeight = c.y > hubs.frontHub.y && c.y < hubs.frontHub.y + 2.5 * hubs.radius;
    return tall && upright && overFrontHalf && midHeight;
  });
  if (tubes.length < 2) return null;
  tubes.sort((a, b) => b.triangles.length - a.triangles.length);

  const up = new THREE.Vector3(0, 1, 0);
  const straightAxle = new THREE.Vector3();
  straightAxle[axleAxis] = 1;

  // The axis from the tubes: their long direction, flattened into the
  // midplane, since a motorcycle's steering axis lies in its midplane.
  const tubeAxis = principalAxis(partVertices(tubes[0]), up)
    .add(principalAxis(partVertices(tubes[1]), up))
    .normalize();
  tubeAxis[axleAxis] = 0;
  tubeAxis.normalize();

  // When the front end is posed, the wheel itself is the better witness. Its
  // axle was carried from straight-ahead to `frontAxle` by a rotation about
  // the steering axis, so that axis is perpendicular to the *change* in the
  // axle; with the axis also confined to the midplane, that pins it down
  // completely. This was learnt the hard way: the tube measurement on the
  // CB 750 came out at 15° of rake because one "tube" was a fork lower, while
  // the wheel's 14° of camber can only come from a 29° turn about an axis
  // raked 30° — the bike's real rake. Un-posing the bars about an axis 15° off
  // put them 10 cm to one side.
  const axleChange = frontAxle.clone().sub(straightAxle);
  const wheelPosed = axleChange.length() > 0.05;
  let axis = tubeAxis;
  if (wheelPosed) {
    // Solve s · (a − x) = 0 with s in the midplane and s pointing up.
    const candidate = new THREE.Vector3();
    candidate.y = -axleChange[longAxis];
    candidate[longAxis] = axleChange.y;
    if (candidate.y < 0) candidate.negate();
    if (candidate.lengthSq() > 1e-9) axis = candidate.normalize();
  }
  const rakeDeg = THREE.MathUtils.radToDeg(axis.angleTo(up));

  // Pose: the angle about the axis between the wheel's posed axle and the
  // straight-ahead axle, both projected onto the plane the axis is normal to.
  const perp = (v: THREE.Vector3): THREE.Vector3 => v.clone().addScaledVector(axis, -v.dot(axis)).normalize();
  const from = perp(frontAxle);
  const to = perp(straightAxle);
  const posedTurn = Math.atan2(from.clone().cross(to).dot(axis), from.dot(to));
  const posedTurnDeg = THREE.MathUtils.radToDeg(posedTurn);

  // Un-pose about the axis through the posed hub, then slide sideways by
  // however far the pose had carried the hub off the midplane. If the true
  // axis passes a little to one side of the hub, rotating about the hub is
  // the right rotation plus a small translation, and the hub's own lateral
  // displacement is that translation measured directly — the rear wheel,
  // never posed, says where the midplane is.
  const rotate = new THREE.Matrix4()
    .makeTranslation(hubs.frontOrigin.x, hubs.frontOrigin.y, hubs.frontOrigin.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, posedTurn))
    .multiply(new THREE.Matrix4().makeTranslation(-hubs.frontOrigin.x, -hubs.frontOrigin.y, -hubs.frontOrigin.z));
  const lateralCorrection = midplane - hubs.frontOrigin[axleAxis];
  const shift = new THREE.Vector3();
  shift[axleAxis] = lateralCorrection;
  const unpose = new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z).multiply(rotate);

  const unposedBox = (p: Part): THREE.Box3 => {
    const box = new THREE.Box3();
    for (const v of partVertices(p)) box.expandByPoint(v.applyMatrix4(unpose));
    return box;
  };
  const unposedCenter = (p: Part): THREE.Vector3 => unposedBox(p).getCenter(new THREE.Vector3());

  const limit = STEER_ASSEMBLY_RADIUS * wheelBase;
  const candidates = parts.filter((p) =>
    partVertices(p).every(
      (v) => distanceFromLine(v, hubs.frontHub, axis) < limit && (v[longAxis] - mid) * forwardSign > 0,
    ),
  );

  // Symmetry test. The whole point of a posed front end is that it has been
  // turned and the frame has not — so anything still symmetric about the
  // bike's midplane *before* un-posing cannot be part of the front end. The
  // fuel cap on the CB 750 sits centred on the tank right under the bars and
  // was being carried round with them. Two guards keep the test honest: parts
  // hugging the axis are exempt (rotation barely moves them, so their symmetry
  // proves nothing), and so are wide centred parts, which are handlebars.
  const frameParts: Part[] = [];
  let assembly = candidates;

  // Second test, geometric rather than pose-based, because the steering axis
  // extended backwards passes straight through the front of the tank, and
  // pose symmetry cannot tell a part 6 cm from the axis from one on it. The
  // CB 750's fuel cap sat there and turned with the bars. Nothing on a real
  // front end is narrow, on the centreline *and* behind the head stock:
  // mirrors, grips and levers are behind it but out at the bar ends, and the
  // risers sit on the axis itself. Measured after un-posing, on the assembly
  // as it will be drawn.
  const forward = new THREE.Vector3();
  forward[longAxis] = forwardSign;
  const behindHeadstock = (p: Part): boolean => {
    const c = unposedCenter(p);
    const d = c.clone().sub(hubs.frontHub);
    d.addScaledVector(axis, -d.dot(axis));
    const behind = -d.dot(forward) > BEHIND_HEADSTOCK * wheelBase;
    const onCentreline = Math.abs(c[axleAxis] - midplane) < CENTRELINE_HALF_WIDTH * wheelBase;
    const narrow = size(p)[axleAxis] < MIDPLANE_MAX_WIDTH * wheelBase;
    return behind && onCentreline && narrow;
  };

  if (Math.abs(posedTurnDeg) >= MIN_POSE_FOR_SYMMETRY_DEG) {
    const offAxis = (p: Part): boolean =>
      distanceFromLine(center(p), hubs.frontHub, axis) > ON_AXIS_RADIUS * wheelBase;
    const centred = (p: Part): boolean =>
      Math.abs(center(p)[axleAxis] - midplane) < MIDPLANE_TOLERANCE * wheelBase &&
      size(p)[axleAxis] < MIDPLANE_MAX_WIDTH * wheelBase;
    const hasTwin = (p: Part): boolean => {
      const c = center(p);
      const s = size(p);
      const mirrored = 2 * midplane - c[axleAxis];
      return candidates.some((q) => {
        if (q === p) return false;
        const qc = center(q);
        const qs = size(q);
        const sameSize = s.clone().sub(qs).length() < 0.25 * s.length();
        const mirrorMatch =
          Math.abs(qc[axleAxis] - mirrored) < MIDPLANE_TOLERANCE * wheelBase &&
          Math.abs(qc.y - c.y) < MIDPLANE_TOLERANCE * wheelBase &&
          Math.abs(qc[longAxis] - c[longAxis]) < MIDPLANE_TOLERANCE * wheelBase;
        return sameSize && mirrorMatch;
      });
    };
    assembly = candidates.filter((p) => {
      const frame = (offAxis(p) && (centred(p) || hasTwin(p))) || behindHeadstock(p);
      if (frame) frameParts.push(p);
      return !frame;
    });
  } else {
    assembly = candidates.filter((p) => {
      const frame = behindHeadstock(p);
      if (frame) frameParts.push(p);
      return !frame;
    });
  }


  return { axis, rakeDeg, unpose, posedTurnDeg, lateralCorrection, parts: assembly, frameParts, unposedBox };
}

/** A model reduced to the pieces the game needs, in model space. */
interface PreparedModel {
  body: THREE.Object3D;
  frontWheel: THREE.Object3D;
  rearWheel: THREE.Object3D;
  frontHub: THREE.Vector3;
  rearHub: THREE.Vector3;
  wheelRadius: number;
  strategy: BikeFitReport["strategy"];
  splitMeshes?: string[];
  splitTriangles?: number;
  spinRejected?: string[];
  frontPoseDeg?: number;
  rearPoseDeg?: number;
  /** Set when the forks were found; the assembly is already a child of `body`, named `FRONT_ASSEMBLY_NAME`. */
  steering?: SteeringGeometry;
}

/** Name of the steering assembly node inside a prepared body, so a clone can find it again. */
const FRONT_ASSEMBLY_NAME = "__frontAssembly";

/**
 * Separates the wheels — and, when it can, the steering assembly — of a model
 * that has no per-part nodes to detach.
 *
 * This exists because of how model sites actually ship files. Sketchfab's
 * auto-converted glTF merges geometry **by material**, so a bike arrives as
 * `Object_2 … Object_24` with both tyres sharing one mesh and both rims
 * sharing another — the parts are gone, even though the model itself is fine.
 * Rejecting those would rule out most of what you can actually download.
 *
 * Wheels are found per mesh by a conservative two-part test: a mesh is split
 * only if essentially **all** of it lies inside one of the two wheel discs
 * *and* it wraps the hub. Meshes that merely overlap a wheel (fork legs,
 * mudguards, the swingarm, a chain) are left alone, because the failure modes
 * are not symmetric: a brake disc that stays still inside a spinning wheel is
 * nearly invisible, while a fork leg rotating with the wheel is grotesque.
 * When in doubt, don't spin it.
 *
 * The steering assembly is then taken from what remains, as whole original
 * parts — see `findSteeringGeometry`.
 */
function autoSplitWheels(root: THREE.Object3D, meshes: MeshTriangles[]): PreparedModel | null {
  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  const longAxis: "x" | "z" = size.z >= size.x ? "z" : "x";

  const hubs = findHubs(meshes, bounds);
  if (!hubs) return null;

  const limit = hubs.radius * WHEEL_RADIUS_MARGIN;
  const frontTriangles = new Map<MeshTriangles, Triangle[]>();
  const rearTriangles = new Map<MeshTriangles, Triangle[]>();
  /** What each mesh keeps after the wheels are taken. */
  const remaining = new Map<MeshTriangles, Triangle[]>();
  const splitMeshes: string[] = [];
  const spinRejected: string[] = [];
  let splitTriangles = 0;

  for (const entry of meshes) {
    const front: Triangle[] = [];
    const rear: Triangle[] = [];
    const rest: Triangle[] = [];

    for (const tri of entry.triangles) {
      const df = radialDistance(tri.centroid, hubs.frontHub, longAxis);
      const dr = radialDistance(tri.centroid, hubs.rearHub, longAxis);
      if (df < limit && df <= dr) front.push(tri);
      else if (dr < limit) rear.push(tri);
      else rest.push(tri);
    }

    const total = entry.triangles.length;
    if (total === 0 || (front.length + rear.length) / total < WHEEL_PURITY) {
      remaining.set(entry, entry.triangles);
      continue;
    }

    // Inside the disc is necessary but nowhere near sufficient — it must also
    // wrap the hub. Every non-empty lobe has to pass, so a mesh holding one
    // real wheel and one stray fitting is rejected rather than half-accepted.
    const lobePasses = (lobe: Triangle[], hub: THREE.Vector3): boolean =>
      lobe.length >= MIN_LOBE_TRIANGLES && angularCoverage(lobe, hub, longAxis) >= MIN_ANGULAR_COVERAGE;
    const frontOk = front.length === 0 || lobePasses(front, hubs.frontHub);
    const rearOk = rear.length === 0 || lobePasses(rear, hubs.rearHub);
    if (!frontOk || !rearOk) {
      spinRejected.push(entry.mesh.name || "(unnamed)");
      remaining.set(entry, entry.triangles);
      continue;
    }

    if (front.length) frontTriangles.set(entry, front);
    if (rear.length) rearTriangles.set(entry, rear);
    if (rest.length) remaining.set(entry, rest);
    splitMeshes.push(entry.mesh.name || "(unnamed)");
    splitTriangles += front.length + rear.length;
  }

  if (splitTriangles === 0) return null;

  const frontWheel = new THREE.Group();
  const rearWheel = new THREE.Group();
  for (const [entry, triangles] of frontTriangles) {
    frontWheel.add(buildSubsetMesh(entry, triangles, hubs.frontOrigin));
  }
  for (const [entry, triangles] of rearTriangles) {
    rearWheel.add(buildSubsetMesh(entry, triangles, hubs.rearHub));
  }

  // Straighten each wheel onto the axle axis, undoing whatever pose it was
  // modelled in. The subset meshes are already relative to their hub, so a
  // rotation on the group pivots about the hub, as it must.
  const axleAxis = longAxis === "z" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const straighten = (group: THREE.Group, lobes: Map<MeshTriangles, Triangle[]>): { deg: number; axle: THREE.Vector3 } => {
    const all = [...lobes.values()].flat();
    if (all.length < MIN_LOBE_TRIANGLES) return { deg: 0, axle: axleAxis.clone() };
    const axle = fitAxle(all, axleAxis);
    group.quaternion.setFromUnitVectors(axle, axleAxis);
    return { deg: THREE.MathUtils.radToDeg(axle.angleTo(axleAxis)), axle };
  };
  const frontFit = straighten(frontWheel, frontTriangles);
  const rearFit = straighten(rearWheel, rearTriangles);

  // Everything that is not wheel, as original parts.
  const parts: Part[] = [];
  for (const [entry, triangles] of remaining) parts.push(...connectedParts(entry, triangles));

  const steering = findSteeringGeometry(parts, hubs, longAxis, frontFit.axle);
  const steeringParts = new Set(steering?.parts ?? []);

  // Rebuild the body from what's left. A mesh that lost nothing keeps its
  // shared geometry; one that did is rebuilt from its remaining triangles.
  const body = new THREE.Group();
  const bodyTriangles = new Map<MeshTriangles, Triangle[]>();
  for (const part of parts) {
    if (steeringParts.has(part)) continue;
    const list = bodyTriangles.get(part.entry) ?? [];
    list.push(...part.triangles);
    bodyTriangles.set(part.entry, list);
  }
  for (const entry of meshes) {
    const keep = bodyTriangles.get(entry) ?? [];
    if (keep.length === 0) continue;
    if (keep.length === entry.triangles.length) {
      const clone = entry.mesh.clone();
      entry.toRoot.decompose(clone.position, clone.quaternion, clone.scale);
      body.add(clone);
    } else {
      body.add(buildSubsetMesh(entry, keep, new THREE.Vector3()));
    }
  }

  if (steering) {
    // The assembly pivots about the front hub, so its meshes are built
    // relative to it; the group then sits at the hub inside the body.
    const assembly = new THREE.Group();
    assembly.name = FRONT_ASSEMBLY_NAME;
    assembly.position.copy(hubs.frontHub);
    const byEntry = new Map<MeshTriangles, Triangle[]>();
    for (const part of steering.parts) {
      const list = byEntry.get(part.entry) ?? [];
      list.push(...part.triangles);
      byEntry.set(part.entry, list);
    }
    for (const [entry, triangles] of byEntry) {
      assembly.add(buildSubsetMesh(entry, triangles, hubs.frontHub, steering.unpose));
    }
    body.add(assembly);
  }

  return {
    body,
    frontWheel,
    rearWheel,
    frontHub: hubs.frontHub,
    rearHub: hubs.rearHub,
    wheelRadius: hubs.radius,
    strategy: "auto-split",
    splitMeshes,
    splitTriangles,
    spinRejected,
    frontPoseDeg: frontFit.deg,
    rearPoseDeg: rearFit.deg,
    steering: steering ?? undefined,
  };
}

/** Re-parents `node` under `parent`, preserving the transform it had relative to the model root. */
function detachInto(node: THREE.Object3D, parent: THREE.Object3D): void {
  const worldMatrix = node.matrixWorld.clone();
  node.removeFromParent();
  worldMatrix.decompose(node.position, node.quaternion, node.scale);
  parent.add(node);
}

/** Preferred route: the model already has the wheels as separate named nodes. */
function prepareByNodeNames(root: THREE.Object3D, fitting: BikeFitting): PreparedModel | null {
  const model = root.clone(true);
  model.updateMatrixWorld(true);

  const front = findNode(model, fitting.frontWheelNode);
  const rear = findNode(model, fitting.rearWheelNode);
  if (!front || !rear || front === rear) return null;

  const frontHub = hubOf(front);
  const rearHub = hubOf(rear);
  const radius = new THREE.Box3().setFromObject(front).getSize(new THREE.Vector3()).y / 2;

  const frontWheel = new THREE.Group();
  const rearWheel = new THREE.Group();
  detachInto(front, frontWheel);
  detachInto(rear, rearWheel);
  front.position.sub(frontHub);
  rear.position.sub(rearHub);

  return {
    body: model,
    frontWheel,
    rearWheel,
    frontHub,
    rearHub,
    wheelRadius: radius,
    strategy: "named-nodes",
  };
}

/**
 * Fits a loaded GLTF to the physics bike and returns a factory that stamps out
 * one independent instance per rider.
 *
 * Three things are derived from the model rather than configured, because all
 * three are measurable and guessing them is what makes fitting a model
 * miserable:
 *
 *  - **Scale**, from the distance between the two hubs against the physics
 *    wheelbase. Models arrive in centimetres, inches and arbitrary units;
 *    matching the wheelbase makes the units irrelevant.
 *  - **Heading**, from the rear hub pointing at the front hub. The result is
 *    yawed to face local +Z, the bike's forward (see `utils/Directions`). This
 *    is the axis convention that has caused four separate mirrored bugs in this
 *    project, so it is measured off the model, not assumed from its author's
 *    export settings.
 *  - **Ride height**, by placing the hub midpoint at `REST_HUB_Y`.
 *
 * Instances share geometry and materials with the prepared model, so six bikes
 * cost one upload; `dispose` therefore detaches without freeing them.
 */
export function makeGltfBikeVisualsFactory(
  source: THREE.Object3D,
  fitting: BikeFitting,
): { factory: BikeVisualsFactory; report: BikeFitReport } {
  source.updateMatrixWorld(true);

  const prepared =
    prepareByNodeNames(source, fitting) ?? autoSplitWheels(source, collectTriangles(source));

  if (!prepared) {
    throw new BikeFitError(
      `Could not find the wheels. No nodes matched "${fitting.frontWheelNode}"/` +
        `"${fitting.rearWheelNode}", and the geometry could not be split automatically ` +
        `(the model may not be an upright bike resting on the ground, or its wheels may be ` +
        `fused into the frame). Nodes found:\n  ${listNodeNames(source).join("\n  ")}`,
    );
  }

  const measuredWheelBase = prepared.frontHub.distanceTo(prepared.rearHub);
  if (measuredWheelBase < 1e-4) {
    throw new BikeFitError("The two wheels sit on top of each other; can't derive a scale.");
  }

  const autoScale = (DEFAULT_VEHICLE_CONFIG.wheelBase / measuredWheelBase) * fitting.scaleAdjust;

  // Rear hub -> front hub is the model's forward, by definition of which wheel
  // is which. Flatten it and yaw the model so it points along +Z.
  const forward = prepared.frontHub.clone().sub(prepared.rearHub);
  const headingRad = Math.atan2(forward.x, forward.z);
  const yaw = -headingRad + THREE.MathUtils.degToRad(fitting.yawOffsetDeg);
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

  const hubMid = prepared.frontHub.clone().add(prepared.rearHub).multiplyScalar(0.5);

  // The wheel steers about the fork axis in the bike's frame, which is the
  // model-space axis carried through the fit's yaw. Vertical when unknown.
  const steeringAxis = prepared.steering
    ? prepared.steering.axis.clone().applyQuaternion(yawQuat).normalize()
    : new THREE.Vector3(0, 1, 0);

  const report: BikeFitReport = {
    strategy: prepared.strategy,
    measuredWheelBase,
    autoScale,
    headingDeg: THREE.MathUtils.radToDeg(headingRad),
    fittedWheelRadius: prepared.wheelRadius * autoScale,
    expectedWheelRadius: DEFAULT_VEHICLE_CONFIG.wheelRadius,
    splitMeshes: prepared.splitMeshes,
    splitTriangles: prepared.splitTriangles,
    spinRejected: prepared.spinRejected,
    frontPoseDeg: prepared.frontPoseDeg,
    rearPoseDeg: prepared.rearPoseDeg,
    steering: prepared.steering
      ? {
          rakeDeg: prepared.steering.rakeDeg,
          posedTurnDeg: prepared.steering.posedTurnDeg,
          parts: prepared.steering.parts.length,
          triangles: prepared.steering.parts.reduce((n, p) => n + p.triangles.length, 0),
          lateralCorrection: prepared.steering.lateralCorrection,
          frameParts: prepared.steering.frameParts.length,
          detail: [
            ...prepared.steering.parts.map((p) => ({ part: p, steers: true })),
            ...prepared.steering.frameParts.map((p) => ({ part: p, steers: false })),
          ].map(({ part, steers }) => {
            const box = prepared.steering!.unposedBox(part);
            return {
              name: part.entry.mesh.name || "(unnamed)",
              triangles: part.triangles.length,
              steers,
              min: box.min,
              max: box.max,
            };
          }),
        }
      : undefined,
  };

  enableShadows(prepared.body);
  enableShadows(prepared.frontWheel);
  enableShadows(prepared.rearWheel);

  const factory: BikeVisualsFactory = (color: number) => {
    /** Wraps a prepared piece in the fit transform. */
    const wrap = (piece: THREE.Object3D): THREE.Object3D => {
      const outer = new THREE.Group();
      const fit = new THREE.Group();
      fit.quaternion.copy(yawQuat);
      fit.scale.setScalar(autoScale);
      fit.add(piece.clone(true));
      outer.add(fit);
      return outer;
    };

    const wheels: [THREE.Object3D, THREE.Object3D] = [
      wrap(prepared.frontWheel),
      wrap(prepared.rearWheel),
    ];

    const body = new THREE.Group();
    const bodyFit = new THREE.Group();
    bodyFit.quaternion.copy(yawQuat);
    bodyFit.scale.setScalar(autoScale);
    bodyFit.position.set(fitting.offsetX, REST_HUB_Y + fitting.offsetY, fitting.offsetZ);
    const bodyClone = prepared.body.clone(true);
    bodyClone.position.sub(hubMid);
    bodyFit.add(bodyClone);
    body.add(bodyFit);

    const assemblyObject = prepared.steering ? bodyClone.getObjectByName(FRONT_ASSEMBLY_NAME) : undefined;
    const frontAssembly =
      prepared.steering && assemblyObject
        ? { object: assemblyObject, axis: prepared.steering.axis.clone() }
        : undefined;

    // Six identical bikes are unreadable at racing distance, and the rider
    // colour is how every other system (HUD, standings, debug) identifies
    // them. The placeholder got that from its body colour; a real model keeps
    // its own paint, so the identity moves to a marker above it instead.
    const bounds = new THREE.Box3().setFromObject(body);
    const identHeight = 0.28;
    const ident = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, identHeight, 8),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 }),
    );
    ident.position.set(0, (Number.isFinite(bounds.max.y) ? bounds.max.y : 0) + identHeight, 0);
    body.add(ident);

    return {
      body,
      wheels,
      steeringAxis: steeringAxis.clone(),
      frontAssembly,
      dispose(): void {
        // Geometry and materials are shared with the prepared model, so they
        // are deliberately NOT freed here — only the per-instance ident is owned.
        disposeOwned(ident);
        body.removeFromParent();
        wheels.forEach((w) => w.removeFromParent());
      },
    };
  };

  return { factory, report };
}
