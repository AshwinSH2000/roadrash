import * as THREE from "three";
import { TrackRecipe, type TrackLayout } from "./TrackLayout";

/**
 * The courses. One is picked at random for each race (`pickTrack`); a
 * `?track=Name` query on the URL forces one. All of them must pass
 * `npm run check:track`, which applies the same four rules to every entry.
 *
 * The first entry is the original hand-authored course and stays first on
 * purpose: it is the default for every headless simulation and the replay
 * fixtures, which were recorded on it.
 */

/**
 * The original v1 course, drawn point by point. Kept verbatim: the
 * headless sims, the replay fixtures and a lot of tuning were done on it.
 */
const ORIGINAL: TrackLayout = {
  name: "Ridgeway",
  description: "The original course — sweeping curves and gentle hills, six corners that need real braking.",
  points: [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 1.8, 55),
  new THREE.Vector3(0, 0.4, 110),
  new THREE.Vector3(0, -3.7, 165),
  new THREE.Vector3(4, -7.8, 219),
  new THREE.Vector3(23, -10, 269),
  new THREE.Vector3(57, -10.2, 311),
  new THREE.Vector3(101, -10, 342),
  new THREE.Vector3(148, -9.8, 369),
  new THREE.Vector3(196, -8.9, 397),
  new THREE.Vector3(211, -8.2, 406),
  new THREE.Vector3(226, -7.3, 414),
  new THREE.Vector3(243, -6.1, 418),
  new THREE.Vector3(260, -4.9, 417),
  new THREE.Vector3(277, -3.5, 411),
  new THREE.Vector3(291, -2.1, 401),
  new THREE.Vector3(301, -0.8, 387),
  new THREE.Vector3(310, 0.4, 371),
  new THREE.Vector3(318, 1.2, 356),
  new THREE.Vector3(327, 1.8, 341),
  new THREE.Vector3(355, 1.1, 294),
  new THREE.Vector3(370, -0.3, 271),
  new THREE.Vector3(390, -2, 254),
  new THREE.Vector3(415, -3.9, 243),
  new THREE.Vector3(442, -5.5, 241),
  new THREE.Vector3(469, -6.8, 245),
  new THREE.Vector3(496, -7.6, 250),
  new THREE.Vector3(522, -8.2, 254),
  new THREE.Vector3(539, -8.5, 257),
  new THREE.Vector3(555, -8.9, 262),
  new THREE.Vector3(569, -9.2, 271),
  new THREE.Vector3(580, -9.6, 285),
  new THREE.Vector3(586, -10, 300),
  new THREE.Vector3(587, -10.4, 317),
  new THREE.Vector3(584, -10.8, 334),
  new THREE.Vector3(578, -11.2, 350),
  new THREE.Vector3(572, -11.3, 366),
  new THREE.Vector3(566, -11.3, 382),
  new THREE.Vector3(547, -9.5, 434),
  new THREE.Vector3(528, -5.2, 485),
  new THREE.Vector3(510, -0.7, 537),
  new THREE.Vector3(503, 1.3, 591),
  new THREE.Vector3(508, 0.3, 646),
  new THREE.Vector3(528, -2.2, 698),
  new THREE.Vector3(551, -4.3, 748),
  new THREE.Vector3(560, -4.9, 767),
  new THREE.Vector3(569, -5.4, 785),
  new THREE.Vector3(582, -6, 802),
  new THREE.Vector3(600, -6.7, 813),
  new THREE.Vector3(620, -7.6, 819),
  new THREE.Vector3(641, -8.5, 818),
  new THREE.Vector3(661, -9.6, 813),
  new THREE.Vector3(682, -10.7, 808),
  new THREE.Vector3(700, -11.5, 803),
  new THREE.Vector3(718, -12.2, 798),
  new THREE.Vector3(736, -12.5, 791),
  new THREE.Vector3(752, -12.4, 780),
  new THREE.Vector3(763, -12, 765),
  new THREE.Vector3(769, -11.1, 747),
  new THREE.Vector3(770, -9.9, 728),
  new THREE.Vector3(767, -8.4, 710),
  new THREE.Vector3(763, -6.8, 691),
  new THREE.Vector3(760, -5.1, 672),
  new THREE.Vector3(750, -1.3, 618),
  new THREE.Vector3(741, 0.1, 564),
  new THREE.Vector3(741, -0.4, 519),
  new THREE.Vector3(754, -1.3, 476),
  new THREE.Vector3(780, -2, 439),
  new THREE.Vector3(809, -2.8, 404),
  new THREE.Vector3(844, -4.8, 362),
  new THREE.Vector3(856, -5.9, 349),
  new THREE.Vector3(870, -7, 339),
  new THREE.Vector3(886, -8.3, 334),
  new THREE.Vector3(904, -9.5, 334),
  new THREE.Vector3(920, -10.7, 339),
  new THREE.Vector3(935, -11.7, 349),
  new THREE.Vector3(947, -12.5, 362),
  new THREE.Vector3(959, -12.9, 374),
  new THREE.Vector3(972, -13, 386),
  new THREE.Vector3(1011, -10.9, 425),
  new THREE.Vector3(1050, -6.9, 464),
  new THREE.Vector3(1089, -3.4, 503),
  ],
};

