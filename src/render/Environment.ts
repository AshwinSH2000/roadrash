import * as THREE from "three";
import { ROAD_HALF_WIDTH } from "../track/TrackDefinition";
import type { LampRegistry } from "../track/LampRegistry";
import type { Racer } from "../entities/Racer";
import type { GraphicsSettings } from "../settings/GraphicsSettings";

/**
 * Season and time of day: what the sky, fog and lights look like, the snow
 * that covers the scenery and the road in winter, the rain and snowfall, and
 * the night lighting (headlights and street lamps).
 *
 * Chosen on the start screen and fixed for the race, like the quality preset:
 * lights and shaders are built once for the choice. Looks only; the bikes
 * handle the same in every season and at every hour (a TODO item).
 */

export type Season = "summer" | "winter" | "rainy";
export type DayMode = "day" | "night";

export interface EnvironmentChoice {
  season: Season;
  dayMode: DayMode;
}

export const DEFAULT_ENVIRONMENT: EnvironmentChoice = { season: "summer", dayMode: "day" };
export const SEASONS: readonly Season[] = ["summer", "winter", "rainy"];
export const DAY_MODES: readonly DayMode[] = ["day", "night"];

export function isSeason(value: unknown): value is Season {
  return typeof value === "string" && (SEASONS as readonly string[]).includes(value);
}
export function isDayMode(value: unknown): value is DayMode {
  return typeof value === "string" && (DAY_MODES as readonly string[]).includes(value);
}

/** How the sky, fog and lights are set for one season and time of day. */
export interface Look {
  horizon: number;
  zenith: number;
  /** Multiplies the quality preset's fog distances: rain and night close the view in. */
  fogScale: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  /** Multiplies the cloud sprites' colour. */
  cloudTint: number;
}

const LOOKS: Record<Season, Record<DayMode, Look>> = {
  summer: {
    day: { horizon: 0xcfe6f2, zenith: 0x3f7fc4, fogScale: 1, hemiSky: 0xffffff, hemiGround: 0x3a3a3a, hemiIntensity: 1.0, sunColor: 0xffffff, sunIntensity: 2.0, cloudTint: 1 },
    night: { horizon: 0x0d1a33, zenith: 0x02050f, fogScale: 0.8, hemiSky: 0x3a4a7a, hemiGround: 0x10131c, hemiIntensity: 0.35, sunColor: 0x8fa8ff, sunIntensity: 0.35, cloudTint: 0.1 },
  },
  winter: {
    day: { horizon: 0xe6ecf2, zenith: 0x9db3c9, fogScale: 0.85, hemiSky: 0xf2f6ff, hemiGround: 0x6a707a, hemiIntensity: 1.1, sunColor: 0xf4f6ff, sunIntensity: 1.5, cloudTint: 0.95 },
    night: { horizon: 0x1c2638, zenith: 0x070c18, fogScale: 0.7, hemiSky: 0x5a6a95, hemiGround: 0x232a38, hemiIntensity: 0.5, sunColor: 0xa8bcff, sunIntensity: 0.45, cloudTint: 0.15 },
  },
  rainy: {
    day: { horizon: 0x9aa4ad, zenith: 0x5d6a78, fogScale: 0.6, hemiSky: 0xcfd6dd, hemiGround: 0x3a3d42, hemiIntensity: 0.9, sunColor: 0xdfe6ee, sunIntensity: 0.7, cloudTint: 0.5 },
    night: { horizon: 0x0e131b, zenith: 0x030609, fogScale: 0.55, hemiSky: 0x2f3a55, hemiGround: 0x0e1016, hemiIntensity: 0.28, sunColor: 0x7088b8, sunIntensity: 0.15, cloudTint: 0.08 },
  },
};

export function lookFor(choice: EnvironmentChoice): Look {
  return LOOKS[choice.season][choice.dayMode];
}

// --- Snow on everything ---------------------------------------------------------

const SNOW_COLOUR = "vec3(0.94, 0.96, 1.0)";
/** Snow on the asphalt, on the strips beside it, and on the open ground: the road stays readable against the white around it. */
const ROAD_SNOW_COVER = 0.3;
const SIDE_SNOW_COVER = 0.7;

/** Cheap value noise, 3 octaves, for drifts. */
const SNOW_NOISE = `
  float snowHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float snowNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(snowHash(i), snowHash(i + vec2(1.0, 0.0)), f.x), mix(snowHash(i + vec2(0.0, 1.0)), snowHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float snowFbm(vec2 p) {
    return 0.5 * snowNoise(p) + 0.3 * snowNoise(p * 2.1 + 7.3) + 0.2 * snowNoise(p * 4.3 + 3.1);
  }
`;

