import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * Where each optional model lives under `public/`, with the candidate files
 * tried in order. Every one of these is allowed to be absent: the game falls
 * back to the procedural placeholder it has always drawn, so a fresh clone
 * with an empty `public/assets` still runs. That is the point of this whole
 * module — you can drop in a candidate model, look at it, and delete it again,
 * without the game ever failing to start.
 *
 * The rider is split into a character and one file per animation because
 * that is how Mixamo hands them out: the character once "with skin", each
 * clip "without skin" on the same skeleton. FBX is accepted directly so there
 * is no conversion step between the download and the game.
 */
export const ASSET_PATHS = {
  bike: ["assets/bike.glb"],
  rider: ["assets/rider/rider.fbx", "assets/rider/rider.glb"],
  riderRide: ["assets/rider/ride.fbx", "assets/rider/ride.glb"],
  riderIdle: ["assets/rider/idle.fbx", "assets/rider/idle.glb"],
  riderGetUp: ["assets/rider/getup.fbx", "assets/rider/getup.glb"],
  riderRun: ["assets/rider/run.fbx", "assets/rider/run.glb"],
  riderPunch: ["assets/rider/punch.fbx", "assets/rider/punch.glb"],
  riderKick: ["assets/rider/kick.fbx", "assets/rider/kick.glb"],
} as const;

export type AssetKey = keyof typeof ASSET_PATHS;

export interface LoadedAsset {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export class LoadedAssets {
  constructor(
    private readonly loaded: Map<AssetKey, LoadedAsset>,
    /** Assets that simply weren't there — normal, not an error. */
    readonly absent: AssetKey[],
    /** Assets that were there but failed to load, with why. */
    readonly failed: Map<AssetKey, string>,
  ) {}

  get(key: AssetKey): LoadedAsset | null {
    return this.loaded.get(key) ?? null;
  }

  has(key: AssetKey): boolean {
    return this.loaded.has(key);
  }
}

interface Loaders {
  gltf: GLTFLoader;
  fbx: FBXLoader;
}

function createLoaders(): Loaders {
  const loader = new GLTFLoader();

  // Sketchfab and most other model sites hand out Draco-compressed glTF by
  // default, so a loader without this rejects the majority of real downloads
  // with an unhelpful parse error. The decoder is served from `public/draco/`
  // rather than a CDN, because the design requires that nothing is fetched
  // from the network at runtime.
  const draco = new DRACOLoader();
  draco.setDecoderPath("draco/");
  loader.setDRACOLoader(draco);

  // Meshopt is the other common compression; its decoder is a plain module, so
  // it costs an import and no extra files.
  loader.setMeshoptDecoder(MeshoptDecoder);

  return { gltf: loader, fbx: new FBXLoader() };
}

/**
 * Fetches the file ourselves and hands the bytes to `parseAsync`, rather than
 * using `loader.loadAsync(url)`.
 *
 * The reason is Vite's dev server, and this is measured rather than assumed:
 * `curl` on a missing `public/assets/bike.glb` returns **200 with
 * `content-type: text/html`** — the app's own `index.html` — not a 404. Handed
 * to GLTFLoader that becomes a parse failure somewhere in the middle of the
 * HTML, which reads exactly like a corrupt model.
 *
 * So absence is detected two ways: a real 404 (what a static host will send),
 * and an HTML content-type (what the dev server sends). Both mean "not
 * present", which is a completely different situation from "present but
 * broken" and needs a completely different response from you.
 *
 * Consequence worth knowing: `parseAsync` resolves external references
 * relative to an empty path, so **use `.glb`**, which embeds its buffers and
 * textures. A `.gltf` with sidecar `.bin`/texture files will not resolve.
 */
async function loadOne(
  loaders: Loaders,
  url: string,
): Promise<{ asset: LoadedAsset | null; absent: boolean; error?: string }> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return { asset: null, absent: false, error: `network error: ${String(error)}` };
  }

  if (response.status === 404) return { asset: null, absent: true };
  if (!response.ok) {
    return { asset: null, absent: false, error: `HTTP ${response.status}` };
  }

  // The dev-server case described above: HTML where a model was asked for
  // means the file isn't there, whatever the status code claims.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return { asset: null, absent: true };
  }

  const buffer = await response.arrayBuffer();
  try {
    if (url.toLowerCase().endsWith(".fbx")) {
      // FBXLoader is synchronous once it has the bytes. Embedded textures are
      // decoded to blob URLs internally, so a Mixamo "with skin" download is
      // self-contained just like a .glb.
      const group = loaders.fbx.parse(buffer, "");
      return { asset: { scene: group, animations: group.animations }, absent: false };
    }
    const gltf = await loaders.gltf.parseAsync(buffer, "");
    return {
      asset: { scene: gltf.scene, animations: gltf.animations },
      absent: false,
    };
  } catch (error) {
    return { asset: null, absent: false, error: String(error) };
  }
}

/** Tries each candidate path in turn; the first that exists wins, present-but-broken stops the search. */
async function loadFirst(
  loaders: Loaders,
  urls: readonly string[],
): Promise<{ asset: LoadedAsset | null; absent: boolean; error?: string; url?: string }> {
  for (const url of urls) {
    const result = await loadOne(loaders, url);
    if (!result.absent) return { ...result, url };
  }
  return { asset: null, absent: true };
}

/**
 * Loads every optional asset, in parallel, tolerating absence.
 *
 * Never rejects. A model that is missing or broken degrades that one thing to
 * its placeholder and leaves the rest of the game alone, because the
 * alternative — a failed asset taking down the whole race — would make trying
 * out a candidate model far more expensive than looking at it is worth.
 */
export async function loadAssets(): Promise<LoadedAssets> {
  const loaders = createLoaders();
  const keys = Object.keys(ASSET_PATHS) as AssetKey[];

  const results = await Promise.all(
    keys.map(async (key) => ({ key, ...(await loadFirst(loaders, ASSET_PATHS[key])) })),
  );

  const loaded = new Map<AssetKey, LoadedAsset>();
  const absent: AssetKey[] = [];
  const failed = new Map<AssetKey, string>();

  for (const result of results) {
    if (result.asset) loaded.set(result.key, result.asset);
    else if (result.absent) absent.push(result.key);
    else failed.set(result.key, result.error ?? "unknown error");
  }

  if (absent.length > 0) {
    console.info(
      `[assets] using placeholders for: ${absent.join(", ")} ` +
        `(see public/assets/README.md for where each file goes)`,
    );
  }
  for (const [key, error] of failed) {
    console.error(`[assets] ${ASSET_PATHS[key][0]} is present but failed to load — ${error}`);
  }

  return new LoadedAssets(loaded, absent, failed);
}
