import type * as THREE from "three";

/**
 * Where every street lamp stands, filled in by the builders as they place them.
 * At night the game puts a handful of real lights on the lamps nearest the
 * camera (`render/Environment.ts`); by day `lit` is false and the heads are dull.
 */
export interface LampRegistry {
  lit: boolean;
  /** The lamp head of each lamp, in world space. */
  positions: THREE.Vector3[];
}
