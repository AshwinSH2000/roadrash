import { DISPLAY, MONO, el } from "../ui/dom";

/**
 * Touch/tilt input for phones: steer by tilting the device, throttle/brake
 * and the three action buttons via on-screen circles, pause by tapping
 * anywhere else, fullscreen in landscape. Only mounts anything when a touch
 * device is detected, so desktop play (keyboard, via `InputManager`) is
 * untouched.
 *
 * Steering is proportional to tilt angle away from a calibrated zero point,
 * because a fixed "phone flat" reference doesn't survive different grips or
 * laps in the hand. Where the platform allows it (everywhere but iOS, which
 * gates `DeviceOrientationEvent` behind an explicit gesture-triggered grant)
 * tilt starts, and zeroes itself, the moment the controls mount — no tap
 * needed. iOS still needs one tap on the calibrate button to grant that
 * permission; from then on the same button re-zeros on tap.
 */

/** Tilt angle, in degrees from the calibrated zero, that maps to full steering lock. */
const MAX_TILT_DEG = 25;

/** iOS 13+ gates `deviceorientation` behind an explicit, gesture-triggered grant. */
interface DeviceOrientationEventIOS {
  requestPermission?: () => Promise<"granted" | "denied">;
}

function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function iosPermissionGate(): DeviceOrientationEventIOS["requestPermission"] {
  if (typeof DeviceOrientationEvent === "undefined") return undefined;
  const ctor = DeviceOrientationEvent as unknown as DeviceOrientationEventIOS;
  return typeof ctor.requestPermission === "function" ? ctor.requestPermission : undefined;
}

function fullscreenSupported(): boolean {
  return typeof document.documentElement.requestFullscreen === "function";
}

/**
 * iOS gates `deviceorientation` behind a permission dialog that can only be
 * triggered from a direct user gesture — by the time `MobileInputManager`
 * mounts (during async `Game` bootstrap) that window has already closed, so
 * without this the player only discovers tilt is off once they're mid-race
 * and pause to find the enable button. Call this from the "Start race"
 * click/Enter handler instead, while it's still a genuine gesture: once
 * granted, `MobileInputManager`'s own later request for the same permission
 * resolves immediately with no further prompt, so tilt is live from the
 * green flag. Falls back to the pause-menu button exactly as before if this
 * doesn't fire (e.g. `autostart`), so there's no new failure mode.
 */
export async function requestTiltPermissionFromGesture(): Promise<void> {
  if (!isTouchDevice()) return;
  const requestPermission = iosPermissionGate();
  if (!requestPermission) return;
  try {
    await requestPermission();
  } catch {
    // Ignored — the pause-menu calibrate button still covers this.
  }
}

/** Normalizes gamma/beta to "left/right tilt" regardless of portrait/landscape mount. */
function tiltDegrees(event: DeviceOrientationEvent): number {
  const legacyOrientation = (window as unknown as { orientation?: number }).orientation;
  const angle = screen.orientation?.angle ?? legacyOrientation ?? 0;
  switch (angle) {
    case 90:
      return event.beta ?? 0;
    case -90:
    case 270:
      return -(event.beta ?? 0);
    case 180:
      return -(event.gamma ?? 0);
    default:
      return event.gamma ?? 0;
  }
}

export class MobileInputManager {
  /** Whether this device got a touch UI at all. Desktop keyboard play checks nothing here. */
  readonly active: boolean;

  private steerValue = 0;
  private throttleDown = false;
  private brakeDown = false;
  private tiltZero = 0;
  private awaitingZero = false;
  private tiltGranted = false;
  private calibrateButton: HTMLButtonElement | null = null;

  private punchJustPressed = false;
  private kickJustPressed = false;
  private nitroJustPressed = false;

  private onBackgroundTap: (() => void) | null = null;

  constructor() {
    this.active = isTouchDevice();
    if (this.active) this.mount();
  }

  /** -1 (left) .. 1 (right). Zero until tilt is granted/calibrated. */
  get steer(): number {
    return this.steerValue;
  }

  /** -1 (braking) .. 1 (throttle), combined the same way keyboard input is. */
  get throttle(): number {
    return (this.throttleDown ? 1 : 0) - (this.brakeDown ? 1 : 0);
  }

