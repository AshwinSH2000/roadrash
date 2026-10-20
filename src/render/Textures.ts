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
 * Pale rippled sand — fine grain with faint wind ripples across the road.
 * Tiles every ~2.5 m like the asphalt. `null` under Node.
 */
export function createSandTexture(widthMetres: number): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);

  ctx.fillStyle = "#d8bf86";
  ctx.fillRect(0, 0, size, size);

  // Wind ripples: long, low-contrast bands.
  for (let i = 0; i < 14; i++) {
    const y = (i / 14) * size + Math.random() * 6;
    ctx.fillStyle = `rgba(150,115,60,${(0.08 + Math.random() * 0.1).toFixed(2)})`;
    ctx.fillRect(0, y, size, 3 + Math.random() * 4);
  }
  speckle(
    ctx,
    size,
    2600,
    () => {
      const v = 170 + Math.floor(Math.random() * 60);
      return `rgba(${v},${v - 28},${v - 80},${(0.2 + Math.random() * 0.3).toFixed(2)})`;
    },
    0.4,
    1.2,
  );
  return finishTexture(canvas, widthMetres / 2.5);
}

/**
 * Murky green-blue water with pale ripple streaks. Meant to be scrolled along
 * its V axis by `TrackBuilder` so the river visibly flows. `null` under Node.
 */
export function createWaterTexture(): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);

  ctx.fillStyle = "#2f6f86";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 14 + Math.random() * 38;
    ctx.strokeStyle = `rgba(210,240,250,${(0.1 + Math.random() * 0.25).toFixed(2)})`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (Math.random() - 0.5) * 4);
    ctx.stroke();
  }
  speckle(ctx, size, 500, () => "rgba(20,70,90,0.25)", 1, 4);
  return finishTexture(canvas, 1);
}

/**
 * Rocky/earth cliff face — horizontal strata bands plus grain, tiling
 * vertically down the boundary skirt (`TrackBuilder`'s `buildCliffSkirt`).
 * `null` under Node (no `<canvas>`); see the file comment.
 */
export function createCliffTexture(): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);

  ctx.fillStyle = "#7a6a58";
  ctx.fillRect(0, 0, size, size);

  // Horizontal strata — a handful of bands, darker or lighter than the base,
  // is enough to read as layered rock rather than a flat tint.
  const bandCount = 6 + Math.floor(Math.random() * 3);
  for (let i = 0; i < bandCount; i++) {
    const y = (i / bandCount) * size;
    const h = size / bandCount;
    const v = 60 + Math.floor(Math.random() * 50);
    ctx.fillStyle = `rgba(${v},${v - 14},${v - 26},${(0.25 + Math.random() * 0.35).toFixed(2)})`;
    ctx.fillRect(0, y, size, h * (0.5 + Math.random() * 0.5));
  }

  // Grain on top of the strata, same technique as the road/grass textures.
  speckle(
    ctx,
    size,
    1600,
    () => {
      const v = 70 + Math.floor(Math.random() * 50);
      const alpha = 0.15 + Math.random() * 0.25;
      return `rgba(${v},${v - 10},${v - 20},${alpha.toFixed(2)})`;
    },
    0.4,
    1.3,
  );

  // Both axes of tiling are baked directly into the skirt's own per-vertex
  // UVs (`TrackBuilder.buildCliffSkirt`) rather than `texture.repeat` — the
  // skirt's height varies every sample (it follows the terrain), which a
  // single fixed repeat factor can't express the way it can for the road's
  // constant width. So this stays at the identity repeat.
  return finishTexture(canvas, 1);
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

/**
 * Packed brown earth with stones and the odd tuft — the dirt shoulder between
 * the asphalt and the grass. Tiles every ~2 m. `null` under Node.
 */
export function createDirtTexture(widthMetres: number): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#7a5a3c";
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, 2600, () => {
    const v = 70 + Math.floor(Math.random() * 70);
    return `rgba(${v + 25},${v},${Math.max(0, v - 28)},${(0.25 + Math.random() * 0.35).toFixed(2)})`;
  }, 0.6, 1.8);
  // Pebbles and darker ruts.
  speckle(ctx, size, 90, () => `rgba(${150 + Math.floor(Math.random() * 40)},${130 + Math.floor(Math.random() * 30)},${105 + Math.floor(Math.random() * 25)},0.55)`, 1, 2.6);
  speckle(ctx, size, 30, () => "rgba(40,28,18,0.35)", 3, 9);
  return finishTexture(canvas, Math.max(1, widthMetres / 2));
}

