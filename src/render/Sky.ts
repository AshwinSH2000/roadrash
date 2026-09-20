import * as THREE from "three";
import type { TrackDefinition } from "../track/TrackDefinition";
import type { GraphicsSettings } from "../settings/GraphicsSettings";
import { createCloudTexture } from "./Textures";

/**
 * Scattered cloud sprites over the course, so the sky isn't a flat colour
 * either — the same complaint the ground-fill band in `TrackBuilder` answers,
 * one level up. `THREE.Sprite` always faces the camera on its own, which is
 * exactly what a distant, roughly-round cloud needs and means there's no
 * per-frame billboarding to do here.
 *
 * Scattered around the track's own bounding circle (computed from its
 * samples) rather than around the world origin, so a course that isn't
 * authored near (0,0,0) still gets clouds over the part of the world that's
 * actually played on.
 */

const MIN_COUNT = 12;
const EXTRA_COUNT = 16;
/** How far above the track's highest sampled point clouds start. */
const HEIGHT_ABOVE_PEAK = 90;
const HEIGHT_SPREAD = 100;
/** Extra radius past the track's own bounding circle, so clouds don't stop exactly at its edge. */
const RADIUS_MARGIN = 250;

export interface Sky {
  group: THREE.Group;
  dispose(): void;
}

/** `quality.sceneryDensity` reused here too — more clouds on higher presets, none of it free-standing new tuning. */
export function buildClouds(track: TrackDefinition, quality: GraphicsSettings): Sky {
  const group = new THREE.Group();
  group.name = "clouds";

  const texture = createCloudTexture();
  if (!texture || track.samplePoints.length === 0) {
    // No `<canvas>` (headless) or nothing to scatter around — an empty, inert
    // group either way; nothing here assumes callers checked first.
    return { group, dispose: () => {} };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = -Infinity;
  for (const p of track.samplePoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    if (p.y > maxY) maxY = p.y;
  }
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const radius = Math.max(maxX - minX, maxZ - minZ) / 2 + RADIUS_MARGIN;

  const count = Math.round(MIN_COUNT + EXTRA_COUNT * quality.sceneryDensity);
  for (let i = 0; i < count; i++) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity: 0.7 + Math.random() * 0.25,
      rotation: Math.random() * Math.PI * 2,
    });
    const sprite = new THREE.Sprite(material);

    // Uniform placement over a disc needs the square root, or points bunch
    // toward the centre.
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * radius;
    const width = 70 + Math.random() * 90;
    sprite.scale.set(width, width * (0.45 + Math.random() * 0.25), 1);
    sprite.position.set(
      centerX + Math.cos(angle) * dist,
      maxY + HEIGHT_ABOVE_PEAK + Math.random() * HEIGHT_SPREAD,
      centerZ + Math.sin(angle) * dist,
    );
    group.add(sprite);
  }

  return {
    group,
    dispose(): void {
      texture.dispose();
      for (const child of group.children) {
        if (child instanceof THREE.Sprite) (child.material as THREE.SpriteMaterial).dispose();
      }
    },
  };
}