  wasPunchPressed(): boolean {
    return this.punchJustPressed;
  }

  wasKickPressed(): boolean {
    return this.kickJustPressed;
  }

  wasNitroPressed(): boolean {
    return this.nitroJustPressed;
  }

  /** Fires once, the first time this session's background tap lands — e.g. wired to toggle pause. */
  setOnBackgroundTap(callback: () => void): void {
    this.onBackgroundTap = callback;
  }

  /** Call once per fixed physics step, mirroring `InputManager.endStep`. */
  endStep(): void {
    this.punchJustPressed = false;
    this.kickJustPressed = false;
    this.nitroJustPressed = false;
  }

  private mount(): void {
    this.mountBackgroundTapCatcher();

    const root = el(
      "div",
      "position:fixed;inset:0;z-index:15;pointer-events:none;font-family:" + DISPLAY,
    );

    // Appended separately, outside `root`'s stacking context (see
    // `buildCalibrateButton`) — it only ever shows over the pause tint, and
    // a child's z-index can't escape its parent's own stacking context, so
    // it can't live inside `root` (z-index:15) and still out-rank the pause
    // overlay (z-index:20).
    this.calibrateButton = this.buildCalibrateButton();
    document.body.appendChild(this.calibrateButton);

    const gas = this.buildPedal(
      "width:92px;height:92px;bottom:22px;right:22px;background:rgba(58,201,90,0.28);border-color:#3ac95a",
      "GAS",
      () => (this.throttleDown = true),
      () => (this.throttleDown = false),
    );
    const brake = this.buildPedal(
      "width:92px;height:92px;bottom:22px;left:22px;background:rgba(230,70,70,0.28);border-color:#e64646",
      "BRAKE",
      () => (this.brakeDown = true),
      () => (this.brakeDown = false),
    );

    // Three action buttons in a row directly above the brake pedal.
    const actionY = 22 + 92 + 10;
    const punch = this.buildPedal(
      `width:56px;height:56px;bottom:${actionY}px;left:22px;background:rgba(230,70,70,0.28);border-color:#e64646;font-size:11px`,
      "PUNCH",
      () => (this.punchJustPressed = true),
    );
    const kick = this.buildPedal(
      `width:56px;height:56px;bottom:${actionY}px;left:86px;background:rgba(74,144,226,0.28);border-color:#4a90e2;font-size:11px`,
      "KICK",
      () => (this.kickJustPressed = true),
    );
    const nitro = this.buildPedal(
      `width:56px;height:56px;bottom:${actionY}px;left:150px;background:rgba(61,220,132,0.28);border-color:#3ddc84;font-size:11px`,
      "NITRO",
      () => (this.nitroJustPressed = true),
    );

    const fullscreenButton = this.buildFullscreenButton();

    root.append(gas, brake, punch, kick, nitro, fullscreenButton);
    document.body.appendChild(root);

    this.mountFullscreen();
    this.mountOrientationLock();
    this.tryAutoEnableTilt();
  }

  /** Shows the tilt calibrate/enable button only while paused — kept off the playing screen. */
  setPaused(paused: boolean): void {
    if (this.calibrateButton) this.calibrateButton.style.display = paused ? "block" : "none";
  }

  /**
   * A full-viewport tap target sitting under every button (see `mount`,
   * which layers the buttons on top via z-index), so any tap that doesn't
   * land on a control counts as "pause". A single fire per tap, forwarded
   * to whatever `Game` wires up via `setOnBackgroundTap`.
   */
  private mountBackgroundTapCatcher(): void {
    const catcher = el(
      "div",
      "position:fixed;inset:0;z-index:5;pointer-events:auto;touch-action:none",
    );
    catcher.addEventListener("pointerdown", () => this.onBackgroundTap?.());
    document.body.appendChild(catcher);
  }

