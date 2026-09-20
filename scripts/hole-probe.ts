import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PhysicsWorld } from "../src/physics/PhysicsWorld";
import { SurfaceRegistry } from "../src/physics/TerrainMaterial";
import { TrackDefinition } from "../src/track/TrackDefinition";
import { buildTrack } from "../src/track/TrackBuilder";
import { hillclimbLayout } from "../src/track/tracks";

/** Casts rays down onto the centreline of the Wall to find where the road physically is — or isn't. */
const physics = await PhysicsWorld.create();
const surfaces = new SurfaceRegistry();
const track = new TrackDefinition(hillclimbLayout());
buildTrack(physics, new THREE.Scene(), track, surfaces);
// Queries see nothing until the world has stepped once and built its broad-phase.
physics.step();
const FROM = +(process.env.FROM ?? 780), TO = +(process.env.TO ?? 1080), STEP = +(process.env.STEP ?? 6);
console.log("  dist    spline y    physics hit y (centre)   +5m right   -5m right    tangent(x,y,z)         right(x,z)");
for (let d = FROM; d <= TO; d += STEP) {
  const cols: string[] = [];
  for (const lateral of [0, 5, -5]) {
    const p = track.spawnPoint(d, lateral, 0);
    const hit = physics.world.castRay(new RAPIER.Ray({ x: p.x, y: 500, z: p.z }, { x: 0, y: -1, z: 0 }), 1000, true);
    cols.push(hit ? (500 - hit.timeOfImpact).toFixed(1).padStart(8) : "    HOLE");
  }
  const sp = track.spawnPoint(d, 0, 0).y;
  const i = track.sampleIndexAt(d);
  const tg = track.sampleTangents[i], rt = track.sampleRights[i];
  console.log(`${d.toFixed(1).padStart(7)} ${sp.toFixed(2).padStart(10)}   ${cols[0]}                ${cols[1]}    ${cols[2]}    (${tg.x.toFixed(2)}, ${tg.y.toFixed(2)}, ${tg.z.toFixed(2)})   (${rt.x.toFixed(2)}, ${rt.z.toFixed(2)})`);
}
