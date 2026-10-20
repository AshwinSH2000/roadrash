import * as THREE from "three";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildScenery } from "../src/track/Scenery";
import { TRACKS } from "../src/track/tracks";
import { QUALITY_PRESETS } from "../src/settings/GraphicsSettings";

/**
 * The backdrop mountains must never stand over the road: a mountain's foot is as wide as the mountain, and a
 * broad one placed too close covered the road ahead (it faded in out of the fog a few seconds into a race).
 * Places them 30 times per course (the placement is random) and counts the placements where one reaches the road.
 *
 * Run with: node scripts/run-sim.mjs mountains
 */
console.log("backdrop mountains whose foot reaches over the road (30 random placements per course):");
let failures = 0;
for (const layout of TRACKS) {
  const track = new TrackDefinition(layout);
  let overlaps = 0, trials = 30, worstHeight = 0, worstCover = 0;
  for (let n = 0; n < trials; n++) {
    const scenery = buildScenery(track, QUALITY_PRESETS.medium);
    let over = false;
    scenery.group.traverse((o) => {
      const peaks = o as THREE.InstancedMesh;
      if (!peaks.isInstancedMesh || !peaks.name.startsWith("scenery-mountain-backdrop")) return;
      const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      for (let i = 0; i < peaks.count; i++) {
        peaks.getMatrixAt(i, m);
        m.decompose(p, q, s);
        let best = Infinity, roadY = 0;
        for (const r of track.samplePoints) {
          const d = Math.hypot(r.x - p.x, r.z - p.z);
          if (d < best) { best = d; roadY = r.y; }
        }
        // The foot's radius is its x-scale; height at the road's nearest point is roughly (1 - d/R)^1.25 of the peak's.
        if (best < s.x) {
          const heightThere = p.y + s.y * Math.pow(1 - best / s.x, 1.25);
          if (heightThere > roadY + 5) { over = true; worstHeight = Math.max(worstHeight, heightThere - roadY); worstCover = Math.max(worstCover, 1 - best / s.x); }
        }
      }
    });
    if (over) overlaps++;
    scenery.dispose();
  }
  failures += overlaps;
  console.log(`  ${layout.name.padEnd(18)} ${String(overlaps).padStart(2)}/${trials} placements have a mountain standing over the road${overlaps ? `, up to ${worstHeight.toFixed(0)} m above it` : ""}`);
}

console.log(failures === 0 ? "\nPASS  no mountain stands over a road." : `\nFAIL  ${failures} placements had a mountain over a road.`);
