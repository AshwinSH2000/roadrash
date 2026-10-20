import * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";
import { OFFROAD_HALF_WIDTH } from "./TrackDefinition";
import type { GraphicsSettings } from "../settings/GraphicsSettings";
import { createCliffTexture, createGrassTexture } from "../render/Textures";

/**
 * Rolling hills beyond the road, so the country is country and not a flat
 * plane with a cliff round the course.
 *
 * One terrain mesh over a grid, visual only: no collider, because the
 * invisible boundary wall still stops a rider at the edge of the off-road band
 * long before any hill. Its height is the course's own elevation near the
 * road, so the hills sit on the land the road runs over, and grows into
 * hills farther out:
 *
 *   height = base - 2.5 + rise
 *
 *  - `base` is the elevation of the nearest stretch of road, blending toward a
 *    smooth average over every stretch (inverse-distance weighted) a hundred
 *    metres out, so two roads at different heights do not tear the ground
 *    between them.
 *  - `-2.5` is where the off-road band's outer edge stands relative to the road
 *    (`OFFROAD_OUTER_DROP`): with `rise` zero this close, the terrain meets that
 *    edge exactly and runs on from it.
 *  - `rise` is zero out to the band's edge plus a margin, then swells with
 *    distance into value-noise hills, tall in the mountains, gentle in the
 *    farmland and zero in towns. It is capped so no hill stands over the road.
 *
 * The grid is only built where the fog has not already hidden it (the quality
 * preset's `fogFar` from the road). It is left out only where a river's pit is
 * (the pit is built elsewhere and the terrain would cover it): every grid cell
 * that touches the pit's footprint, no more. Round the gap the cut edge drops
 * in a rock wall to the river bed, so the hillside ends in a gorge and there is
 * never a gap to see through.
 */

/** Where the off-road band's outer edge sits relative to the road, in metres (`TrackBuilder`'s `OFFROAD_OUTER_DROP`). */
const BAND_EDGE_DROP = -2.5;
/** The terrain starts to rise this far from the nearest road: just past the off-road band's edge. */
const RISE_START = OFFROAD_HALF_WIDTH + 6;
/** It reaches full height this far out. */
const RISE_FULL = 170;
/** Where the nearest road's own elevation stops being the base and the smooth average takes over. */
const BASE_BLEND_START = OFFROAD_HALF_WIDTH + 6;
const BASE_BLEND_END = 120;
/** How high the hills stand over their base, in metres, by kind of country. */
const HILL_HEIGHT = { forest: 24, farm: 20, mountain: 55, city: 0 } as const;
/** Grid cell edge by quality: smaller is smoother and costs more triangles. */
const CELL_SIZE = { low: 40, medium: 28, high: 20 } as const;
/** A river's pit is this much bigger than its footprint, in metres, when deciding which terrain cells to leave out. */
const PIT_MARGIN = 4;
/** How far the gorge walls reach below the ground-fill plane's own bed, a little past the river bed. */
const GORGE_BED_LIFT = 0.35;
/** Metres one repeat of the grass texture covers. */
const GRASS_TILE = 14;

export interface Hills {
  group: THREE.Group;
  /** Height of the terrain at a world position (bilinear over the grid): where a tree or a rock should stand. */
  heightAt(x: number, z: number): number;
  dispose(): void;
}