/**
 * Winter white on every standard material in `root`: surfaces that face up turn
 * snow white (roofs, treetops, rocks, the ground, the fans' shoulders), and
 * everything else is washed a little pale.
 *
 * The track and what lies beside it (`userData.snowTrack`: asphalt, shoulder,
 * kerb, pavement, off-road) are graded by distance from the centreline: 30%
 * snow on the road, about 70% just beside it, 100% further out. The grading is
 * not a clean line: the distance is shifted by a world-space noise, so the
 * three levels meet in patches and drifts, and the road itself is speckled.
 * Materials marked `userData.noSnow` are left alone.
 */
export function applySnow(root: THREE.Object3D): void {
  const seen = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.noSnow) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (seen.has(material) || !(material as THREE.MeshStandardMaterial).isMeshStandardMaterial || material.userData.noSnow) continue;
      // The track's own meshes carry `aLateral`; a track material on a mesh without it is treated as plain ground.
      const graded = Boolean(material.userData.snowTrack) && Boolean((mesh.geometry as THREE.BufferGeometry).getAttribute("aLateral"));
      seen.add(material);
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", `#include <common>\nvarying vec3 vSnowNormal;${graded ? "\nattribute float aLateral;\nvarying float vLateral;\nvarying vec2 vSnowWorld;" : ""}`)
          .replace(
            "#include <defaultnormal_vertex>",
            `#include <defaultnormal_vertex>
            {
              vec3 snowN = objectNormal;
              #ifdef USE_INSTANCING
                snowN = mat3(instanceMatrix) * snowN;
              #endif
              vSnowNormal = normalize(mat3(modelMatrix) * snowN);
              ${graded ? "vLateral = aLateral; vSnowWorld = (modelMatrix * vec4(position, 1.0)).xz;" : ""}
            }`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>\nvarying vec3 vSnowNormal;${graded ? `\nvarying float vLateral;\nvarying vec2 vSnowWorld;\n${SNOW_NOISE}` : ""}`)
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
            {
              float snowUp = smoothstep(0.45, 0.8, vSnowNormal.y);
              ${graded ? "" : "diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.85, 0.9), 0.2);"}
              float snowCover = 1.0;
              ${graded
                ? `
              // Distance from the centreline, pushed in and out by drifts about 15 m across.
              // The middle of the road is left alone, so it stays mostly dark; only near its edge do drifts creep in.
              float drift = (snowFbm(vSnowWorld * 0.07) - 0.5) * 14.0 * smoothstep(${(ROAD_HALF_WIDTH - 2.5).toFixed(1)}, ${(ROAD_HALF_WIDTH + 1).toFixed(1)}, vLateral);
              float reach = vLateral + drift;
              snowCover = mix(${ROAD_SNOW_COVER.toFixed(2)}, ${SIDE_SNOW_COVER.toFixed(2)}, smoothstep(${(ROAD_HALF_WIDTH - 2).toFixed(1)}, ${(ROAD_HALF_WIDTH + 3).toFixed(1)}, reach));
              snowCover = mix(snowCover, 1.0, smoothstep(${(ROAD_HALF_WIDTH + 3).toFixed(1)}, ${(ROAD_HALF_WIDTH + 14).toFixed(1)}, reach));
              // Small-scale speckle so no level is flat.
              snowCover = clamp(snowCover + (snowFbm(vSnowWorld * 0.9) - 0.5) * 0.3 * smoothstep(0.0, 0.5, snowCover), 0.0, 1.0);`
                : ""}
              diffuseColor.rgb = mix(diffuseColor.rgb, ${SNOW_COLOUR}, snowUp * snowCover);
            }`,
          );
      };
      material.customProgramCacheKey = () => (graded ? "snow-graded" : "snow");
      material.needsUpdate = true;
    }
  });
}

// --- Rain and snowfall -----------------------------------------------------------