  private buildCalibrateButton(): HTMLButtonElement {
    const btn = el(
      "button",
      [
        "position:fixed",
        // Above the pause tint (z-index:20) and clear of the "PAUSED" title,
        // which sits vertically centred.
        "top:120px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:25",
        "pointer-events:auto",
        "appearance:none",
        "cursor:pointer",
        `font:800 17px/1 ${MONO}`,
        "letter-spacing:0.08em",
        "text-transform:uppercase",
        "padding:16px 28px",
        "border-radius:24px",
        "background:#ff9f1c",
        "color:#111",
        "border:2px solid #ff9f1c",
        "box-shadow:0 4px 18px rgba(0,0,0,0.5)",
        "-webkit-touch-callout:none",
        "-webkit-user-select:none",
        "-webkit-tap-highlight-color:transparent",
        // Only shown while paused (see `setPaused`) — kept off the playing screen.
        "display:none",
      ].join(";"),
      "Enable tilt steering",
    );
    btn.addEventListener("click", () => void this.onCalibrateTap());
    return btn;
  }

  /** Starts (or, once granted, re-zeros) tilt. Safe to call with no pending permission gate. */
  private async onCalibrateTap(): Promise<void> {
    if (this.tiltGranted) {
      // Re-zero on next reading, so "straight ahead" tracks however the
      // player is holding the phone right now.
      this.awaitingZero = true;
      return;
    }
    const requestPermission = iosPermissionGate();
    if (requestPermission) {
      try {
        const result = await requestPermission();
        if (result !== "granted") return;
      } catch {
        return;
      }
    }
    this.enableTilt();
  }

  /**
   * Platforms with no permission gate (i.e. not iOS) get tilt immediately.
   * On iOS this also tries — silently, no dialog — relying on
   * `requestTiltPermissionFromGesture` having already been granted from the
   * start screen's click; if that didn't happen, this resolves "denied" with
   * no prompt (a repeat call outside a gesture can't show one) and the
   * pause-menu calibrate button is the fallback.
   */
  private tryAutoEnableTilt(): void {
    const requestPermission = iosPermissionGate();
    if (!requestPermission) {
      this.enableTilt();
      return;
    }
    requestPermission()
      .then((result) => {
        if (result === "granted") this.enableTilt();
      })
      .catch(() => {});
  }

  private enableTilt(): void {
    if (this.tiltGranted) return;
    this.tiltGranted = true;
    this.awaitingZero = true;
    window.addEventListener("deviceorientation", this.onOrientation);
    if (this.calibrateButton) this.calibrateButton.textContent = "Tap to re-center";
  }

  private readonly onOrientation = (event: DeviceOrientationEvent): void => {
    const raw = tiltDegrees(event);
    if (this.awaitingZero) {
      this.tiltZero = raw;
      this.awaitingZero = false;
    }
    const relative = raw - this.tiltZero;
    this.steerValue = Math.max(-1, Math.min(1, relative / MAX_TILT_DEG));
  };

  private buildPedal(
    css: string,
    label: string,
    onDown: () => void,
    onUp?: () => void,
  ): HTMLDivElement {
    const pedal = el(
      "div",
      [
        "position:fixed",
        css,
        "border-radius:50%",
        "border:3px solid",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        `font:800 15px/1 ${DISPLAY}`,
        "letter-spacing:0.08em",
        "color:#fff",
        "user-select:none",
        // A long press on plain text is iOS Safari's cue for the
        // copy/lookup/select-all callout — these two suppress it and the
        // grey tap-flash, on iOS and Android respectively.
        "-webkit-touch-callout:none",
        "-webkit-user-select:none",
        "-webkit-tap-highlight-color:transparent",
        "touch-action:none",
        "pointer-events:auto",
      ].join(";"),
      label,
    );
    const setDown = (down: boolean): void => {
      if (down) onDown();
      else onUp?.();
      pedal.style.filter = down ? "brightness(1.6)" : "";
    };
    pedal.addEventListener("pointerdown", (event) => {
      pedal.setPointerCapture(event.pointerId);
      setDown(true);
    });
    pedal.addEventListener("pointerup", () => setDown(false));
    pedal.addEventListener("pointercancel", () => setDown(false));
    return pedal;
  }

