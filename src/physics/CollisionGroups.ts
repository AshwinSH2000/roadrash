/**
 * Collision layers.
 *
 * The one that matters is **riders don't collide with bikes**. A ragdoll
 * spawns at the seat, and its legs reach down through the space the chassis
 * collider occupies; with default groups Rapier sees that overlap on the
 * first step and resolves it with an enormous separation impulse. Measured
 * before this existed: a body moving at 26 m/s and spinning at 54 rad/s one
 * second after a 60 km/h fall — the ragdoll exploded rather than tumbling,
 * never went quiet, and every recovery fell through to the settle timeout.
 *
 * Moving the spawn point clear of the chassis would only have postponed it,
 * since the bike is travelling at the same speed as the rider it just threw
 * and would plough into them a frame later.
 *
 * Rapier packs these as a 32-bit value: the high 16 bits are what a collider
 * *is*, the low 16 bits are what it will interact *with*. Two colliders
 * interact only if each one's membership appears in the other's filter, so
 * both sides have to agree — which is why the terrain has to be given
 * explicit groups too, rather than left on the permissive default.
 */

export const LAYER_TERRAIN = 1 << 0;
export const LAYER_BIKE = 1 << 1;
export const LAYER_RIDER = 1 << 2;

/** Packs membership and filter into Rapier's `InteractionGroups` encoding. */
export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/** Road and off-road: collide with everything that can stand or ride on them. */
export const GROUPS_TERRAIN = interactionGroups(
  LAYER_TERRAIN,
  LAYER_TERRAIN | LAYER_BIKE | LAYER_RIDER,
);

/** Bike chassis: the ground, and other bikes. Deliberately not riders. */
export const GROUPS_BIKE = interactionGroups(LAYER_BIKE, LAYER_TERRAIN | LAYER_BIKE);

/**
 * Ragdoll limbs and riders on foot: the ground, and nothing else.
 *
 * Excluding `LAYER_RIDER` from the filter means a ragdoll does not collide
 * with *itself*, which is standard practice and not an approximation to
 * apologise for. Adjacent bones deliberately overlap — the head sits inside
 * the top of the torso, the legs inside the pelvis — so that the joints have
 * somewhere to pivot without gaps opening at the seams. With self-collision
 * on, every one of those pairs is a permanent interpenetration the solver
 * tries to push apart while the joint holds it together, and the two fight:
 * measured at 90-230 rad/s sustained for six seconds, i.e. limbs spinning at
 * thirty revolutions a second and never settling.
 *
 * The cost is that two fallen riders pass through each other, which is
 * unnoticeable and vastly preferable to neither of them ever standing up.
 */
export const GROUPS_RIDER = interactionGroups(LAYER_RIDER, LAYER_TERRAIN);

/**
 * The finish line. Only bikes trip it — a rider tumbling across the line on
 * foot has not finished the race, and their loose bike sliding over it has
 * not either, but the bike carries the chassis collider so the rider-on-foot
 * exclusion is the one that matters here.
 */
export const GROUPS_FINISH_SENSOR = interactionGroups(LAYER_TERRAIN, LAYER_BIKE);

/**
 * What the vehicle's suspension raycasts are allowed to hit. Terrain only —
 * without this a bike would ride up over a fallen rider's ragdoll, since the
 * wheel rays don't go through the collider groups above.
 */
export const GROUPS_WHEEL_RAY = interactionGroups(LAYER_BIKE, LAYER_TERRAIN);
