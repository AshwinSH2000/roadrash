import {
  DEFAULT_QUALITY,
  QUALITY_PRESETS,
  type QualityLevel,
} from "../settings/GraphicsSettings";
import type { TransmissionMode } from "../physics/Transmission";
import { DISPLAY, MONO, button, el, overlay } from "./dom";

/**
 * The start screen: pick a quality preset (and, optionally, a course), then
 * start. Shown before anything is built, because the preset decides how the
 * renderer is created — which is also why "Change settings" on the end
 * screen reloads the page rather than reconfiguring a live renderer.
 *
 * Resolves once, with the player's choice. The click that starts the race
 * is also the user gesture the browser needs before it will let the engine
 * audio play, so the "press a key" nag on the old HUD is gone with this.
 */

export interface StartChoice {
  quality: QualityLevel;
  /** A course name, or null for a random one. */
  track: string | null;
  transmission: TransmissionMode;
}

export interface StartScreenOptions {
  trackNames: readonly string[];
  initialTrack: string | null;
  initialQuality?: QualityLevel;
  initialTransmission?: TransmissionMode;
  /** Skip the screen and start with the initial choices — for headless screenshots and sims. */
  autostart?: boolean;
}

const TRANSMISSION_LABELS: Record<TransmissionMode, string> = {
  automatic: "Automatic",
  manual: "Manual",
};
const TRANSMISSION_DESCRIPTIONS: Record<TransmissionMode, string> = {
  automatic: "the box shifts itself — just ride",
  manual: "6 gears, Q/E to shift — redline caps each gear until you upshift",
};

const CONTROLS: readonly [string, string][] = [
  ["W / ↑", "throttle"],
  ["S / ↓", "brake"],
  ["A / D", "steer"],
  ["P", "punch"],
  ["K", "kick"],
  ["N", "nitro"],
  ["Q / E", "shift down/up (manual)"],
  ["T", "manual ⇄ automatic"],
  ["space", "pause"],
  ["tilt", "steer (touch devices)"],
];

