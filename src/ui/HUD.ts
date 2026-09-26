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

/** One rider's world position for the minimap — everything it needs to place a dot, nothing else. */
export interface MinimapRider {
  x: number;
  z: number;
  /** 0xRRGGBB — the same colour as the cone over their head, so the map and the world agree. */
  color: number;
  isPlayer: boolean;
}

/**
 * The road's left/right edges at one point along the centreline, in world
 * space, already offset by the road's half-width — `Game.ts` builds these
 * from `TrackDefinition.sampleRights` so the minimap itself never needs to
 * know how wide the road is or which way is "right". Ordered along the
 * track, so consecutive samples are the ribbon's actual next segment.
 */
export interface MinimapTrackSample {
  leftX: number;
  leftZ: number;
  rightX: number;
  rightZ: number;
}

export interface MinimapData {
  /** The local window of road centred on the player — see `MINIMAP_RANGE`. */
  trackSamples: readonly MinimapTrackSample[];
  /** Every racer, the player included. */
  riders: readonly MinimapRider[];
  /** The player's own world position — everything above is drawn relative to this. */
  playerX: number;
  playerZ: number;
  /** The player's current forward direction in the world (X/Z, need not be unit length) — this is what points straight up on the map, so the map rotates as the player turns rather than the player's dot. */
  playerForwardX: number;
  playerForwardZ: number;
}

/** Metres ahead/behind the player the minimap's window covers — a fixed local slice, not the whole course. */
export const MINIMAP_RANGE = 200;

export interface HudData {
  trackName: string;
  speedKph: number;
  gear: number;
  /** True only in manual transmission — gates the rpm readout below; automatic's HUD is unchanged (gear only). */
  manualTransmission: boolean;
  /** 0..1 between idle and redline — only read/shown when `manualTransmission` is true. */
  rpmNormalized: number;
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
  minimap: MinimapData;
}

