import { TrackDefinition } from "../src/track/TrackDefinition";
import { TRACKS } from "../src/track/tracks";
import { validateTrack } from "../src/track/TrackValidator";
import { TrackRecipe } from "../src/track/TrackLayout";

/**
 * Validates every course in `tracks.ts` against the rules in
 * `TrackValidator.ts`, and sanity-checks the recipe builder's geometry.
 *
 * Run with: npm run check:track
 */
function checkRecipeGeometry(): void {
  // A 90-degree left turn of radius 100 from the origin, facing +Z, must end
  // at (100, 100) facing +X — a quarter circle about (100, 0).
  const r = new TrackRecipe().arc(100, 90);
  const end = r.position;
  const ok = Math.abs(end.x - 100) < 0.5 && Math.abs(end.z - 100) < 0.5 && Math.abs(end.headingDeg - 90) < 0.01;
  console.log(`recipe geometry   quarter-circle left ends at (${end.x.toFixed(1)}, ${end.z.toFixed(1)}) heading ${end.headingDeg.toFixed(0)} deg  ${ok ? "ok" : "WRONG"}`);
  if (!ok) process.exit(1);
}

checkRecipeGeometry();
let failed = 0;
for (const layout of TRACKS) {
  const track = new TrackDefinition(layout);
  const report = validateTrack(track);
  console.log(`\n=== ${report.name} — ${layout.description}`);
  console.log(`control points ${report.controlPoints}, length ${report.length.toFixed(0)} m, race ${track.raceLength.toFixed(0)} m`);
  console.log(
    `closest self-approach ${report.closestApproach.distance.toFixed(0)} m (need ${report.requiredClearance.toFixed(0)}); ` +
      `steepest grade ${(report.steepest.grade * 100).toFixed(1)}% at ${report.steepest.distance.toFixed(0)} m (max ${report.maxGrade * 100}%)`,
  );
  if (report.requiresCornering) {
    console.log(`corners ${report.corners.length}, braking zones ${report.brakingZones} (min ${report.minBrakingZones}), tightest ${report.tightest ? report.tightest.radius.toFixed(0) + " m" : "-"} (min ${report.minCornerRadius.toFixed(0)})`);
    console.log(
      "  " +
        report.corners
          .map((c) => `${c.distance.toFixed(0)}m:${c.radius.toFixed(0)}r${c.braking ? "*" : ""}`)
          .join("  "),
    );
  } else {
    console.log("no cornering required — a straight by design (drag strip)");
  }
  if (report.problems.length) {
    failed++;
    for (const p of report.problems) console.log(`  PROBLEM  ${p}`);
  }
}
console.log(failed ? `\nFAIL  ${failed} of ${TRACKS.length} tracks fail validation.` : `\nPASS  all ${TRACKS.length} tracks valid.  (* = needs real braking)`);
process.exit(failed ? 1 : 0);
