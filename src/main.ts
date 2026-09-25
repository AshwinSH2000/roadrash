import { Game } from "./core/Game";
import { showFatalError } from "./core/ErrorOverlay";
import { showStartScreen } from "./ui/StartScreen";
import { TRACKS } from "./track/tracks";
import { isQualityLevel } from "./settings/GraphicsSettings";
import { isTransmissionMode } from "./physics/Transmission";

const container = document.getElementById("app");
if (!container) {
  throw new Error("Missing #app container element in index.html");
}

// The start screen comes first because its quality choice decides how the
// renderer is built. `?track=Name`, `?quality=low|medium|high` and
// `?transmission=automatic|manual` preselect; `?autostart=1` skips the
// screen (dev: headless screenshots).
const query = new URLSearchParams(window.location.search);
const quality = query.get("quality");
const transmission = query.get("transmission");

showStartScreen({
  trackNames: TRACKS.map((t) => t.name),
  initialTrack: query.get("track"),
  initialQuality: isQualityLevel(quality) ? quality : undefined,
  initialTransmission: isTransmissionMode(transmission) ? transmission : undefined,
  autostart: query.get("autostart") === "1",
})
  .then((choice) => Game.bootstrap(container, choice))
  .catch((error) => {
    showFatalError("Failed to start the game", error);
  });