  /**
   * A persistent enter/exit toggle, not just an "exit" button — the Android
   * back button (and iOS's own gesture) drops fullscreen without going
   * through our exit button, and a button that only ever shows "exit" would
   * then vanish with no way back in. Always visible; its icon just tracks
   * current state.
   */
  private buildFullscreenButton(): HTMLButtonElement {
    const btn = el(
      "button",
      [
        "position:fixed",
        "top:14px",
        "right:14px",
        "pointer-events:auto",
        "appearance:none",
        "cursor:pointer",
        `font:700 16px/1 ${MONO}`,
        "padding:8px 10px",
        "border-radius:8px",
        "background:rgba(0,0,0,0.5)",
        "color:#fff",
        "border:2px solid rgba(255,255,255,0.6)",
        "-webkit-touch-callout:none",
        "-webkit-user-select:none",
        "-webkit-tap-highlight-color:transparent",
      ].join(";"),
      "⛶",
    );
    // iPhone Safari (and every other iOS browser — Apple requires them all
    // to run on WebKit) has no Fullscreen API at all: requestFullscreen is
    // undefined, so the usual toggle would silently do nothing. The only
    // real "fullscreen" on iOS is launching from a home-screen icon, so
    // that's what the button explains there instead of pretending to work.
    if (!fullscreenSupported()) {
      btn.addEventListener("click", () => this.showToast("On iPhone: Share ↗ → Add to Home Screen for fullscreen"));
      return btn;
    }
    const sync = (): void => {
      btn.textContent = document.fullscreenElement ? "⤡" : "⛶";
    };
    btn.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    });
    document.addEventListener("fullscreenchange", sync);
    return btn;
  }

  /** A brief, self-dismissing message — used for the one-off iOS fullscreen explanation. */
  private showToast(message: string): void {
    const toast = el(
      "div",
      [
        "position:fixed",
        "top:60px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:60",
        "max-width:80vw",
        "text-align:center",
        `font:600 13px/1.4 ${DISPLAY}`,
        "padding:10px 16px",
        "border-radius:10px",
        "background:rgba(0,0,0,0.85)",
        "color:#fff",
      ].join(";"),
      message,
    );
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4000);
  }

  /**
   * Best-effort hard lock to landscape (Android Chrome, once fullscreen —
   * most browsers refuse `lock` outside fullscreen). The generic "landscape"
   * type, not "landscape-primary", is what allows the OS to still flip
   * between the two landscape orientations freely while refusing portrait
   * outright.
   *
   * No browser lets a page force orientation from script outside fullscreen
   * (notably iOS Safari never allows it at all), so as a fallback this also
   * blocks play behind a "rotate your phone" overlay whenever the physical
   * orientation is portrait — the layout itself is never asked to reflow
   * into a portrait shape.
   */
  private mountOrientationLock(): void {
    const tryLock = (): void => {
      const orientation = screen.orientation as unknown as { lock?: (type: string) => Promise<void> };
      orientation?.lock?.("landscape")?.catch(() => {});
    };
    document.addEventListener("fullscreenchange", tryLock);
    tryLock();

    const overlay = el(
      "div",
      [
        "position:fixed",
        "inset:0",
        "z-index:50",
        "display:none",
        "align-items:center",
        "justify-content:center",
        "background:#000",
        "color:#fff",
        "text-align:center",
        "padding:24px",
        "box-sizing:border-box",
        `font:700 18px/1.5 ${DISPLAY}`,
      ].join(";"),
      "Rotate your phone to landscape to play",
    );
    document.body.appendChild(overlay);
    const syncOverlay = (): void => {
      overlay.style.display = window.matchMedia("(orientation: portrait)").matches ? "flex" : "none";
    };
    syncOverlay();
    window.addEventListener("resize", syncOverlay);
    window.addEventListener("orientationchange", syncOverlay);
  }

  /**
   * Landscape play should fill the screen, browser chrome and all — the
   * Fullscreen API is the only way a page can ask for that. It requires a
   * user gesture, so this listens for the player's very first tap (whatever
   * it lands on) rather than firing on load, and again on every rotation
   * into landscape in case the player started portrait. A rotation isn't
   * always accepted as a gesture by every browser; failures are silent and
   * the game is fully playable windowed regardless.
   */
  private mountFullscreen(): void {
    if (!fullscreenSupported()) return;
    const tryEnter = (): void => {
      if (document.fullscreenElement) return;
      if (!window.matchMedia("(orientation: landscape)").matches) return;
      document.documentElement.requestFullscreen?.().catch(() => {});
    };
    document.addEventListener("pointerdown", tryEnter, { once: true });
    window.addEventListener("orientationchange", () => window.setTimeout(tryEnter, 300));
  }
}
