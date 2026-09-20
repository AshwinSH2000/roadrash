import * as THREE from "three";

/**
 * Phase 9: procedural road/terrain textures.
 *
 * Generated on a `<canvas>` rather than sourced as image files — there's no
 * texture asset in the repo (only `bike.glb`, and the rider is still a
 * placeholder; see TODO.md), and licensing/curating real photo textures is
 * its own can of worms for a solo hobby build. A tiled speckle pattern reads
 * fine at the speed and distance this game is actually seen from, in the same
 * "build it, don't source it" spirit as `EngineAudio`'s synthesized engine
 * note. Nothing here is fetched or bundled — it costs one canvas per texture,
 * once, at track-build time.
 *
 * Tiling is driven by two things working together: `TrackBuilder`'s band UVs
 * put `v = distanceAlongTrack / uvRepeatLength`, so `uvRepeatLength` alone
 * sets how many metres one tile covers *along* the road; `repeat.x` set here
 * multiplies the *across-the-road* UV (which the band geometry only ever
 * spans 0..1, however wide the band is) so the same square tile doesn't
 * stretch edge to edge.
 *
 * `TrackBuilder` is shared with every headless sim (`npm run sim:*`), which
 * run the real game logic under Node with no DOM — no `document`, no
 * `<canvas>`. Rather than split the browser and headless code paths, these
 * return `null` there and `TrackBuilder` falls back to the flat colour the
 * road/off-road used before textures existed; the sims only care about
 * physics, so a flat-coloured mesh underneath is invisible to them.
 */

function canvasAvailable(): boolean {
  return typeof document !== "undefined";
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable — can't build a procedural texture");
  return { canvas, ctx };
}

/** Scatters filled circles of varying size and colour for a grainy/speckled look. */
function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  count: number,
  colour: () => string,
  minRadius: number,
  maxRadius: number,
): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = minRadius + Math.random() * (maxRadius - minRadius);
    ctx.fillStyle = colour();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function finishTexture(canvas: HTMLCanvasElement, repeatX: number): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Dark asphalt with fine grain and the odd tar patch — tiles every ~2.5 m
 * along the road. `null` under Node (no `<canvas>`); see the file comment.
 */
export function createAsphaltTexture(roadWidthMetres: number): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);

  ctx.fillStyle = "#3c3f44";
  ctx.fillRect(0, 0, size, size);

  // Fine aggregate grain, lighter and darker than the base in roughly equal
  // measure so it reads as texture rather than a tint.
  speckle(
    ctx,
    size,
    1400,
    () => {
      const v = 46 + Math.floor(Math.random() * 26);
      const alpha = 0.15 + Math.random() * 0.25;
      return `rgba(${v},${v},${v + 2},${alpha.toFixed(2)})`;
    },
    0.4,
    1.1,
  );
  // Sparse dark patches — old repairs, tar seams.
  speckle(ctx, size, 18, () => "rgba(20,20,22,0.5)", 4, 11);

  const tileMetres = 2.5;
  return finishTexture(canvas, roadWidthMetres / tileMetres);
}

/**
 * Mottled grass/dirt with sparse bare patches — tiles every ~2 m. `null`
 * under Node (no `<canvas>`); see the file comment.
 */
export function createGrassTexture(bandWidthMetres: number): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);

  ctx.fillStyle = "#4a7c3f";
  ctx.fillRect(0, 0, size, size);

  speckle(
    ctx,
    size,
    2200,
    () => {
      const g = 90 + Math.floor(Math.random() * 60);
      const r = g - 40 - Math.floor(Math.random() * 20);
      const alpha = 0.2 + Math.random() * 0.3;
      return `rgba(${Math.max(0, r)},${g},${Math.max(0, r - 20)},${alpha.toFixed(2)})`;
    },
    0.6,
    1.6,
  );
  // Bare dirt patches worn into the grass.
  speckle(ctx, size, 40, () => "rgba(90,70,48,0.35)", 2, 6);

  const tileMetres = 2;
  return finishTexture(canvas, bandWidthMetres / tileMetres);
}

/**
 * A single soft, blobby white cloud on a transparent background, meant to be
 * used once per `THREE.Sprite` rather than tiled — see `render/Sky.ts`, which
 * scatters many differently-scaled, differently-rotated sprites from this one
 * texture rather than drawing a fresh canvas per cloud. `null` under Node (no
 * `<canvas>`); see the file comment.
 */
export function createCloudTexture(): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);

  // Several overlapping soft-edged blobs, off-centre and varied in size, read
  // as one cloud far better than a single circle would.
  const lobes = [
    { x: 0.38, y: 0.58, r: 0.30 },
    { x: 0.58, y: 0.46, r: 0.34 },
    { x: 0.70, y: 0.60, r: 0.24 },
    { x: 0.46, y: 0.64, r: 0.28 },
    { x: 0.30, y: 0.44, r: 0.20 },
    { x: 0.62, y: 0.34, r: 0.18 },
  ];
  for (const lobe of lobes) {
    const cx = lobe.x * size;
    const cy = lobe.y * size;
    const r = lobe.r * size;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(0.6, "rgba(255,255,255,0.5)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // No repeat/tiling — a sprite draws this once, so the default
  // clamp-to-edge wrapping (rather than `finishTexture`'s repeat setup) is
  // what's wanted here.
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
