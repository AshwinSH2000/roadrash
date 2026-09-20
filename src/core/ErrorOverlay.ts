/**
 * Puts fatal errors on the screen instead of only in the console.
 *
 * Both ways this app can die are otherwise silent: an exception thrown inside
 * the requestAnimationFrame callback stops the loop being rescheduled, leaving
 * a correctly-rendered but completely frozen frame on screen, and a failure
 * during bootstrap leaves nothing but black. In both cases the game looks
 * "stuck" or "unresponsive" rather than broken, which is very easy to
 * misdiagnose as a gameplay or input bug.
 */

let overlay: HTMLDivElement | null = null;

export function showFatalError(context: string, error: unknown): void {
  console.error(`[fatal] ${context}:`, error);

  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : "";

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:1000",
      "overflow:auto",
      "padding:32px",
      "box-sizing:border-box",
      "font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace",
      "color:#ffd7d7",
      "background:rgba(40,0,0,0.92)",
      "white-space:pre-wrap",
    ].join(";");
    document.body.appendChild(overlay);
  }

  overlay.textContent = [
    `FATAL — ${context}`,
    "",
    detail,
    "",
    stack,
  ].join("\n");
}
