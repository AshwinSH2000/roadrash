/**
 * Bundles and runs one of the headless simulations. They import TypeScript
 * from `src/` with extensionless specifiers, which Node's ESM resolver can't
 * follow on its own, so esbuild does the resolving and the bundle is thrown
 * away afterwards.
 *
 *   npm run sim:race    full AI-only race, with pass/fail checks
 *   npm run sim:probe   direction/sign ground-truth probe
 *   npm run sim:brake   braking deceleration vs. brakeForce
 *   npm run check:bike  fit a downloaded bike model to the physics bike
 *   npm run check:rider inspect downloaded rider character/animation files
 */
import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] ?? "race";
const entries = {
  race: "race-sim.ts",
  probe: "direction-probe.ts",
  brake: "brake-probe.ts",
  corner: "corner-trace.ts",
  skidpad: "skidpad-probe.ts",
  falls: "fall-sim.ts",
  combat: "combat-sim.ts",
  aicombat: "ai-combat-sim.ts",
  flow: "flow-sim.ts",
  fit: "bike-fit.ts",
  rider: "rider-inspect.ts",
  spin: "spin-probe.ts",
  nitro: "nitro-probe.ts",
  oversteer: "oversteer-probe.ts",
  replay: "replay.ts",
  profile: "track-profile.ts",
  track: "check-track.ts",
  climb: "climb-probe.ts",
  hole: "hole-probe.ts",
  manual: "manual-transmission-sim.ts",
};
const entry = entries[which];
if (!entry) {
  console.error(`Unknown simulation "${which}". Options: ${Object.keys(entries).join(", ")}`);
  process.exit(2);
}

// Deliberately inside node_modules rather than the OS temp dir: the bundle
// keeps `three` and the Rapier WASM package external, and Node resolves those
// by walking up from the bundle's own location. From /tmp there is nothing to
// find.
const outDir = resolve(here, "..", "node_modules", ".roadrash-sim");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, "sim.mjs");
try {
  await build({
    entryPoints: [resolve(here, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    external: ["three", "@dimforge/rapier3d-compat"],
    logLevel: "warning",
  });
  await import(pathToFileURL(outfile).href);
} finally {
  process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
}
