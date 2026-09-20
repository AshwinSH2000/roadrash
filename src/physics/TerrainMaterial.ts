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
  frictionSlip: 1.15,
  // Sized so off-road terminal speed lands around half of on-road: the drag
  // curve (resistance * speed) meets the engine's falling torque curve at
  // roughly 20 m/s instead of the ~40 m/s the road allows.
  rollingResistance: 70,
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
