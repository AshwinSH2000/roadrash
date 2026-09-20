import { NitroState } from "../entities/Nitro";
import { AttackPhase } from "../combat/CombatSystem";
import type { AttackKind } from "../combat/AttackDefinitions";
import { DISPLAY, MONO, PANEL_BG, el, formatRaceTime } from "./dom";

/**
 * The in-race HUD: position and race clock top-left with the running order
 * under them, the course and a progress bar top-centre, speed and gear
 * bottom-centre, the nitro bar bottom-left. Everything a rider needs at a
 * glance and nothing that needs reading.
 *
 * The old debug readout survives as a dev-only panel (`setDebugText`),
 * hidden until H is pressed, because the tuning work still leans on it.
 */

export interface HudStanding {
  name: string;
  isPlayer: boolean;
  hasFinished: boolean;
  raceTime: number;
  /** Metres ahead (+) or behind (−) the player. */
  gap: number;
}

export interface HudData {
  trackName: string;
  speedKph: number;
  gear: number;
  position: number;
  fieldSize: number;
  raceTime: number;
  /** 0..1 along the race distance. */
  progress: number;
  standings: readonly HudStanding[];
  nitro: { charge: number; state: NitroState };
  combat: { kind: AttackKind; phase: AttackPhase; cooldown: number } | null;
  /** True while the player is off the bike, so the HUD can say so. */
  recovering: boolean;
  /** Seconds left before a DNF, or null while nobody has finished. */
  secondsToDnf: number | null;
}

export class HUD {
  private readonly nodes: HTMLElement[] = [];

  private readonly position: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly deadline: HTMLDivElement;
  private readonly standings: HTMLDivElement;
  private readonly course: HTMLDivElement;
  private readonly progressFill: HTMLDivElement;
  private readonly progressMarker: HTMLDivElement;
  private readonly speed: HTMLDivElement;
  private readonly gear: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly nitroFill: HTMLDivElement;
  private readonly nitroLabel: HTMLDivElement;
  private readonly debug: HTMLPreElement;

  private lastStandingsKey = "";

  constructor(showDebug: boolean) {
    // --- top-left: position, clock, order --------------------------------
    const left = this.add(
      el("div", `position:fixed;left:16px;top:16px;display:flex;flex-direction:column;gap:8px;pointer-events:none;z-index:10;color:#fff`),
    );
    const posRow = el("div", "display:flex;align-items:baseline;gap:6px;text-shadow:0 2px 10px rgba(0,0,0,0.8)");
    this.position = el("div", `font:900 56px/1 ${DISPLAY};letter-spacing:0.02em`);
    const of = el("div", `font:600 18px/1 ${DISPLAY};opacity:0.7`);
    posRow.append(this.position, of);
    this.clock = el("div", `font:600 22px/1 ${MONO};text-shadow:0 2px 10px rgba(0,0,0,0.8)`);
    this.deadline = el("div", `font:500 12px/1 ${MONO};color:#ff9f1c;opacity:0.9;display:none`);
    this.standings = el(
      "div",
      `display:grid;grid-template-columns:auto auto auto;gap:2px 10px;font:400 13px/1.3 ${MONO};padding:8px 10px;background:${PANEL_BG};border-radius:6px;margin-top:4px`,
    );
    left.append(posRow, this.clock, this.deadline, this.standings);
    // `of` is updated alongside position; keep a handle via closure.
    this.updateOf = (n) => (of.textContent = `/ ${n}`);

    // --- top-centre: course + progress -----------------------------------
    const top = this.add(
      el("div", "position:fixed;left:50%;top:16px;transform:translateX(-50%);width:min(44vw,520px);pointer-events:none;z-index:10;color:#fff;text-align:center"),
    );
    this.course = el("div", `font:500 12px/1 ${MONO};letter-spacing:0.25em;opacity:0.8;margin-bottom:6px;text-shadow:0 2px 8px rgba(0,0,0,0.8)`);
    const bar = el("div", `position:relative;height:8px;background:${PANEL_BG};border-radius:4px;border:1px solid rgba(255,255,255,0.35)`);
    this.progressFill = el("div", "height:100%;width:0%;background:rgba(255,255,255,0.55);border-radius:4px");
    this.progressMarker = el(
      "div",
      "position:absolute;top:-5px;left:0;width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-top:10px solid #ffd27a;transform:translateX(-50%)",
    );
    const flag = el("div", "position:absolute;right:-2px;top:-9px;width:4px;height:16px;background:#fff");
    bar.append(this.progressFill, this.progressMarker, flag);
    top.append(this.course, bar);

    // --- bottom-centre: speed, gear, status ------------------------------
    const bottom = this.add(
      el("div", "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;pointer-events:none;z-index:10;color:#fff;text-shadow:0 3px 14px rgba(0,0,0,0.85)"),
    );
    this.status = el("div", `font:600 14px/1 ${MONO};letter-spacing:0.15em;min-height:14px;margin-bottom:6px;color:#ffd27a`);
    const speedRow = el("div", "display:flex;align-items:baseline;gap:8px");
    this.speed = el("div", `font:italic 900 64px/1 ${DISPLAY};letter-spacing:-0.02em;min-width:2.2em;text-align:right`);
    const unit = el("div", `font:600 16px/1 ${DISPLAY};opacity:0.7`, "km/h");
    this.gear = el("div", `font:600 16px/1 ${MONO};opacity:0.7;margin-left:14px`);
    speedRow.append(this.speed, unit, this.gear);
    bottom.append(this.status, speedRow);

    // --- bottom-left: nitro ----------------------------------------------
    const nitro = this.add(
      el("div", `position:fixed;left:16px;bottom:24px;width:220px;height:14px;border:2px solid rgba(255,255,255,0.8);border-radius:4px;background:${PANEL_BG};pointer-events:none;z-index:10;box-sizing:border-box`),
    );
    this.nitroFill = el("div", "height:100%;width:100%;background:#3ddc84;transition:width 80ms linear");
    this.nitroLabel = el("div", `position:absolute;left:0;top:-18px;font:12px/1 ${MONO};color:#fff;letter-spacing:0.08em`, "NITRO  [N]");
    nitro.append(this.nitroFill, this.nitroLabel);

    // --- dev readout -----------------------------------------------------
    this.debug = el(
      "pre",
      `position:fixed;left:16px;bottom:72px;margin:0;padding:10px 14px;font:12px/1.45 ${MONO};color:#fff;background:${PANEL_BG};border-radius:6px;pointer-events:none;z-index:10;display:${showDebug ? "block" : "none"}`,
    );
    this.add(this.debug);
  }

