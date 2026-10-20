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
  const street = scenery.group.getObjectByName("city-buildings");

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
  const furniture = scenery.group.getObjectByName("city-street-furniture");
  const detail = scenery.group.getObjectByName("city-building-detail");
  if (furniture) {
    // Street furniture must stand clear of the asphalt (the zebra crossing and the lights at its ends are meant to be on or by it).
    let closest = Infinity;
    const p = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const counts: string[] = [];
    furniture.children.forEach((child) => {
      const instanced = child as THREE.InstancedMesh;
      if (!instanced.isInstancedMesh) return;
      counts.push(`${instanced.name.replace("city-", "")} ${instanced.count}`);
      if (/zebra|light/.test(instanced.name)) return;
      for (let n = 0; n < instanced.count; n++) {
        instanced.getMatrixAt(n, matrix);
        p.setFromMatrixPosition(matrix);
        closest = Math.min(closest, nearestRoad(p));
      }
    });
    const detailCounts = detail ? detail.children.map((c) => `${c.name.replace("city-", "")} ${(c as THREE.InstancedMesh).count}`) : [];
    console.log(`    street: ${counts.join(", ")}\n    buildings: ${detailCounts.join(", ")}\n    nearest furniture to the road: ${closest.toFixed(1)} m (asphalt edge at ${ROAD_HALF_WIDTH} m)`);
  }
  console.log(
    `${layout.name.padEnd(20)} ${String(posts?.count ?? 0).padStart(4)}  ${String(crowns?.count ?? 0).padStart(10)}  ${String(buildings).padStart(9)}  ${(buildings ? worst.toFixed(1) + " m" : "-").padStart(22)}  ${String(offRoad).padStart(13)}  ${light ? "yes" : "NO"}`,
  );
  scenery.dispose();
}

console.log("\nrolling hills (medium / high quality):");
console.log("course               build ms   triangles (med/high)   at the band edge: worst step   highest ground over the nearest road   lowest over ground fill");
const { buildHills, groundFillHeight } = await import("../src/track/Hills");
const { QUALITY_PRESETS: presets } = await import("../src/settings/GraphicsSettings");
for (const layout of TRACKS) {
  const track = new TrackDefinition(layout);
  const fillY = groundFillHeight(track);
  const results: { ms: number; triangles: number }[] = [];
  let worstStep = 0;
  let tallest = -Infinity;
  let lowest = Infinity;
  for (const level of ["medium", "high"] as const) {
    const t0 = performance.now();
    const hills = buildHills(track, presets[level], fillY);
    const ms = performance.now() - t0;
    const mesh = hills.group.getObjectByName("hill-terrain") as THREE.Mesh | undefined;
    results.push({ ms, triangles: mesh ? (mesh.geometry.getIndex()?.count ?? 0) / 3 : 0 });
    if (level === "high") {
      // Where the off-road band ends (30 m out), the terrain should be the same height as the band's edge.
      for (let i = 0; i < track.samplePoints.length; i += 7) {
        if (track.segmentInFeature(i, "river", true) || track.segmentInFeature(i, "loop", true) || track.segmentInFeature(i, undefined, true)) continue;
        if (track.biomeAt(track.sampleDistances[i]) === "city") continue;
        const edge = track.samplePoints[i].clone().addScaledVector(track.sampleRights[i], 30);
        worstStep = Math.max(worstStep, Math.abs(hills.heightAt(edge.x, edge.z) - (track.samplePoints[i].y - 2.5)));
      }
      if (mesh) {
        // Highest the ground stands over the road nearest to it, and lowest over the ground-fill plane.
        const p = mesh.geometry.getAttribute("position");
        for (let n = 0; n < p.count; n += 11) {
          let best = Infinity;
          let roadY = 0;
          for (let i = 0; i < track.samplePoints.length; i += 4) {
            const q = track.samplePoints[i];
            const d = (q.x - p.getX(n)) ** 2 + (q.z - p.getZ(n)) ** 2;
            if (d < best) { best = d; roadY = q.y; }
          }
          if (Math.sqrt(best) < 400) tallest = Math.max(tallest, p.getY(n) - roadY);
          lowest = Math.min(lowest, p.getY(n) - fillY);
        }
      }
    }
    hills.dispose();
  }
  console.log(
    `${layout.name.padEnd(20)} ${results[0].ms.toFixed(0).padStart(5)}/${results[1].ms.toFixed(0).padEnd(5)}  ${String(results[0].triangles).padStart(8)} / ${String(results[1].triangles).padEnd(8)}  ${worstStep.toFixed(2).padStart(24)} m  ${tallest.toFixed(1).padStart(14)} m over the road beside it  ${lowest.toFixed(1).padStart(10)} m`,
  );
}

console.log("\nrivers: terrain must leave the pit open and wall its edge");
{
  const { buildHills: build, groundFillHeight: fill } = await import("../src/track/Hills");
  const { QUALITY_PRESETS: levels } = await import("../src/settings/GraphicsSettings");
  for (const layout of TRACKS) {
    const track = new TrackDefinition(layout);
    const rivers = track.featuresOfKind("river");
    if (rivers.length === 0) continue;
    for (const level of ["low", "medium", "high"] as const) {
      const hills = build(track, levels[level], fill(track));
      const terrain = hills.group.getObjectByName("hill-terrain") as THREE.Mesh;
      const gorge = hills.group.getObjectByName("hill-gorge") as THREE.Mesh | undefined;
      terrain.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      let covered = 0, tested = 0;
      let unbuiltAcross = 0;
      for (const river of rivers) {
        const a = track.samplePoints[river.startIndex];
        const b = track.samplePoints[river.endIndex];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const heading = Math.atan2(b.x - a.x, b.z - a.z);
        const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
        // Straight down through a grid of points over the pit itself.
        for (let u = -length / 2; u <= length / 2; u += 4) {
          for (let v = -30; v <= 30; v += 6) {
            const x = cx + u * Math.sin(heading) + v * Math.cos(heading);
            const z = cz + u * Math.cos(heading) - v * Math.sin(heading);
            ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
            tested++;
            if (ray.intersectObject(terrain, false).length > 0) covered++;
          }
        }
        // How far the terrain stands back from the pit: the first built point along the road's line, either side.
        for (const sign of [-1, 1]) {
          for (let off = 0; off < 300; off += 4) {
            const x = cx + sign * (length / 2 + off) * Math.sin(heading);
            const z = cz + sign * (length / 2 + off) * Math.cos(heading);
            ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
            if (ray.intersectObject(terrain, false).length > 0) { unbuiltAcross = Math.max(unbuiltAcross, off); break; }
          }
        }
      }
      console.log(`  ${layout.name.padEnd(16)} ${level.padEnd(6)} terrain over the pit: ${covered}/${tested} test points   gap along the road before terrain: ${unbuiltAcross.toFixed(0)} m   gorge walls: ${gorge ? gorge.geometry.getIndex()!.count / 6 : 0}`);
      hills.dispose();
    }
  }
}
