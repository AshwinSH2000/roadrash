/**
 * The few things every overlay shares: one font stack, one way to make an
 * element with inline styles. Plain DOM `div`s absolutely positioned over
 * the canvas — the confirmed decision for v1's handful of screens; no UI
 * framework.
 */

export const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
export const DISPLAY = '"Helvetica Neue",Helvetica,Arial,sans-serif';

/** Semi-transparent panel background used by every HUD element. */
export const PANEL_BG = "rgba(0,0,0,0.45)";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A full-screen dimmed layer, hidden until shown. */
export function overlay(zIndex: number, dim = 0.6): HTMLDivElement {
  return el(
    "div",
    [
      "position:fixed",
      "inset:0",
      "display:none",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      `background:rgba(0,0,0,${dim})`,
      "color:#fff",
      `font-family:${DISPLAY}`,
      `z-index:${zIndex}`,
    ].join(";"),
  );
}

export function button(label: string, primary: boolean): HTMLButtonElement {
  const b = el(
    "button",
    [
      "appearance:none",
      "cursor:pointer",
      `font:700 18px/1 ${DISPLAY}`,
      "letter-spacing:0.12em",
      "text-transform:uppercase",
      "padding:14px 28px",
      "border-radius:6px",
      primary
        ? "background:#ff9f1c;color:#111;border:2px solid #ff9f1c"
        : "background:transparent;color:#fff;border:2px solid rgba(255,255,255,0.6)",
    ].join(";"),
    label,
  );
  b.addEventListener("mouseenter", () => (b.style.filter = "brightness(1.15)"));
  b.addEventListener("mouseleave", () => (b.style.filter = ""));
  return b;
}

/** m:ss.t, the way a race clock reads. */
export function formatRaceTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function ordinal(position: number): string {
  const suffix =
    position % 100 >= 11 && position % 100 <= 13
      ? "th"
      : ["th", "st", "nd", "rd"][position % 10] ?? "th";
  return `${position}${suffix}`;
}