export function showStartScreen(options: StartScreenOptions): Promise<StartChoice> {
  if (options.autostart) {
    return Promise.resolve({
      quality: options.initialQuality ?? DEFAULT_QUALITY,
      track: options.initialTrack,
      transmission: options.initialTransmission ?? "automatic",
    });
  }
  return new Promise((resolve) => {
    const root = overlay(40, 0.72);
    root.style.display = "flex";
    root.style.gap = "18px";
    // Small windows: let the screen scroll rather than clip the title or the button.
    root.style.overflow = "auto";
    root.style.padding = "24px 0";
    root.style.boxSizing = "border-box";

    const title = el(
      "div",
      `font:900 56px/1 ${DISPLAY};letter-spacing:0.18em;text-transform:uppercase;text-shadow:0 4px 24px rgba(0,0,0,0.8);flex-shrink:0`,
      "Road Rash",
    );
    const subtitle = el(
      "div",
      `font:400 14px/1 ${MONO};letter-spacing:0.3em;opacity:0.7;margin-top:-8px`,
      "BROWSER EDITION",
    );

    // --- quality ---------------------------------------------------------
    let quality: QualityLevel = options.initialQuality ?? DEFAULT_QUALITY;
    const qualityBlock = el("div", "display:flex;flex-direction:column;gap:10px;align-items:center");
    qualityBlock.appendChild(
      el("div", `font:600 13px/1 ${MONO};letter-spacing:0.2em;opacity:0.75`, "GRAPHICS QUALITY"),
    );
    const cards = el("div", "display:flex;gap:12px");
    const cardEls = new Map<QualityLevel, HTMLDivElement>();
    const describe = el("div", `font:400 13px/1.4 ${MONO};opacity:0.7;min-height:1.4em;text-align:center`);

    const selectQuality = (level: QualityLevel): void => {
      quality = level;
      for (const [l, card] of cardEls) {
        const on = l === level;
        card.style.borderColor = on ? "#ff9f1c" : "rgba(255,255,255,0.35)";
        card.style.background = on ? "rgba(255,159,28,0.18)" : "rgba(255,255,255,0.06)";
      }
      describe.textContent = QUALITY_PRESETS[level].description;
    };

    for (const level of ["low", "medium", "high"] as const) {
      const card = el(
        "div",
        [
          "cursor:pointer",
          "width:120px",
          "padding:13px 0",
          "text-align:center",
          "border:2px solid rgba(255,255,255,0.35)",
          "border-radius:8px",
          `font:700 18px/1 ${DISPLAY}`,
          "letter-spacing:0.1em",
          "text-transform:uppercase",
          "user-select:none",
        ].join(";"),
        QUALITY_PRESETS[level].label,
      );
      card.addEventListener("click", () => selectQuality(level));
      cardEls.set(level, card);
      cards.appendChild(card);
    }
    qualityBlock.append(cards, describe);
    selectQuality(quality);

    // --- transmission ------------------------------------------------------
    let transmission: TransmissionMode = options.initialTransmission ?? "automatic";
    const transmissionBlock = el("div", "display:flex;flex-direction:column;gap:10px;align-items:center");
    transmissionBlock.appendChild(
      el("div", `font:600 13px/1 ${MONO};letter-spacing:0.2em;opacity:0.75`, "TRANSMISSION"),
    );
    const transmissionCards = el("div", "display:flex;gap:12px");
    const transmissionCardEls = new Map<TransmissionMode, HTMLDivElement>();
    const transmissionDescribe = el("div", `font:400 13px/1.4 ${MONO};opacity:0.7;min-height:1.4em;text-align:center`);

    const selectTransmission = (mode: TransmissionMode): void => {
      transmission = mode;
      for (const [m, card] of transmissionCardEls) {
        const on = m === mode;
        card.style.borderColor = on ? "#ff9f1c" : "rgba(255,255,255,0.35)";
        card.style.background = on ? "rgba(255,159,28,0.18)" : "rgba(255,255,255,0.06)";
      }
      transmissionDescribe.textContent = TRANSMISSION_DESCRIPTIONS[mode];
    };

    for (const mode of ["automatic", "manual"] as const) {
      const card = el(
        "div",
        [
          "cursor:pointer",
          "width:120px",
          "padding:13px 0",
          "text-align:center",
          "border:2px solid rgba(255,255,255,0.35)",
          "border-radius:8px",
          `font:700 18px/1 ${DISPLAY}`,
          "letter-spacing:0.1em",
          "text-transform:uppercase",
          "user-select:none",
        ].join(";"),
        TRANSMISSION_LABELS[mode],
      );
      card.addEventListener("click", () => selectTransmission(mode));
      transmissionCardEls.set(mode, card);
      transmissionCards.appendChild(card);
    }
    transmissionBlock.append(transmissionCards, transmissionDescribe);
    selectTransmission(transmission);

    // --- course ----------------------------------------------------------
    const courseBlock = el("div", "display:flex;align-items:center;gap:12px");
    courseBlock.appendChild(el("div", `font:600 13px/1 ${MONO};letter-spacing:0.2em;opacity:0.75`, "COURSE"));
    const select = el(
      "select",
      [
        `font:500 15px/1 ${MONO}`,
        "padding:8px 12px",
        "background:rgba(255,255,255,0.08)",
        "color:#fff",
        "border:2px solid rgba(255,255,255,0.35)",
        "border-radius:6px",
      ].join(";"),
    );
    const randomOption = el("option", "color:#000", "Random");
    randomOption.value = "";
    select.appendChild(randomOption);
    for (const name of options.trackNames) {
      const option = el("option", "color:#000", name);
      option.value = name;
      select.appendChild(option);
    }
    select.value = options.initialTrack && options.trackNames.includes(options.initialTrack) ? options.initialTrack : "";
    courseBlock.appendChild(select);

    // --- controls: one row, so the screen fits a laptop window ------------
    const controls = el(
      "div",
      `display:flex;flex-wrap:wrap;justify-content:center;gap:6px 22px;font:400 13px/1.5 ${MONO};opacity:0.75;max-width:720px`,
    );
    for (const [key, action] of CONTROLS) {
      const item = el("div", "display:flex;gap:8px");
      item.append(el("span", "color:#ffd27a", key), el("span", "", action));
      controls.appendChild(item);
    }

    // --- go --------------------------------------------------------------
    const start = button("Start race", true);
    const hint = el("div", `font:400 12px/1 ${MONO};opacity:0.5;letter-spacing:0.15em`, "or press ENTER");

    const finish = (): void => {
      window.removeEventListener("keydown", onKey);
      root.remove();
      resolve({ quality, track: select.value || null, transmission });
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === "Enter" || event.code === "NumpadEnter") finish();
    };
    start.addEventListener("click", finish);
    window.addEventListener("keydown", onKey);

    root.append(title, subtitle, qualityBlock, transmissionBlock, courseBlock, controls, start, hint);
    document.body.appendChild(root);
    start.focus();
  });
}
