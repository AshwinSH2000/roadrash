import { Game } from "./core/Game";
import { showFatalError } from "./core/ErrorOverlay";
import { showStartScreen } from "./ui/StartScreen";
import { TRACKS } from "./track/tracks";
import { isQualityLevel } from "./settings/GraphicsSettings";
import { isTransmissionMode } from "./physics/Transmission";
import { isDayMode, isSeason } from "./render/Environment";

const container = document.getElementById("app");
if (!container) {
  throw new Error("Missing #app container element in index.html");
}

// The start screen comes first because its quality choice decides how the
// renderer is built. `?track=Name`, `?quality=low|medium|high` and
// `?transmission=automatic|manual` preselect; `?autostart=1` skips the
// screen (dev: headless screenshots).
// Safari ignores `user-scalable=no` for pinch zoom and still shows the long-press menu on text
// and images; these two events are how a page switches both off.
document.addEventListener("gesturestart", (event) => event.preventDefault());
// iPhone Safari still zooms on a double tap whatever the viewport and `touch-action` say. A touch that
// ends within 350 ms of the last one is cancelled, which also stops the zoom. The game's own controls
// listen for pointer events, which this does not touch; only a second `click` in quick succession is lost.
let lastTouchEnd = 0;
document.addEventListener(
  "touchend",
  (event) => {
    const now = Date.now();
    if (now - lastTouchEnd < 350 && event.cancelable) event.preventDefault();
    lastTouchEnd = now;
  },
  { passive: false },
);
document.addEventListener("contextmenu", (event) => {
  if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) event.preventDefault();
});

const query = new URLSearchParams(window.location.search);
const quality = query.get("quality");
const transmission = query.get("transmission");
const season = query.get("season");
const dayMode = query.get("time");

showStartScreen({
  trackNames: TRACKS.map((t) => t.name),
  initialTrack: query.get("track"),
  initialQuality: isQualityLevel(quality) ? quality : undefined,
  initialTransmission: isTransmissionMode(transmission) ? transmission : undefined,
  initialSeason: isSeason(season) ? season : undefined,
  initialDayMode: isDayMode(dayMode) ? dayMode : undefined,
  autostart: query.get("autostart") === "1",
})
  .then((choice) => Game.bootstrap(container, choice))
  .catch((error) => {
    showFatalError("Failed to start the game", error);
  });