/** A small deterministic hash of a name, to seed the noise so a course always has the same hills. */
function seedOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Smooth 2D value noise in 0..1. */
function makeNoise(seed: number): (x: number, y: number) => number {
  const lattice = (ix: number, iy: number): number => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = lattice(ix, iy);
    const b = lattice(ix + 1, iy);
    const c = lattice(ix, iy + 1);
    const d = lattice(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function buildHills(track: TrackDefinition, quality: GraphicsSettings, groundFillY: number): Hills {
  const group = new THREE.Group();
  group.name = "hills";

  // Road samples to measure against (every third is plenty), with their elevation and kind of country.
  const stride = 3;
  const road: { x: number; y: number; z: number; height: number }[] = [];
  let sumY = 0;
  for (let i = 0; i < track.samplePoints.length; i += stride) {
    const p = track.samplePoints[i];
    road.push({ x: p.x, y: p.y, z: p.z, height: HILL_HEIGHT[track.biomeAt(track.sampleDistances[i])] });
    sumY += p.y;
  }
  if (road.length < 2) return { group, heightAt: () => groundFillY, dispose: () => {} };

  const cell = CELL_SIZE[quality.level];
  const reach = quality.fogFar + 60;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of road) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  minX = Math.floor((minX - reach) / cell) * cell;
  minZ = Math.floor((minZ - reach) / cell) * cell;
  const columns = Math.ceil((maxX + reach - minX) / cell) + 1;
  const rows = Math.ceil((maxZ + reach - minZ) / cell) + 1;
  if (columns * rows > 160000) return { group, heightAt: () => groundFillY, dispose: () => {} };

  const noise = makeNoise(seedOf(track.name));
  const hillShape = (x: number, z: number): number => {
    const n = 0.55 * noise(x / 420, z / 420) + 0.3 * noise(x / 190 + 40, z / 190 + 40) + 0.15 * noise(x / 80 + 90, z / 80 + 90);
    return Math.pow(n, 1.35);
  };

  const heights = new Float32Array(columns * rows);
  const clearance = new Float32Array(columns * rows); // distance to the nearest road
  const colours = new Float32Array(columns * rows * 3);
  const meanY = sumY / road.length;
  const colour = new THREE.Color();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = minX + c * cell;
      const z = minZ + r * cell;
      let nearest = Infinity;
      let nearestY = meanY;
      let weightSum = 0;
      let weightedY = 0;
      let weightedHeight = 0;
      for (const p of road) {
        const dx = x - p.x;
        const dz = z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearest) {
          nearest = d2;
          nearestY = p.y;
        }
        const w = 1 / (d2 + 900);
        weightSum += w;
        weightedY += w * p.y;
        weightedHeight += w * p.height;
      }
      const d = Math.sqrt(nearest);
      const smoothY = weightedY / weightSum;
      const base = nearestY + (smoothY - nearestY) * smoothstep(BASE_BLEND_START, BASE_BLEND_END, d);
      const rise = (weightedHeight / weightSum) * hillShape(x, z) * smoothstep(RISE_START, RISE_FULL, d);
      const n = r * columns + c;
      heights[n] = Math.max(groundFillY + 1, base + BAND_EDGE_DROP + rise);
      clearance[n] = d;
      // Greener in the hollows, paler and drier on the tops, a little patchwork between.
      const top = Math.min(1, rise / 28);
      const patch = noise(x / 55 + 7, z / 55 + 3);
      colour.setRGB(0.62 + 0.2 * top + 0.12 * patch, 0.8 - 0.04 * top - 0.1 * patch, 0.5 + 0.06 * top - 0.12 * patch);
      colours.set([colour.r, colour.g, colour.b], n * 3);
    }
  }

  // Triangles for every cell that is within sight of the road and not in a river's valley.
  const positions = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const n = r * columns + c;
      const x = minX + c * cell;
      const z = minZ + r * cell;
      positions.set([x, heights[n], z], n * 3);
      uvs.set([x / GRASS_TILE, z / GRASS_TILE], n * 2);
    }
  }
  // Each river's pit: the oriented rectangle `buildRiver` digs (60 m across the road, the gap's length plus 6 m along it).
  const pits = track.featuresOfKind("river").map((feature) => {
    const a = track.samplePoints[feature.startIndex];
    const b = track.samplePoints[feature.endIndex];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    return { cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, heading: Math.atan2(b.x - a.x, b.z - a.z), halfAlong: (length + 6) / 2 + PIT_MARGIN, halfAcross: OFFROAD_HALF_WIDTH + PIT_MARGIN };
  });
  /** Does the grid cell with this corner touch a pit? The cell's corners in the pit's own frame, their bounding box against its extent. */
  const touchesPit = (x0: number, z0: number): boolean => {
    for (const pit of pits) {
      const cos = Math.cos(pit.heading);
      const sin = Math.sin(pit.heading);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const [cx, cz] of [[x0, z0], [x0 + cell, z0], [x0, z0 + cell], [x0 + cell, z0 + cell]]) {
        const dx = cx - pit.cx;
        const dz = cz - pit.cz;
        // Along the pit (its heading) and across it.
        const along = dx * sin + dz * cos;
        const across = dx * cos - dz * sin;
        minU = Math.min(minU, along); maxU = Math.max(maxU, along);
        minV = Math.min(minV, across); maxV = Math.max(maxV, across);
      }
      if (maxU > -pit.halfAlong && minU < pit.halfAlong && maxV > -pit.halfAcross && minV < pit.halfAcross) return true;
    }
    return false;
  };

  const built = new Uint8Array(columns * rows);
  const pitCell = new Uint8Array(columns * rows);
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = r * columns + c;
      const b = a + 1;
      const d = a + columns;
      const e = d + 1;
      const visible = Math.min(clearance[a], clearance[b], clearance[d], clearance[e]) < reach;
      if (!visible) continue;
      if (touchesPit(minX + c * cell, minZ + r * cell)) {
        pitCell[a] = 1;
        continue;
      }
      built[a] = 1;
      // Counter-clockwise seen from above, so the faces point up.
      indices.push(a, d, b, b, d, e);
    }
  }

  // The gorge: wherever a built cell has a pit cell beside it, a wall from the terrain's edge down to the river bed,
  // facing into the pit. Walls for the cell at (c, r) on each side that borders a pit cell.
  const bedY = groundFillY + GORGE_BED_LIFT;
  const wallPositions: number[] = [];
  const wallUvs: number[] = [];
  const wallIndices: number[] = [];
  const wall = (p0: number, p1: number): void => {
    // Two top vertices from the grid and two on the bed below them; the caller orders p0, p1 so the face points into the pit.
    const base = wallPositions.length / 3;
    const x0 = positions[p0 * 3], y0 = positions[p0 * 3 + 1], z0 = positions[p0 * 3 + 2];
    const x1 = positions[p1 * 3], y1 = positions[p1 * 3 + 1], z1 = positions[p1 * 3 + 2];
    const length = Math.hypot(x1 - x0, z1 - z0);
    wallPositions.push(x0, y0, z0, x1, y1, z1, x0, bedY, z0, x1, bedY, z1);
    wallUvs.push(0, y0 / 3, length / 6, y1 / 3, 0, bedY / 3, length / 6, bedY / 3);
    wallIndices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = r * columns + c;
      if (!built[a]) continue;
      const b = a + 1;
      const d = a + columns;
      const e = d + 1;
      // Neighbour cells: west (c - 1), east (c + 1), south (r - 1), north (r + 1).
      if (c > 0 && pitCell[a - 1]) wall(d, a);
      if (c < columns - 2 && pitCell[a + 1]) wall(b, e);
      if (r > 0 && pitCell[a - columns]) wall(a, b);
      if (r < rows - 2 && pitCell[a + columns]) wall(e, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const texture = createGrassTexture(2);
  if (texture) texture.repeat.set(1, 1);
  const material = new THREE.MeshStandardMaterial({ map: texture, color: texture ? 0xffffff : 0x4a7c3f, vertexColors: true, roughness: 1 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "hill-terrain";
  mesh.receiveShadow = true;
  group.add(mesh);

  let gorgeGeometry: THREE.BufferGeometry | null = null;
  let gorgeMaterial: THREE.Material | null = null;
  let gorgeTexture: THREE.Texture | null = null;
  if (wallIndices.length > 0) {
    gorgeGeometry = new THREE.BufferGeometry();
    gorgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(wallPositions, 3));
    gorgeGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(wallUvs, 2));
    gorgeGeometry.setIndex(wallIndices);
    gorgeGeometry.computeVertexNormals();
    gorgeTexture = createCliffTexture();
    gorgeMaterial = new THREE.MeshStandardMaterial({ map: gorgeTexture, color: gorgeTexture ? 0xffffff : 0x7a6a58, roughness: 1, side: THREE.DoubleSide });
    const gorge = new THREE.Mesh(gorgeGeometry, gorgeMaterial);
    gorge.name = "hill-gorge";
    gorge.receiveShadow = true;
    group.add(gorge);
  }

  const heightAt = (x: number, z: number): number => {
    const fx = THREE.MathUtils.clamp((x - minX) / cell, 0, columns - 1.001);
    const fz = THREE.MathUtils.clamp((z - minZ) / cell, 0, rows - 1.001);
    const c = Math.floor(fx);
    const r = Math.floor(fz);
    const tx = fx - c;
    const tz = fz - r;
    const n = r * columns + c;
    return (
      heights[n] * (1 - tx) * (1 - tz) + heights[n + 1] * tx * (1 - tz) + heights[n + columns] * (1 - tx) * tz + heights[n + columns + 1] * tx * tz
    );
  };

  return {
    group,
    heightAt,
    dispose(): void {
      geometry.dispose();
      material.dispose();
      texture?.dispose();
      gorgeGeometry?.dispose();
      gorgeMaterial?.dispose();
      gorgeTexture?.dispose();
    },
  };
}

/** Where the ground-fill plane sits, as `TrackBuilder` places it: below the lowest the off-road band ever drops. */
export function groundFillHeight(track: TrackDefinition): number {
  let lowest = Infinity;
  for (const p of track.samplePoints) lowest = Math.min(lowest, p.y);
  return lowest + BAND_EDGE_DROP - 3;
}