/** A square panel — `±MINIMAP_RANGE` metres of forward/back range sets the scale for both axes, so a curve draws at its true proportions rather than being stretched to fit a non-square shape. */
const MINIMAP_SIZE = 180;
const MINIMAP_DOT_RADIUS = 4;
const MINIMAP_PLAYER_DOT_RADIUS = 6;

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
  /** Only shown in manual mode — see `HudData.manualTransmission`. */
  private readonly rpm: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly nitroFill: HTMLDivElement;
  private readonly nitroLabel: HTMLDivElement;
  private readonly debug: HTMLPreElement;
  private readonly minimapCanvas: HTMLCanvasElement;
  private readonly minimapCtx: CanvasRenderingContext2D | null;

  private lastStandingsKey = "";

  constructor(showDebug: boolean, mobile = false) {
    // --- top-left: position, clock, order --------------------------------
    const left = this.add(
      el("div", `position:fixed;left:16px;top:16px;display:flex;flex-direction:column;gap:8px;pointer-events:none;z-index:10;color:#fff`),
    );
    const posRow = el("div", "display:flex;align-items:baseline;gap:6px;text-shadow:0 2px 10px rgba(0,0,0,0.8)");
    // Smaller on a phone screen — this block otherwise eats a chunk of a
    // display that's already tight against the touch controls.
    this.position = el("div", `font:900 ${mobile ? 32 : 56}px/1 ${DISPLAY};letter-spacing:0.02em`);
    const of = el("div", `font:600 ${mobile ? 12 : 18}px/1 ${DISPLAY};opacity:0.7`);
    posRow.append(this.position, of);
    this.clock = el("div", `font:600 22px/1 ${MONO};text-shadow:0 2px 10px rgba(0,0,0,0.8)`);
    this.deadline = el("div", `font:500 12px/1 ${MONO};color:#ff9f1c;opacity:0.9;display:none`);
    this.standings = el(
      "div",
      `display:grid;grid-template-columns:auto auto auto;gap:2px 10px;font:400 ${mobile ? 10 : 13}px/1.3 ${MONO};padding:${mobile ? "5px 7px" : "8px 10px"};background:${PANEL_BG};border-radius:6px;margin-top:4px`,
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
    // Manual only — a redline cue the player actually needs to see to know
    // when to shift; automatic never shows it (the box handles it invisibly).
    this.rpm = el("div", `font:600 16px/1 ${MONO};opacity:0.7;margin-left:8px;display:none`);
    speedRow.append(this.speed, unit, this.gear, this.rpm);
    bottom.append(this.status, speedRow);

    // --- nitro: bottom-left on desktop, under the speed readout on mobile
    // (bottom-left is where the touch pedals live, see MobileInputManager) --
    const nitroWidth = mobile ? 180 : 220;
    const nitro = el(
      "div",
      mobile
        ? `position:relative;margin-top:14px;width:${nitroWidth}px;height:14px;border:2px solid rgba(255,255,255,0.8);border-radius:4px;background:${PANEL_BG};pointer-events:none;box-sizing:border-box`
        : `position:fixed;left:16px;bottom:24px;width:${nitroWidth}px;height:14px;border:2px solid rgba(255,255,255,0.8);border-radius:4px;background:${PANEL_BG};pointer-events:none;z-index:10;box-sizing:border-box`,
    );
    this.nitroFill = el("div", "height:100%;width:100%;background:#3ddc84;transition:width 80ms linear");
    this.nitroLabel = el("div", `position:absolute;left:0;top:-18px;font:12px/1 ${MONO};color:#fff;letter-spacing:0.08em`, "NITRO  [N]");
    nitro.append(this.nitroFill, this.nitroLabel);
    if (mobile) bottom.appendChild(nitro);
    else this.add(nitro);

    // --- top-right: minimap ------------------------------------------------
    const mapPanel = this.add(
      el(
        "div",
        `position:fixed;right:16px;top:16px;padding:6px;background:${PANEL_BG};border-radius:6px;pointer-events:none;z-index:10`,
      ),
    );
    this.minimapCanvas = el("canvas", "display:block;border-radius:3px");
    const minimapSize = mobile ? Math.round(MINIMAP_SIZE * (2 / 3)) : MINIMAP_SIZE;
    this.minimapCanvas.width = minimapSize;
    this.minimapCanvas.height = minimapSize;
    this.minimapCtx = this.minimapCanvas.getContext("2d");
    mapPanel.appendChild(this.minimapCanvas);

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

    if (d.manualTransmission) {
      this.rpm.style.display = "inline";
      const pct = Math.round(d.rpmNormalized * 100);
      this.rpm.textContent = `${pct}%`;
      // A shift cue, not a warning light: amber approaching redline, red
      // right at it — the same two-stage falloff `Transmission.manualDrive`
      // itself uses, so the colour changes exactly when the engine stops
      // pulling as hard.
      this.rpm.style.color = d.rpmNormalized >= 0.95 ? "#ff5a4d" : d.rpmNormalized >= 0.82 ? "#ffd27a" : "";
    } else {
      this.rpm.style.display = "none";
    }

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

    this.drawMinimap(d.minimap);
  }

  /**
   * A real local map, not a schematic: the actual road curve, within
   * `±MINIMAP_RANGE` metres of the player along the track, redrawn every
   * frame rotated so the player's current heading always points straight up
   * — a standard "heading-up" nav map. The player's dot never moves (always
   * the exact centre); when the road bends, the ribbon and everyone on it
   * swing around that fixed point instead.
   *
   * The rotation itself is two dot products, not trig: `Game.ts` hands over
   * the player's forward vector (X/Z, not necessarily unit length) rather
   * than a heading angle, and projecting a world-space offset onto that
   * vector gives the "forward" screen axis directly; projecting onto its
   * perpendicular (`-forwardZ, forwardX` — this project's own right-hand
   * convention, see `utils/Directions.rightOf`) gives "right". No
   * trigonometric functions, no wraparound to worry about.
   */
  private drawMinimap(m: MinimapData): void {
    const ctx = this.minimapCtx;
    if (!ctx) return;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(20,20,24,0.55)";
    ctx.fillRect(0, 0, w, h);

    const flen = Math.hypot(m.playerForwardX, m.playerForwardZ);
    if (flen < 1e-6) return;
    const fx = m.playerForwardX / flen;
    const fz = m.playerForwardZ / flen;
    // Perpendicular to (fx, fz) — this project's `right = forward × up` convention, flattened to the XZ plane.
    const rx = -fz;
    const rz = fx;

    const scale = w / (MINIMAP_RANGE * 2);
    const cx = w / 2;
    const cy = h / 2;
    // World offset from the player -> screen point, heading-up.
    const project = (x: number, z: number): { x: number; y: number } => {
      const dx = x - m.playerX;
      const dz = z - m.playerZ;
      return {
        x: cx + (dx * rx + dz * rz) * scale,
        y: cy - (dx * fx + dz * fz) * scale,
      };
    };

    // The road ribbon: left edge out, right edge back, one closed path — a
    // filled strip that actually follows the curve, not a straight band.
    if (m.trackSamples.length >= 2) {
      ctx.fillStyle = "rgba(160,160,168,0.7)";
      ctx.beginPath();
      const first = project(m.trackSamples[0].leftX, m.trackSamples[0].leftZ);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < m.trackSamples.length; i++) {
        const p = project(m.trackSamples[i].leftX, m.trackSamples[i].leftZ);
        ctx.lineTo(p.x, p.y);
      }
      for (let i = m.trackSamples.length - 1; i >= 0; i--) {
        const p = project(m.trackSamples[i].rightX, m.trackSamples[i].rightZ);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();

      // A dashed centreline, from the midpoint of each edge pair — a style
      // cue, not new data.
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      for (let i = 0; i < m.trackSamples.length; i++) {
        const s = m.trackSamples[i];
        const p = project((s.leftX + s.rightX) / 2, (s.leftZ + s.rightZ) / 2);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Everyone else first, the player last, so the player's dot is never
    // hidden under someone overlapping it.
    for (const r of m.riders) {
      if (r.isPlayer) continue;
      const p = project(r.x, r.z);
      if (p.x < -MINIMAP_DOT_RADIUS || p.x > w + MINIMAP_DOT_RADIUS || p.y < -MINIMAP_DOT_RADIUS || p.y > h + MINIMAP_DOT_RADIUS) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, MINIMAP_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(r.color);
      ctx.fill();
    }

    const player = m.riders.find((r) => r.isPlayer);
    if (!player) return;
    ctx.beginPath();
    ctx.arc(cx, cy, MINIMAP_PLAYER_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(player.color);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke();
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

/** 0xRRGGBB, the same numeric colour every rider's cone/bike paint already uses, as a canvas fill style. */
function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
