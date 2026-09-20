import * as THREE from "three";
import type { GraphicsSettings } from "../settings/GraphicsSettings";

export interface SceneSetup {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Sun light — its shadow frustum has to be kept centred on the action; see `focusSunOn`. */
  sunLight: THREE.DirectionalLight;
}

/** Sun offset from whatever it's focused on, controlling shadow direction. */
const SUN_OFFSET = new THREE.Vector3(60, 90, 30);

/**
 * Builds the renderer, camera and lights from a quality preset. The preset
 * is applied here and only here — nothing reconfigures the renderer while
 * racing (see `GraphicsSettings`).
 */
export function createSceneSetup(container: HTMLElement, quality: GraphicsSettings): SceneSetup {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, quality.fogNear, quality.fogFar);

  // The far plane sits well past the fog so nothing pops at the fog's edge;
  // beyond it everything is sky-coloured anyway.
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    Math.max(2000, quality.fogFar * 2.5),
  );
  camera.position.set(8, 6, 12);
  camera.lookAt(0, 1, 0);

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

  return { scene, camera, renderer, sunLight };
}

/** Keeps the sun's limited shadow frustum centred on a moving target. */
export function focusSunOn(sunLight: THREE.DirectionalLight, target: THREE.Vector3): void {
  sunLight.position.copy(target).add(SUN_OFFSET);
  sunLight.target.position.copy(target);
  sunLight.target.updateMatrixWorld();
}