/**
 * Recipe notes: positive angles turn LEFT. The validator needs at least four
 * corners under ~80 m radius (real braking zones), none under 39 m (the
 * off-road band folds through itself), grades under 12%, and no two stretches
 * closer than 70 m unless they are within 120 m of each other along the road.
 * Alternate turn directions to keep the course progressing rather than
 * curling back on itself.
 */
const SWITCHBACK = new TrackRecipe()
  .straight(180, 4)
  .arc(70, -100, 3)
  .straight(140, 5)
  .arc(55, 110, 4)
  .straight(160, 6)
  .arc(60, -95, 3)
  .straight(120, 5)
  .arc(50, 105, 2)
  .straight(220, -6)
  .arc(160, -40, -4)
  .straight(160, -5)
  .arc(65, 100, -3)
  .straight(150, -4)
  .arc(58, -110, -2)
  .straight(260, 2)
  .build("Switchback Pass", "Hairpins linked by short straights, climbing then falling — brake, turn, fire it out.");

const SWEEPS = new TrackRecipe()
  .straight(260, 3)
  .arc(190, 55, 4)
  .straight(120, 3)
  .arc(170, -70, 2)
  .straight(200, -3)
  .arc(75, 90, -4)
  .straight(180, -5)
  .arc(210, -45, -2)
  .straight(140, 2)
  .arc(68, -105, 3)
  .straight(220, 5)
  .arc(160, 60, 2)
  .straight(120, 1)
  .arc(72, 95, -3)
  .straight(200, -4)
  .arc(180, -50, -2)
  .straight(280, 0)
  .build("Long Sweeps", "Mostly flat-out — big fast sweepers with a few tight corners hidden among them.");

/**
 * The Wall on Hillclimb: one climb far steeper than anything else in the
 * game, and a matching drop on the far side. 30% (16.7 degrees) over 120 m —
 * 36 m of climb — which is steeper than the steepest street in the world.
 *
 * The grade was found by measurement (`npm run sim:climb`), not chosen: at
 * 30% a bike stopped dead on the slope can still climb out; at 35% and
 * beyond it rolls back down, and a player who slowed on it would be
 * stranded. At racing speed the crest is a 0.9 s jump.
 */
export const WALL_GRADE = 0.3;
export const WALL_RUN = 120;

/** Hillclimb with the Wall at a given grade — exported so `sim:climb` can probe steeper ones. */
export function hillclimbLayout(wallGrade = WALL_GRADE): TrackLayout {
  return new TrackRecipe()
  .straight(150, 8)
  .arc(90, -80, 6)
  .straight(160, 10)
  .arc(64, 95, 4)
  .straight(160, 6)
  // The Wall: a flat approach, the climb, a short crest, and the drop.
  .straight(80, 0)
  .straight(WALL_RUN, WALL_RUN * wallGrade)
  .straight(50, 0)
  .straight(WALL_RUN, -WALL_RUN * wallGrade)
  .straight(120, 0)
  .arc(140, -60, 4)
  .straight(160, 8)
  .arc(58, 110, 2)
  .straight(140, 6)
  .arc(70, -100, 0)
  .straight(180, -8)
  .arc(120, 65, -10)
  .straight(160, -12)
  .arc(62, -95, -6)
  .straight(220, -10)
  .arc(150, 50, -4)
  .straight(240, -2)
  .build("Hillclimb", "Up over the ridge and down the other side — and one wall of a climb with a drop to match.");
}

const HILLCLIMB = hillclimbLayout();

const ESSES = new TrackRecipe()
  .straight(200, 2)
  .arc(80, 60, 2)
  .arc(80, -65, 1)
  .arc(85, 60, 0)
  .straight(90, -2)
  .arc(56, -100, -2)
  .straight(160, -3)
  .arc(95, 55, -2)
  .arc(95, -55, -1)
  .arc(100, 50, 0)
  .straight(120, 2)
  .arc(52, 105, 3)
  .straight(180, 4)
  .arc(75, -85, 2)
  .arc(78, 80, 1)
  .straight(140, 0)
  .arc(60, -100, -2)
  .straight(260, -3)
  .build("The Esses", "Rhythm section — left-right-left flicks where carrying speed matters more than top speed.");

export const TRACKS: readonly TrackLayout[] = [ORIGINAL, SWITCHBACK, SWEEPS, HILLCLIMB, ESSES];

export const DEFAULT_TRACK = TRACKS[0];

/** By name (case-insensitive, spaces optional), or a random pick when no name matches. */
export function pickTrack(name?: string | null, random: () => number = Math.random): TrackLayout {
  if (name) {
    const wanted = name.toLowerCase().replace(/[\s_-]/g, "");
    const found = TRACKS.find((t) => t.name.toLowerCase().replace(/[\s_-]/g, "") === wanted);
    if (found) return found;
  }
  return TRACKS[Math.floor(random() * TRACKS.length) % TRACKS.length];
}
