import type * as THREE from "three";
import type { TrackDefinition } from "./TrackDefinition";

/**
 * The starting grid: six slots, two abreast, staggered back from the start
 * line. Shared by the game and by "Race Again", so a restart puts everyone
 * back exactly where the race began.
 *
 * The rows sit *behind* the start line, which is what `START_LEAD_IN` in the
 * track definition exists to make room for.
 */
export const GRID_COLUMNS = 2;
export const GRID_ROWS = 3;
export const GRID_ROW_GAP = 7;
export const GRID_LATERAL = 2.5;

/**
 * Grid slot the player occupies, counting from the front. Last, so the race
 * starts with the whole field visibly ahead — the Road Rash opening, and the
 * arrangement that makes the AI easiest to observe while it's being tuned.
 */
export const PLAYER_GRID_SLOT = GRID_COLUMNS * GRID_ROWS - 1;

export interface GridPose {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  /** Metres along the spline, for seeding the rider's track projection. */
  distance: number;
}

export function gridPose(track: TrackDefinition, slot: number, height = 1.0): GridPose {
  const row = Math.floor(slot / GRID_COLUMNS);
  const column = slot % GRID_COLUMNS;
  const lateral = column === 0 ? -GRID_LATERAL : GRID_LATERAL;
  const distance = track.startDistance - row * GRID_ROW_GAP;
  return {
    position: track.spawnPoint(distance, lateral, height),
    rotation: track.spawnRotation(distance),
    distance,
  };
}
