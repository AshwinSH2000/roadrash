import * as THREE from "three";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition, ROAD_HALF_WIDTH } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { buildScenery } from "../src/track/Scenery";
import { TRACKS } from "../src/track/tracks";
import { QUALITY_PRESETS } from "../src/settings/GraphicsSettings";

/**
 * The roadside dressing on every course, checked with numbers: how many signs,
 * round trees and city buildings each course gets, and that nothing stands
 * where it should not: signs clear of the asphalt, buildings clear of every
 * stretch of road (their own street's included) and of the playable ground.
 *
 * Run with: node scripts/run-sim.mjs scenery
 */
const quality = (QUALITY_PRESETS as any).high ?? Object.values(QUALITY_PRESETS as any)[0];
const physics = await PhysicsWorld.create();
console.log("course               signs  round trees  buildings  worst gap building->road  signs off-road  light");
for (const layout of TRACKS) {
  const track = new TrackDefinition(layout);
  const built = buildTrack(physics, new THREE.Scene(), track, new SurfaceRegistry());
  const scenery = buildScenery(track, quality);

  const signs = built.group.getObjectByName("curve-signs");
  const posts = signs?.getObjectByName("sign-posts") as THREE.InstancedMesh | undefined;
  const crowns = scenery.group.getObjectByName("scenery-crowns") as THREE.InstancedMesh | undefined;
  const street = scenery.group.getObjectByName("city-street");

  // Distance from a ground point to the nearest road centreline sample.
  const nearestRoad = (p: THREE.Vector3): number => {
    let best = Infinity;
    for (let i = 0; i < track.samplePoints.length; i += 2) {
      const q = track.samplePoints[i];
      best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
    }
    return best;
  };

  // Buildings: each footprint corner must be well clear of every road.
  let buildings = 0;
  let worst = Infinity;
  street?.children.forEach((child) => {
    const mesh = child as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const size = new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute("position") as THREE.BufferAttribute).getSize(new THREE.Vector3());
    const matrix = new THREE.Matrix4();
    const corner = new THREE.Vector3();
    for (let n = 0; n < mesh.count; n++) {
      buildings++;
      mesh.getMatrixAt(n, matrix);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        corner.set((sx * size.x) / 2, 0, (sz * size.z) / 2).applyMatrix4(matrix);
        worst = Math.min(worst, nearestRoad(corner));
      }
    }
  });

  let offRoad = 0;
  if (posts) {
    const matrix = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let n = 0; n < posts.count; n++) {
      posts.getMatrixAt(n, matrix);
      p.setFromMatrixPosition(matrix);
      if (nearestRoad(p) < ROAD_HALF_WIDTH + 1.2) offRoad++;
    }
  }
  const light = built.group.getObjectByName("start-light");
  console.log(
    `${layout.name.padEnd(20)} ${String(posts?.count ?? 0).padStart(4)}  ${String(crowns?.count ?? 0).padStart(10)}  ${String(buildings).padStart(9)}  ${(buildings ? worst.toFixed(1) + " m" : "-").padStart(22)}  ${String(offRoad).padStart(13)}  ${light ? "yes" : "NO"}`,
  );
  scenery.dispose();
}
