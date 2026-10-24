import {
  DEFAULT_QUALITY,
  QUALITY_PRESETS,
  type QualityLevel,
} from "../settings/GraphicsSettings";
import type { TransmissionMode } from "../physics/Transmission";
import { DAY_MODES, SEASONS, type DayMode, type Season } from "../render/Environment";
import { isTouchDevice, requestTiltPermissionFromGesture } from "../core/MobileInputManager";
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
  season: Season;
  dayMode: DayMode;
}

export interface StartScreenOptions {
  trackNames: readonly string[];
  initialTrack: string | null;
  initialQuality?: QualityLevel;
  initialTransmission?: TransmissionMode;
  initialSeason?: Season;
  initialDayMode?: DayMode;
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

/**
 * Manual transmission is built and working (Q/E, T, `?transmission=manual`)
 * but not offered on this screen for now. Flip this to bring the picker and
 * its control hints back.
 */
const SHOW_TRANSMISSION_PICKER = false;

const CONTROLS: readonly [string, string][] = [
  ["W / ↑", "throttle"],
  ["S / ↓", "brake"],
  ["A / D", "steer"],
  ["P", "punch"],
  ["K", "kick"],
  ["N", "nitro"],
  ["Q / E", "shift down/up (manual)"],
  ["T", "manual ⇄ automatic"],
  ["C", "change camera"],
  ["space", "pause"],
  ["tilt", "steer (touch devices)"],
];

export function showStartScreen(options: StartScreenOptions): Promise<StartChoice> {
  if (options.autostart) {
    return Promise.resolve({
      quality: options.initialQuality ?? DEFAULT_QUALITY,
      track: options.initialTrack,
      transmission: options.initialTransmission ?? "automatic",
      season: options.initialSeason ?? "summer",
      dayMode: options.initialDayMode ?? "day",
    });
  }
  const touch = isTouchDevice();
  return new Promise((resolve) => {
    const root = overlay(40, 0.72);
    root.style.display = "flex";
    // Short screens (a phone in landscape) are tighter and smaller. Centring is done with auto
    // margins on the first and last child, not `justify-content:center`, which would push the
    // title off the top of a scrolling overlay where it can never be scrolled back to.
    const compact = window.innerHeight < 560;
    root.style.justifyContent = "flex-start";
    root.style.gap = compact ? "8px" : "18px";
    // Small windows: let the screen scroll rather than clip the title or the button.
    root.style.overflow = "auto";
    root.style.padding = compact ? "10px 0" : "24px 0";
    root.style.boxSizing = "border-box";

    const title = el(
      "div",
      `font:900 ${compact ? 34 : 56}px/1 ${DISPLAY};letter-spacing:0.18em;text-transform:uppercase;text-shadow:0 4px 24px rgba(0,0,0,0.8);flex-shrink:0`,
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

    // --- transmission: mobile has no shift input, so it's automatic-only and
    // this whole picker is hidden there -----------------------------------
    let transmission: TransmissionMode = touch ? "automatic" : options.initialTransmission ?? "automatic";
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
    const visibleControls = touch || !SHOW_TRANSMISSION_PICKER
      ? CONTROLS.filter(([key]) => key !== "Q / E" && key !== "T")
      : CONTROLS;
    for (const [key, action] of visibleControls) {
      const item = el("div", "display:flex;gap:8px");
      item.append(el("span", "color:#ffd27a", key), el("span", "", action));
      controls.appendChild(item);
    }

    // --- second step: season and time of day ------------------------------
    let season: Season = options.initialSeason ?? "summer";
    let dayMode: DayMode = options.initialDayMode ?? "day";
    const SEASON_DESCRIPTIONS: Record<Season, string> = {
      summer: "clear and green, as the roads are now",
      winter: "snow on everything and snowfall; tracks show dark where riders have been",
      rainy: "grey sky and rain",
    };
    const DAY_DESCRIPTIONS: Record<DayMode, string> = {
      day: "full daylight",
      night: "dark sky, headlights, lit street lamps",
    };
    /** A row of option cards with one selected, and a line under it describing the choice. */
    const choiceBlock = <T extends string>(heading: string, values: readonly T[], initial: T, descriptions: Record<T, string>, onPick: (value: T) => void): HTMLDivElement => {
      const block = el("div", "display:flex;flex-direction:column;gap:10px;align-items:center");
      block.appendChild(el("div", `font:600 13px/1 ${MONO};letter-spacing:0.2em;opacity:0.75`, heading));
      const row = el("div", "display:flex;gap:12px");
      const describeLine = el("div", `font:400 13px/1.4 ${MONO};opacity:0.7;min-height:1.4em;text-align:center`);
      const cardFor = new Map<T, HTMLDivElement>();
      const select = (value: T): void => {
        onPick(value);
        for (const [v, card] of cardFor) {
          const on = v === value;
          card.style.borderColor = on ? "#ff9f1c" : "rgba(255,255,255,0.35)";
          card.style.background = on ? "rgba(255,159,28,0.18)" : "rgba(255,255,255,0.06)";
        }
        describeLine.textContent = descriptions[value];
      };
      for (const value of values) {
        const card = el(
          "div",
          ["cursor:pointer", "width:120px", "padding:13px 0", "text-align:center", "border:2px solid rgba(255,255,255,0.35)", "border-radius:8px", `font:700 18px/1 ${DISPLAY}`, "letter-spacing:0.1em", "text-transform:uppercase", "user-select:none"].join(";"),
          value,
        );
        card.addEventListener("click", () => select(value));
        cardFor.set(value, card);
        row.appendChild(card);
      }
      block.append(row, describeLine);
      select(initial);
      return block;
    };
    const seasonBlock = choiceBlock("SEASON", SEASONS, season, SEASON_DESCRIPTIONS, (v) => (season = v));
    const dayBlock = choiceBlock("TIME OF DAY", DAY_MODES, dayMode, DAY_DESCRIPTIONS, (v) => (dayMode = v));

    // --- go --------------------------------------------------------------
    let step: 1 | 2 = 1;
    const start = button("Continue", true);
    const back = button("Back", false);
    back.style.display = "none";
    const hint = el("div", `font:400 12px/1 ${MONO};opacity:0.5;letter-spacing:0.15em`, "or press ENTER");
    const stepOne: HTMLElement[] = touch ? [qualityBlock, courseBlock, controls] : [qualityBlock, ...(SHOW_TRANSMISSION_PICKER ? [transmissionBlock] : []), courseBlock, controls];
    const stepTwo: HTMLElement[] = [seasonBlock, dayBlock];
    // Clearing `display` would drop the flex layout each block was built with, so remember it.
    const shownAs = new Map<HTMLElement, string>([...stepOne, ...stepTwo].map((item) => [item, item.style.display]));
    const showStep = (next: 1 | 2): void => {
      step = next;
      for (const item of stepOne) item.style.display = next === 1 ? shownAs.get(item) ?? "" : "none";
      for (const item of stepTwo) item.style.display = next === 2 ? shownAs.get(item) ?? "" : "none";
      start.textContent = next === 1 ? "Continue" : "Start race";
      back.style.display = next === 2 ? "" : "none";
    };

    const finish = (): void => {
      window.removeEventListener("keydown", onKey);
      root.remove();
      // Fired from this same click/Enter gesture — the only chance iOS gives
      // a page to ask for the tilt-steering permission without a dialog
      // later, mid-race, with no obvious cause. See
      // `requestTiltPermissionFromGesture` for why a second, silent request
      // later still works after this one succeeds.
      void requestTiltPermissionFromGesture();
      resolve({ quality, track: select.value || null, transmission, season, dayMode });
    };
    const advance = (): void => {
      if (step === 1) showStep(2);
      else finish();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === "Enter" || event.code === "NumpadEnter") advance();
    };
    start.addEventListener("click", advance);
    back.addEventListener("click", () => showStep(1));
    window.addEventListener("keydown", onKey);

    title.style.marginTop = "auto";
    hint.style.marginBottom = "auto";
    root.append(title, subtitle, ...stepOne, ...stepTwo, start, back, hint);
    showStep(1);
    document.body.appendChild(root);
    start.focus();
  });
}
