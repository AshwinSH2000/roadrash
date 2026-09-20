import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/**
 * Phase 9 post-processing: on for the "high" preset only (`quality.postProcessing`
 * — see `GraphicsSettings`), off otherwise so "low"/"medium" never pay for it.
 *
 * Bloom and SSAO, not the plan's third item, motion blur: a real per-object
 * motion blur pass needs a velocity buffer and is a good deal of machinery
 * for a fixed-timestep game whose interpolated render transform already
 * hides stutter (see `Bike.syncRender`); it's dropped rather than built badly.
 * SSAO in particular is the expensive one of the two — restricting both to
 * "high", the preset described as "for a real GPU", is what makes that an
 * acceptable trade rather than a universal tax.
 *
 * Owns its own render targets sized to the canvas, so it has to hear about
 * resizes — `resize()` mirrors what `SceneSetup`'s own resize listener does
 * for the plain renderer.
 */
export interface PostProcessing {
  /** Renders the scene through the pipeline instead of a bare `renderer.render`. */
  render(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Building it costs nothing when `quality.postProcessing` is off — callers
 * just skip calling this; it takes no quality settings of its own since it's
 * only ever built for the one preset that turns it on at all.
 */
export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostProcessing {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);

  composer.addPass(new RenderPass(scene, camera));

  const ssao = new SSAOPass(scene, camera, size.x, size.y);
  ssao.kernelRadius = 8;
  ssao.minDistance = 0.002;
  ssao.maxDistance = 0.08;
  composer.addPass(ssao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.6, 0.85);
  composer.addPass(bloom);

  // Rapier/Three's tone mapping and colour space conversion happen in the
  // main render loop normally; with a composer in the chain, this pass is
  // what applies them at the end instead — without it, SSAO/bloom's output
  // bypasses both and everything looks faded and wrong.
  composer.addPass(new OutputPass());

  return {
    render(): void {
      composer.render();
    },
    resize(width: number, height: number): void {
      composer.setSize(width, height);
      ssao.setSize(width, height);
    },
    dispose(): void {
      composer.dispose();
    },
  };
}
