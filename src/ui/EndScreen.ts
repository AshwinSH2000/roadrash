import { RaceResult } from "../core/RaceFlow";
import { DISPLAY, MONO, button, el, formatRaceTime, ordinal, overlay } from "./dom";

/**
 * The end screen: Win / Lose / DNF, the player's position, the full order,
 * and two ways out — "Race Again" resets everyone to the start line in
 * place, "Change settings" goes back to the start screen (a page reload; the
 * renderer is built from the quality preset and isn't reconfigured live).
 *
 * The race carries on behind it at half brightness: the bots still finish,
 * and the standings keep updating until you leave.
 */

export interface EndScreenStanding {
  name: string;
  isPlayer: boolean;
  hasFinished: boolean;
  raceTime: number;
}

export interface EndScreenData {
  result: RaceResult;
  position: number;
  fieldSize: number;
  /** The player's race time, or the time at which the race timed out. */
  raceTime: number;
  standings: readonly EndScreenStanding[];
}

export class EndScreen {
  private readonly root: HTMLDivElement;
  private readonly headline: HTMLDivElement;
  private readonly subline: HTMLDivElement;
  private readonly table: HTMLDivElement;
  private visible = false;

  constructor(
    private readonly onRaceAgain: () => void,
    private readonly onChangeSettings: () => void,
  ) {
    this.root = overlay(30, 0.55);
    this.root.style.gap = "18px";

    this.headline = el(
      "div",
      `font:900 72px/1 ${DISPLAY};letter-spacing:0.15em;text-transform:uppercase;text-shadow:0 4px 24px rgba(0,0,0,0.8)`,
    );
    this.subline = el("div", `font:500 18px/1.4 ${MONO};opacity:0.85;text-align:center`);
    this.table = el(
      "div",
      `display:grid;grid-template-columns:auto auto auto;gap:6px 22px;font:400 15px/1.4 ${MONO};margin-top:8px;padding:14px 22px;background:rgba(0,0,0,0.35);border-radius:8px`,
    );

    const buttons = el("div", "display:flex;gap:16px;margin-top:14px");
    const again = button("Race again", true);
    again.addEventListener("click", () => this.onRaceAgain());
    const settings = button("Change settings", false);
    settings.addEventListener("click", () => this.onChangeSettings());
    buttons.append(again, settings);

    const hint = el("div", `font:400 12px/1 ${MONO};opacity:0.5;letter-spacing:0.15em`, "ENTER = race again");

    this.root.append(this.headline, this.subline, this.table, buttons, hint);
    document.body.appendChild(this.root);
    window.addEventListener("keydown", this.onKey);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.visible) return;
    if (event.code === "Enter" || event.code === "NumpadEnter") this.onRaceAgain();
  };

  get isVisible(): boolean {
    return this.visible;
  }

  show(data: EndScreenData): void {
    this.visible = true;
    this.root.style.display = "flex";
    switch (data.result) {
      case RaceResult.WIN:
        this.headline.textContent = "You win";
        this.headline.style.color = "#3ddc84";
        this.subline.textContent = `1st of ${data.fieldSize}  ·  ${formatRaceTime(data.raceTime)}`;
        break;
      case RaceResult.LOSE:
        this.headline.textContent = "Finished";
        this.headline.style.color = "#fff";
        this.subline.textContent = `${ordinal(data.position)} of ${data.fieldSize}  ·  ${formatRaceTime(data.raceTime)}`;
        break;
      case RaceResult.DNF:
        this.headline.textContent = "Did not finish";
        this.headline.style.color = "#ff6b6b";
        this.subline.textContent = `time ran out at ${formatRaceTime(data.raceTime)}  ·  ranked ${ordinal(data.position)} of ${data.fieldSize}`;
        break;
    }
    this.updateStandings(data.standings);
  }

  /** Keeps the order current while the bots behind you are still finishing. */
  updateStandings(standings: readonly EndScreenStanding[]): void {
    if (!this.visible) return;
    this.table.replaceChildren();
    standings.forEach((s, i) => {
      const color = s.isPlayer ? "color:#ffd27a;font-weight:700" : "";
      this.table.appendChild(el("div", `text-align:right;${color}`, `${i + 1}.`));
      this.table.appendChild(el("div", color, s.name));
      this.table.appendChild(
        el("div", `text-align:right;opacity:0.8;${color}`, s.hasFinished ? formatRaceTime(s.raceTime) : "still racing"),
      );
    });
  }

  hide(): void {
    this.visible = false;
    this.root.style.display = "none";
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    this.root.remove();
  }
}
