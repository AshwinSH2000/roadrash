import type RAPIER from "@dimforge/rapier3d-compat";

/**
 * How a given ground surface behaves under a tyre. Road is the reference
 * surface; anything off it should be meaningfully worse to ride on in both
 * respects the design calls for — less grip *and* more resistance — so
 * leaving the road is a real cost rather than just a cosmetic change.
 */
export interface SurfaceProperties {
  readonly name: string;
  /** Tyre grip fed to the raycast vehicle's per-wheel friction model. */
  readonly frictionSlip: number;
  /** Speed-proportional drag, in newtons per (m/s), applied while a wheel is on this surface. */
  readonly rollingResistance: number;
}

export const ROAD_SURFACE: SurfaceProperties = {
  name: "road",
  frictionSlip: 3.2,
  rollingResistance: 0,
};

export const OFFROAD_SURFACE: SurfaceProperties = {
  name: "offroad",
  // Grip down to ~62% of road (was ~36%) — leaving the road still costs
  // real traction, but less harshly than before.
  frictionSlip: 2.0,
  // Scaled down by the same ratio as frictionSlip, so the drag penalty eases
  // off in step with the grip penalty rather than staying disproportionately
  // harsh. Re-check terminal speed empirically if this still feels off.
  rollingResistance: 40,
};

/**
 * Anything a wheel lands on that wasn't explicitly registered — treated as
 * road so that an unregistered collider can never silently make a rider
 * undriveable.
 */
export const DEFAULT_SURFACE = ROAD_SURFACE;

/**
 * Maps collider handles to their surface. The raycast vehicle tells us which
 * collider each wheel is resting on (`wheelGroundObject`), so a lookup here
 * is all that's needed to know what a rider is riding on.
 */
export class SurfaceRegistry {
  private readonly byHandle = new Map<number, SurfaceProperties>();

  register(collider: RAPIER.Collider, surface: SurfaceProperties): void {
    this.byHandle.set(collider.handle, surface);
  }

  lookup(collider: RAPIER.Collider | null): SurfaceProperties {
    if (!collider) return DEFAULT_SURFACE;
    return this.byHandle.get(collider.handle) ?? DEFAULT_SURFACE;
  }
}
