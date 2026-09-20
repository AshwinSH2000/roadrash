import * as THREE from "three";

/**
 * The body-frame direction conventions, defined once.
 *
 * Four separate mirrored-axis bugs in this project traced back to this being
 * re-derived ad hoc at each use site — throttle drove the bike backwards, A/D
 * steered the wrong way, the bike leaned out of corners, and `forwardSpeed`
 * reported negative while moving forwards. The trap is that the plausible
 * derivation gives the wrong answer:
 *
 *   A body whose forward is local +Z and whose up is local +Y has its own
 *   right at local **-X**, not +X.
 *
 * `right = up x forward` gives +X and does form a right-handed ordered basis,
 * which is what makes +X look correct on paper. But "the basis is
 * right-handed" and "this is the body's right hand" are different claims. In
 * three.js's coordinate system (+X right on screen, +Y up, +Z toward the
 * viewer), a body facing +Z is facing back out of the screen, so its own
 * right hand is on the viewer's left — the -X side. The correct expression is
 * `forward x up`.
 *
 * This is not asserted from that argument, though; it is **measured**. Run
 * `npm run sim:probe`, which drives the real bike with `steerInput = +1` (the
 * input the player has confirmed in the browser turns right) and reports the
 * displacement in the bike's own starting frame. It goes to -40 m along +X
 * over five seconds, and the yaw rate is negative throughout. So:
 *
 *   - the bike's right is -X
 *   - a right-hand turn is a NEGATIVE yaw rate
 *
 * Import these rather than writing axis literals inline, and if this ever
 * comes into question again, re-run the probe rather than re-deriving it.
 */

/** Direction the bike's nose points, in its own frame. */
export const LOCAL_FORWARD: Readonly<THREE.Vector3> = new THREE.Vector3(0, 0, 1);
/** Directly behind the bike — where the chase camera hangs. */
export const LOCAL_BACK: Readonly<THREE.Vector3> = new THREE.Vector3(0, 0, -1);
export const LOCAL_UP: Readonly<THREE.Vector3> = new THREE.Vector3(0, 1, 0);
export const LOCAL_DOWN: Readonly<THREE.Vector3> = new THREE.Vector3(0, -1, 0);
/** The body's own right. Note the sign — see the explanation above. */
export const LOCAL_RIGHT: Readonly<THREE.Vector3> = new THREE.Vector3(-1, 0, 0);

export const WORLD_UP: Readonly<THREE.Vector3> = new THREE.Vector3(0, 1, 0);

/**
 * Rightward direction for something travelling along `forward` on level
 * ground, written into `out`. `forward` need not be normalised or horizontal;
 * the result always is.
 */
export function rightOf(forward: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.crossVectors(forward, WORLD_UP).normalize();
}