const PRECIPITATION_VERTEX = `
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform vec3 uVel;
  uniform float uStreak;
  uniform float uSize;
  attribute float aEnd;
  attribute float aSeed;
  varying float vFade;
  void main() {
    vec3 p = position + uVel * uTime;
    vec3 rel = mod(p - uCam, uBox) - 0.5 * uBox;
    vec3 world = uCam + rel;
    #ifdef SNOW
      world.x += sin(uTime * 1.3 + aSeed * 6.2832) * 0.5;
      world.z += cos(uTime * 1.1 + aSeed * 6.2832) * 0.5;
    #else
      world -= uVel * uStreak * aEnd;
    #endif
    vFade = 1.0 - smoothstep(0.3, 0.5, length(rel.xz) / uBox.x);
    vec4 view = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * view;
    #ifdef SNOW
      gl_PointSize = uSize * 320.0 / max(-view.z, 0.5);
    #endif
  }
`;

const PRECIPITATION_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    float alpha = uOpacity * vFade;
    #ifdef SNOW
      vec2 c = gl_PointCoord - 0.5;
      float r = length(c);
      if (r > 0.5) discard;
      alpha *= 1.0 - smoothstep(0.25, 0.5, r);
    #endif
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/** Falling rain streaks or snowflakes in a box that follows the camera. */
export class Precipitation {
  readonly object: THREE.Object3D;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();

  constructor(kind: "rain" | "snow", quality: GraphicsSettings, night: boolean) {
    const snow = kind === "snow";
    const box = snow ? new THREE.Vector3(44, 26, 44) : new THREE.Vector3(48, 30, 48);
    const count = Math.round((snow ? 1400 : 2600) * (0.35 + 0.65 * quality.sceneryDensity));
    const perDrop = snow ? 1 : 2;
    const positions = new Float32Array(count * perDrop * 3);
    const ends = new Float32Array(count * perDrop);
    const seeds = new Float32Array(count * perDrop);
    for (let i = 0; i < count; i++) {
      const x = Math.random() * box.x;
      const y = Math.random() * box.y;
      const z = Math.random() * box.z;
      const seed = Math.random();
      for (let k = 0; k < perDrop; k++) {
        const at = (i * perDrop + k) * 3;
        positions[at] = x;
        positions[at + 1] = y;
        positions[at + 2] = z;
        ends[i * perDrop + k] = k;
        seeds[i * perDrop + k] = seed;
      }
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));
    this.geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: box },
        uVel: { value: snow ? new THREE.Vector3(0.6, -2.2, 0.3) : new THREE.Vector3(2.5, -22, 0) },
        uStreak: { value: 0.035 },
        uSize: { value: 0.05 },
        uColor: { value: new THREE.Color(snow ? 0xffffff : 0xb8c8dc).multiplyScalar(night ? 0.55 : 1) },
        uOpacity: { value: snow ? 0.9 : 0.45 },
      },
      defines: snow ? { SNOW: "" } : {},
      vertexShader: PRECIPITATION_VERTEX,
      fragmentShader: PRECIPITATION_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    const object = snow ? new THREE.Points(this.geometry, this.material) : new THREE.LineSegments(this.geometry, this.material);
    object.frustumCulled = false;
    object.name = snow ? "snowfall" : "rain";
    this.object = object;
  }

  update(seconds: number, cameraPosition: THREE.Vector3): void {
    this.material.uniforms.uTime.value = seconds;
    (this.material.uniforms.uCam.value as THREE.Vector3).copy(cameraPosition);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- Night: headlights and street lamps ----------------------------------------

/** How many bikes get a real spotlight (the player and the closest rivals), and how many lamps get a real light. */
const REAL_HEADLIGHTS = 3;
const REAL_LAMP_LIGHTS = 6;
/** Headlamp position on the bike, in its own frame (forward is +Z). */
const HEADLAMP = new THREE.Vector3(0, 0.95, 0.95);
/**
 * A lamp lens on the bike model, found by its material name ("headlights",
 * "brakelight"). Each bike takes a private copy of the material, so one bike's
 * lamp can be lit or dark alone, and the glow sits on the real lens.
 */
class Lens {
  private readonly entries = new Map<Racer, { owner: THREE.Object3D | null; materials: THREE.MeshStandardMaterial[] }>();

  constructor(
    private readonly materialName: string,
    private readonly glow: number,
    private readonly tint: number,
  ) {}

  set(racer: Racer, on: boolean): void {
    let entry = this.entries.get(racer);
    // Look again after the bike's model has been swapped.
    if (!entry || (entry.materials.length === 0 && entry.owner === null) || (entry.owner && !entry.owner.parent)) {
      const materials: THREE.MeshStandardMaterial[] = [];
      let owner: THREE.Object3D | null = null;
      racer.bike.renderGroup.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.material.name !== this.materialName) return;
        if (!mesh.material.userData.nightLens) {
          mesh.material = mesh.material.clone();
          mesh.material.userData.nightLens = true;
        }
        materials.push(mesh.material as THREE.MeshStandardMaterial);
        owner ??= mesh;
      });
      entry = { owner, materials };
      this.entries.set(racer, entry);
    }
    for (const material of entry.materials) {
      material.emissive.set(this.glow);
      material.emissiveIntensity = on ? 4 : 0;
      material.color.set(on ? this.tint : 0xffffff);
    }
  }
}

