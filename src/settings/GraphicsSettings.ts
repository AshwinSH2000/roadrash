/**
 * The three quality presets, chosen once on the start screen.
 *
 * Applied at scene build time — the renderer, the sun's shadow map and the
 * fog are created from a preset and never reconfigured while racing, which
 * is the v1 decision ("no live runtime reconfiguration"). Changing quality
 * therefore means going back to the start screen, which reloads the page.
 *
 * `postProcessing` (`render/PostProcessing.ts`) and `sceneryDensity`
 * (`track/Scenery.ts`) are Phase 9's: the former is only ever true for
 * "high" — SSAO especially is the expensive one of its two passes, and
 * restricting both to the preset described as "for a real GPU" is what
 * makes that cost acceptable rather than a tax on everyone. The latter
 * scales smoothly across all three presets instead.
 */

export type QualityLevel = "low" | "medium" | "high";

export interface GraphicsSettings {
  level: QualityLevel;
  label: string;
  /** One line for the picker, so the choice is informed rather than a guess. */
  description: string;
  /** Ceiling on the device pixel ratio the renderer draws at. */
  maxPixelRatio: number;
  /** Whether anything casts a shadow at all. Off is the single biggest saving. */
  shadows: boolean;
  /** Edge size of the sun's shadow map when shadows are on. */
  shadowMapSize: number;
  /** Soft (PCF-filtered) shadow edges, or hard and cheap. */
  softShadows: boolean;
  /** Fog start and end, in metres; also the camera's far plane sits past `fogFar`. */
  fogNear: number;
  fogFar: number;
  /** Multisample anti-aliasing on the main framebuffer. */
  antialias: boolean;
  /** Bloom + SSAO composer, "high" only — see the file comment. */
  postProcessing: boolean;
  /** Fraction of roadside scenery instances to place, 0..1. */
  sceneryDensity: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, GraphicsSettings>> = {
  low: {
    level: "low",
    label: "Low",
    description: "no shadows, sparse scenery, short draw distance, 1× pixels — for laptops and integrated graphics",
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 512,
    softShadows: false,
    fogNear: 70,
    fogFar: 320,
    antialias: false,
    postProcessing: false,
    sceneryDensity: 0.3,
  },
  medium: {
    level: "medium",
    label: "Medium",
    description: "hard shadows, moderate scenery, medium draw distance, 1.5× pixels — the sensible default",
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    softShadows: false,
    fogNear: 120,
    fogFar: 600,
    antialias: true,
    postProcessing: false,
    sceneryDensity: 0.6,
  },
  high: {
    level: "high",
    label: "High",
    description: "soft shadows, full scenery, bloom + ambient occlusion, long draw distance, 2× pixels — for a real GPU",
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    softShadows: true,
    fogNear: 150,
    fogFar: 900,
    antialias: true,
    postProcessing: true,
    sceneryDensity: 1,
  },
};

export const DEFAULT_QUALITY: QualityLevel = "medium";

export function isQualityLevel(value: string | null | undefined): value is QualityLevel {
  return value === "low" || value === "medium" || value === "high";
}
