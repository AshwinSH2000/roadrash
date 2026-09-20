import { DISPLAY, MONO, el } from "./dom";

/** How long "GO!" stays up after the lights go out, in seconds. */
const GO_SECONDS = 1.0;

/**
 * "3 … 2 … 1 … GO!" over the grid. No dimming: the countdown is the moment
 * you look at the pack ahead, not a menu. Driven from `RaceFlow`'s numbers
 * each frame; it holds no timing of its own.
 */
export class CountdownOverlay {
  private readonly root: HTMLDivElement;
  private readonly number: HTMLDivElement;
  private readonly caption: HTMLDivElement;
  private lastShown = "";

  constructor() {
    this.root = el(
      "div",
      [
        "position:fixed",
        "inset:0",
        "display:none",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "pointer-events:none",
        "z-index:15",
        "color:#fff",
      ].join(";"),
    );
    this.number = el(
      "div",
      `font:900 160px/1 ${DISPLAY};letter-spacing:0.05em;text-shadow:0 6px 30px rgba(0,0,0,0.8);transition:transform 120ms ease-out,opacity 200ms`,
    );
    this.caption = el(
      "div",
      `font:500 15px/1 ${MONO};letter-spacing:0.3em;opacity:0.8;margin-top:12px;text-shadow:0 2px 8px rgba(0,0,0,0.8)`,
    );
    this.root.append(this.number, this.caption);
    document.body.appendChild(this.root);
  }

  /**
   * @param countdownRemaining seconds until the lights go out (0 once racing)
   * @param raceElapsed seconds since they did
   */
  update(countdownRemaining: number, raceElapsed: number): void {
    let text: string;
    if (countdownRemaining > 0) {
      text = String(Math.ceil(countdownRemaining));
      this.caption.textContent = "GET READY";
    } else if (raceElapsed < GO_SECONDS) {
      text = "GO!";
      this.caption.textContent = "";
    } else {
      this.root.style.display = "none";
      this.lastShown = "";
      return;
    }

    this.root.style.display = "flex";
    if (text !== this.lastShown) {
      this.lastShown = text;
      this.number.textContent = text;
      this.number.style.color = text === "GO!" ? "#3ddc84" : "#fff";
      // A little pop on each change, so the numbers read as beats.
      this.number.style.transform = "scale(1.25)";
      requestAnimationFrame(() => (this.number.style.transform = "scale(1)"));
    }
    if (text === "GO!") {
      this.number.style.opacity = String(1 - raceElapsed / GO_SECONDS);
    } else {
      this.number.style.opacity = "1";
    }
  }

  hide(): void {
    this.root.style.display = "none";
    this.lastShown = "";
  }

  dispose(): void {
    this.root.remove();
  }
}