/** Grey concrete paving slabs with joints — the city pavement. Tiles every 2 m. `null` under Node. */
export function createPavementTexture(widthMetres: number): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#9a9a96";
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, 1800, () => `rgba(${100 + Math.floor(Math.random() * 60)},${100 + Math.floor(Math.random() * 60)},${96 + Math.floor(Math.random() * 60)},0.35)`, 0.5, 1.4);
  ctx.strokeStyle = "rgba(60,60,58,0.7)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (i * size) / 2);
    ctx.lineTo(size, (i * size) / 2);
    ctx.moveTo((i * size) / 2, 0);
    ctx.lineTo((i * size) / 2, size);
    ctx.stroke();
  }
  return finishTexture(canvas, Math.max(1, widthMetres / 2));
}

export type FacadeStyle = "classic" | "brick" | "glass";

/**
 * A building front: one 4 m x 4 m tile that repeats up and along a facade, its
 * floor line at the bottom of the tile and two windows in it. Three styles: a
 * pale rendered wall with dark windows (tinted per building), a brick wall with
 * stone sills, and a glass curtain wall for the towers. `null` under Node.
 */
export function createFacadeTexture(style: FacadeStyle = "classic"): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);

  if (style === "glass") {
    // Four panes by four floors' worth of grid: blue-grey glass with a reflected sky gradient and thin mullions.
    ctx.fillStyle = "#30465c";
    ctx.fillRect(0, 0, size, size);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        const x = (col * size) / 4;
        const y = (row * size) / 2;
        const glass = ctx.createLinearGradient(0, y, 0, y + size / 2);
        const lit = Math.random() < 0.18;
        glass.addColorStop(0, lit ? "#e8d9a0" : "#8aa6bf");
        glass.addColorStop(1, lit ? "#c8aa62" : "#3b5670");
        ctx.fillStyle = glass;
        ctx.fillRect(x + 3, y + 3, size / 4 - 6, size / 2 - 6);
      }
    }
    ctx.fillStyle = "rgba(210,216,222,0.9)";
    ctx.fillRect(0, size - 8, size, 8);
  } else {
    const brick = style === "brick";
    ctx.fillStyle = brick ? "#a8604a" : "#e6e1d8";
    ctx.fillRect(0, 0, size, size);
    if (brick) {
      // Courses of brick, every other row offset, with dark mortar.
      ctx.strokeStyle = "rgba(60,36,28,0.55)";
      ctx.lineWidth = 1.5;
      for (let y = 0; y < size; y += 8) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size, y);
        ctx.stroke();
        for (let x = (y / 8) % 2 ? 0 : 16; x < size; x += 32) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + 8);
          ctx.stroke();
        }
      }
    }
    speckle(ctx, size, 1500, () => `rgba(${150 + Math.floor(Math.random() * 60)},${130 + Math.floor(Math.random() * 60)},${120 + Math.floor(Math.random() * 60)},0.22)`, 0.6, 1.6);
    // Floor line at the bottom of the tile.
    ctx.fillStyle = brick ? "rgba(70,44,36,0.8)" : "rgba(90,84,76,0.65)";
    ctx.fillRect(0, size - 10, size, 10);
    for (const cx of [size * 0.27, size * 0.73]) {
      const w = size * 0.28;
      const h = size * 0.5;
      const x = cx - w / 2;
      const y = size * 0.2;
      ctx.fillStyle = brick ? "rgba(214,204,188,1)" : "rgba(60,56,52,0.9)";
      ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
      const lit = Math.random() < 0.3;
      const glass = ctx.createLinearGradient(0, y, 0, y + h);
      glass.addColorStop(0, lit ? "#f2d98a" : "#6f8aa3");
      glass.addColorStop(1, lit ? "#d9b45c" : "#2d3f52");
      ctx.fillStyle = glass;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "rgba(60,56,52,0.9)";
      ctx.fillRect(x + w / 2 - 2, y, 4, h);
      ctx.fillRect(x, y + h * 0.35 - 2, w, 4);
      ctx.fillStyle = "rgba(200,194,184,1)";
      ctx.fillRect(x - 9, y + h + 5, w + 18, 7);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** A ground-floor shopfront, one 4 m x 3.6 m tile: dark glass windows, a door and a sign band on top. `null` under Node. */
export function createShopfrontTexture(): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#cfc9bd";
  ctx.fillRect(0, 0, size, size);
  // Sign band.
  ctx.fillStyle = "#f0ece0";
  ctx.fillRect(0, 0, size, size * 0.2);
  ctx.fillStyle = "rgba(40,40,44,0.8)";
  ctx.fillRect(size * 0.12, size * 0.06, size * 0.5, size * 0.08);
  // Shop windows and a door.
  const panes: [number, number][] = [[0.04, 0.5], [0.58, 0.38]];
  for (const [x, w] of panes) {
    const glass = ctx.createLinearGradient(0, size * 0.28, 0, size);
    glass.addColorStop(0, "#9bb3c6");
    glass.addColorStop(1, "#33475a");
    ctx.fillStyle = "rgba(50,48,46,1)";
    ctx.fillRect(size * x - 4, size * 0.26, size * w + 8, size * 0.72);
    ctx.fillStyle = glass;
    ctx.fillRect(size * x, size * 0.3, size * w, size * 0.66);
  }
  ctx.fillStyle = "rgba(50,48,46,1)";
  ctx.fillRect(size * 0.58 + size * 0.38 * 0.5 - 2, size * 0.3, 4, size * 0.66);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Vertical stripes, cream and a strong colour (tinted per awning): an awning's fabric. `null` under Node. */
export function createAwningTexture(): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#f4efe2";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  for (let x = 0; x < size; x += 16) ctx.fillRect(x, 0, 8, size);
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let x = 8; x < size; x += 16) ctx.fillRect(x, 0, 8, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export type SignKind = "arrow-left" | "arrow-right" | "diamond-left" | "diamond-right" | "limit" | "ahead" | "no-entry";

/**
 * A roadside curve sign: a white board with a bold bend arrow, or a yellow
 * diamond with the same, pointing the way the road turns. `null` under Node.
 */
export function createSignTexture(kind: SignKind): THREE.CanvasTexture | null {
  if (!canvasAvailable()) return null;
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const left = kind.endsWith("left");
  const diamond = kind.startsWith("diamond");
  ctx.clearRect(0, 0, size, size);

  if (kind === "limit" || kind === "no-entry") {
    // A round sign: white disc and red ring with a speed, or a red disc with a white bar.
    const cx = size / 2;
    ctx.beginPath();
    ctx.arc(cx, cx, size / 2 - 4, 0, Math.PI * 2);
    ctx.fillStyle = kind === "limit" ? "#f6f4ec" : "#c8201c";
    ctx.fill();
    if (kind === "limit") {
      ctx.lineWidth = 12;
      ctx.strokeStyle = "#c8201c";
      ctx.beginPath();
      ctx.arc(cx, cx, size / 2 - 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#111";
      ctx.font = "bold 52px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("50", cx, cx + 3);
    } else {
      ctx.fillStyle = "#f6f4ec";
      ctx.fillRect(size * 0.2, size * 0.43, size * 0.6, size * 0.14);
    }
    const round = new THREE.CanvasTexture(canvas);
    round.colorSpace = THREE.SRGBColorSpace;
    round.anisotropy = 4;
    return round;
  }
  if (kind === "ahead") {
    // A blue square with a white arrow straight on.
    ctx.fillStyle = "#1b5aa6";
    ctx.fillRect(4, 4, size - 8, size - 8);
    ctx.strokeStyle = "#f6f4ec";
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, size - 16, size - 16);
    ctx.fillStyle = "#f6f4ec";
    ctx.beginPath();
    ctx.moveTo(size / 2, size * 0.2);
    ctx.lineTo(size * 0.74, size * 0.5);
    ctx.lineTo(size * 0.57, size * 0.5);
    ctx.lineTo(size * 0.57, size * 0.8);
    ctx.lineTo(size * 0.43, size * 0.8);
    ctx.lineTo(size * 0.43, size * 0.5);
    ctx.lineTo(size * 0.26, size * 0.5);
    ctx.closePath();
    ctx.fill();
    const square = new THREE.CanvasTexture(canvas);
    square.colorSpace = THREE.SRGBColorSpace;
    square.anisotropy = 4;
    return square;
  }

  if (diamond) {
    ctx.fillStyle = "#f2b61c";
    ctx.beginPath();
    ctx.moveTo(size / 2, 4);
    ctx.lineTo(size - 4, size / 2);
    ctx.lineTo(size / 2, size - 4);
    ctx.lineTo(4, size / 2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 4;
    ctx.stroke();
  } else {
    ctx.fillStyle = "#f4f2e8";
    ctx.fillRect(4, 4, size - 8, size - 8);
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 4, size - 8, size - 8);
  }

  // A bend arrow: up the board, curving over to the side the road turns, ending in an arrowhead.
  const dir = left ? -1 : 1;
  ctx.strokeStyle = "#111";
  ctx.fillStyle = "#111";
  ctx.lineWidth = 11;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(size / 2 - dir * 10, size * (diamond ? 0.72 : 0.8));
  ctx.lineTo(size / 2 - dir * 10, size * 0.5);
  ctx.quadraticCurveTo(size / 2 - dir * 10, size * 0.3, size / 2 + dir * 18, size * 0.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(size / 2 + dir * 38, size * 0.3);
  ctx.lineTo(size / 2 + dir * 12, size * 0.3 - 17);
  ctx.lineTo(size / 2 + dir * 12, size * 0.3 + 17);
  ctx.closePath();
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