/**
 * Night lighting. Every bike's own headlamp lens glows bright yellow and its
 * tail lamp (the model's "brakelight") glows red, and the three closest to the player also cast a real spotlight on the road; the
 * street lamps nearest the camera get real point lights. The light counts never
 * change, only where the lights stand, so the shaders compile once.
 */
export class NightLighting {
  private readonly spots: THREE.SpotLight[] = [];
  private readonly lampLights: THREE.PointLight[] = [];
  private readonly headlamps = new Lens("headlights", 0xffd21a, 0xffe14a);
  private readonly tailLamps = new Lens("brakelight", 0xff1010, 0xff3a2a);
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpLamp = new THREE.Vector3();
  private readonly byDistance: Racer[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly lamps: LampRegistry,
    racers: readonly Racer[],
  ) {
    for (let i = 0; i < REAL_HEADLIGHTS; i++) {
      const spot = new THREE.SpotLight(0xfff0d0, 60, 90, 0.5, 0.7, 1.1);
      spot.castShadow = false;
      this.scene.add(spot, spot.target);
      this.spots.push(spot);
    }
    for (let i = 0; i < REAL_LAMP_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffe2a0, 0, 45, 1.3);
      light.castShadow = false;
      this.scene.add(light);
      this.lampLights.push(light);
    }
    for (const racer of racers) this.byDistance.push(racer);
  }

  /**
   * `showOwnLamp`: the player's own lens is lit only in views that look at the bike from outside
   * (the TV trackside camera); in helmet, bumper, chase and high views it stays dark.
   */
  update(player: Racer, camera: THREE.Camera, showOwnLamp: boolean): void {
    for (const racer of this.byDistance) {
      this.headlamps.set(racer, racer !== player || showOwnLamp);
      this.tailLamps.set(racer, true);
    }
    // The player and the closest rivals get the real spotlights.
    const playerPosition = player.bike.worldPosition;
    this.byDistance.sort((a, b) => a.bike.worldPosition.distanceToSquared(playerPosition) - b.bike.worldPosition.distanceToSquared(playerPosition));
    this.byDistance.sort((a, b) => Number(b === player) - Number(a === player));
    for (let i = 0; i < this.spots.length; i++) {
      const racer = this.byDistance[i];
      const spot = this.spots[i];
      if (!racer) {
        spot.intensity = 0;
        continue;
      }
      const group = racer.bike.renderGroup;
      group.updateWorldMatrix(true, false);
      spot.position.copy(HEADLAMP).applyMatrix4(group.matrixWorld);
      this.tmpForward.set(0, -0.06, 1).transformDirection(group.matrixWorld);
      spot.target.position.copy(spot.position).addScaledVector(this.tmpForward, 20);
      spot.target.updateMatrixWorld();
      spot.intensity = 60;
    }

    // The lamps closest to the camera get the real lights.
    const lamps = this.lamps.positions;
    const cam = camera.position;
    const chosen: { index: number; distance: number }[] = [];
    for (let i = 0; i < lamps.length; i++) {
      const distance = lamps[i].distanceToSquared(cam);
      if (chosen.length < this.lampLights.length) {
        chosen.push({ index: i, distance });
        chosen.sort((a, b) => a.distance - b.distance);
      } else if (distance < chosen[chosen.length - 1].distance) {
        chosen[chosen.length - 1] = { index: i, distance };
        chosen.sort((a, b) => a.distance - b.distance);
      }
    }
    for (let i = 0; i < this.lampLights.length; i++) {
      const light = this.lampLights[i];
      const pick = chosen[i];
      if (!pick) {
        light.intensity = 0;
        continue;
      }
      light.position.copy(this.tmpLamp.copy(lamps[pick.index])).y -= 0.4;
      light.intensity = 30;
    }
  }

  dispose(): void {

    for (const light of [...this.spots, ...this.lampLights]) light.removeFromParent();
  }
}
