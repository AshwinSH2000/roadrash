import * as THREE from "three";
import type { GraphicsSettings } from "../settings/GraphicsSettings";

export interface SceneSetup {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Sun light — its shadow frustum has to be kept centred on the action; see `focusSunOn`. */
  sunLight: THREE.DirectionalLight;
  /** Gradient sky dome — has to be re-centred on the camera each frame; see `positionSkyDome`. */
  skyDome: THREE.Mesh;
}

/** Sun offset from whatever it's focused on, controlling shadow direction. */
const SUN_OFFSET = new THREE.Vector3(60, 90, 30);

/**
 * Flat colour toward the horizon — also `scene.fog`'s colour and the
 * fallback `scene.background`, so the point where real (fogged) geometry
 * gives way to the sky dome's own gradient doesn't show a seam between two
 * different blues.
 */
const HORIZON_COLOR = new THREE.Color(0xcfe6f2);
/** Deep blue overhead, at the top of the dome. */
const ZENITH_COLOR = new THREE.Color(0x3f7fc4);

/**
 * A cheap gradient sky, replacing a single flat background colour.
 *
 * Requested directly: past the roadside scenery the flat colour was
 * indistinguishable from the sky itself ("is this sky or water or just some
 * undeveloped portion of the game"), because there was only one colour for
 * both. A big inverted sphere with a two-colour vertical gradient — the
 * classic, near-free way to fake a sky dome — gives the sky its own visual
 * identity (darker blue overhead, paling toward the horizon, the way a real
 * sky does) so it reads as sky at a glance instead of as another flat
 * surface. Cost: one extra mesh (a low-subdivision sphere, a few hundred
 * triangles) and a two-uniform shader with no texture — negligible next to
 * a race full of instanced scenery and a physics step every frame.
 *
 * Follows the camera (position only, no rotation) each frame via
 * `positionSkyDome` rather than being parented to it, so the gradient always
 * reads relative to world "up" — the dome mustn't tilt when the chase camera
 * pitches over a jump.
 */
function buildSkyDome(radius: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 16, 12);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: ZENITH_COLOR },
      bottomColor: { value: HORIZON_COLOR },
      offset: { value: 20 },
      exponent: { value: 0.6 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sky-dome";
  // Drawn first, so its (depthWrite: false) fill never has to be overdrawn
  // by the rest of the scene — the depth test alone still hides it behind
  // anything real regardless of draw order.
  mesh.renderOrder = -1000;
  return mesh;
}

/** Keeps the sky dome centred on the camera — see `buildSkyDome` for why position-only, not parented. */
export function positionSkyDome(dome: THREE.Mesh, cameraPosition: THREE.Vector3): void {
  dome.position.copy(cameraPosition);
}

/**
 * Builds the renderer, camera and lights from a quality preset. The preset
 * is applied here and only here — nothing reconfigures the renderer while
 * racing (see `GraphicsSettings`).
 */
export function createSceneSetup(container: HTMLElement, quality: GraphicsSettings): SceneSetup {
  const scene = new THREE.Scene();
  // Fallback flat colour behind the sky dome (e.g. the instant before the
  // first frame) — matches the dome's own horizon tone, and is also the fog
  // colour, so real geometry fading into fog blends into the dome's horizon
  // band rather than into a second, mismatched blue.
  scene.background = HORIZON_COLOR;
  scene.fog = new THREE.Fog(HORIZON_COLOR, quality.fogNear, quality.fogFar);

  // The far plane sits well past the fog so nothing pops at the fog's edge;
  // beyond it everything is sky-coloured anyway.
  const cameraFar = Math.max(2000, quality.fogFar * 2.5);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, cameraFar);
  camera.position.set(8, 6, 12);
  camera.lookAt(0, 1, 0);

  const skyDome = buildSkyDome(cameraFar * 0.9);
  scene.add(skyDome);

  const renderer = new THREE.WebGLRenderer({ antialias: quality.antialias });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.0);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
  sunLight.position.copy(SUN_OFFSET);
  sunLight.castShadow = quality.shadows;
  sunLight.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  // The track spans hundreds of metres, so the shadow frustum covers only a
  // local area and is moved to follow the rider each frame (`focusSunOn`)
  // rather than trying to enclose the whole course at once.
  sunLight.shadow.camera.left = -60;
  sunLight.shadow.camera.right = 60;
  sunLight.shadow.camera.top = 60;
  sunLight.shadow.camera.bottom = -60;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 260;
  sunLight.shadow.bias = -0.0006;
  scene.add(sunLight);
  scene.add(sunLight.target);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, sunLight, skyDome };
}

/** Keeps the sun's limited shadow frustum centred on a moving target. */
export function focusSunOn(sunLight: THREE.DirectionalLight, target: THREE.Vector3): void {
  sunLight.position.copy(target).add(SUN_OFFSET);
  sunLight.target.position.copy(target);
  sunLight.target.updateMatrixWorld();
}