  private readonly updateOf: (fieldSize: number) => void;

  private add<T extends HTMLElement>(node: T): T {
    document.body.appendChild(node);
    this.nodes.push(node);
    return node;
  }

  update(d: HudData): void {
    this.position.textContent = `P${d.position}`;
    this.updateOf(d.fieldSize);
    this.clock.textContent = formatRaceTime(d.raceTime);

    if (d.secondsToDnf !== null && d.secondsToDnf < 60) {
      this.deadline.style.display = "block";
      this.deadline.textContent = `DNF in ${Math.max(0, d.secondsToDnf).toFixed(0)} s`;
    } else {
      this.deadline.style.display = "none";
    }

    this.course.textContent = d.trackName.toUpperCase();
    const pct = Math.max(0, Math.min(1, d.progress)) * 100;
    this.progressFill.style.width = `${pct.toFixed(1)}%`;
    this.progressMarker.style.left = `${pct.toFixed(1)}%`;

    this.speed.textContent = d.speedKph.toFixed(0);
    this.gear.textContent = `G${d.gear}`;

    if (d.recovering) {
      this.status.textContent = "GET BACK ON THE BIKE";
    } else if (d.combat && d.combat.phase !== AttackPhase.IDLE) {
      this.status.textContent = `${d.combat.kind.toUpperCase()}  ${d.combat.phase}`;
    } else {
      this.status.textContent = "";
    }

    this.nitroFill.style.width = `${(d.nitro.charge * 100).toFixed(1)}%`;
    switch (d.nitro.state) {
      case NitroState.READY:
        this.nitroFill.style.background = "#3ddc84";
        this.nitroLabel.textContent = "NITRO  [N]  ready";
        break;
      case NitroState.ACTIVE:
        this.nitroFill.style.background = "#ff9f1c";
        this.nitroLabel.textContent = "NITRO  boosting";
        break;
      case NitroState.RECHARGING:
        this.nitroFill.style.background = "#6b7280";
        this.nitroLabel.textContent = "NITRO  recharging";
        break;
    }

    // The order list is rebuilt only when something in it changes; the gaps
    // are rounded to the metre so that's a few times a second, not 60.
    const key = d.standings
      .map((s) => `${s.name}|${s.hasFinished ? s.raceTime.toFixed(1) : Math.round(s.gap)}`)
      .join(";");
    if (key !== this.lastStandingsKey) {
      this.lastStandingsKey = key;
      this.standings.replaceChildren();
      d.standings.forEach((s, i) => {
        const style = s.isPlayer ? "color:#ffd27a;font-weight:700" : "";
        this.standings.appendChild(el("div", `text-align:right;${style}`, `${i + 1}`));
        this.standings.appendChild(el("div", style, s.name));
        const detail = s.hasFinished
          ? formatRaceTime(s.raceTime)
          : s.isPlayer
            ? ""
            : `${s.gap >= 0 ? "+" : ""}${s.gap.toFixed(0)} m`;
        this.standings.appendChild(el("div", `text-align:right;opacity:0.8;${style}`, detail));
      });
    }
  }

  /** Dev-only readout — a block of preformatted lines. */
  setDebugText(text: string): void {
    if (this.debug.style.display !== "none") this.debug.textContent = text;
  }

  toggleDebug(): void {
    this.debug.style.display = this.debug.style.display === "none" ? "block" : "none";
  }

  get debugVisible(): boolean {
    return this.debug.style.display !== "none";
  }

  dispose(): void {
    for (const node of this.nodes) node.remove();
    this.nodes.length = 0;
  }
}
