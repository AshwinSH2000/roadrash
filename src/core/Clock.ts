export const FIXED_DT = 1 / 60;
const MAX_FRAME_DELTA = 0.25;

export class FixedStepAccumulator {
  private lastTime: number | null = null;
  private accumulator = 0;
  private lastFrameDelta = 0;

  /** Real seconds elapsed in the frame most recently begun — for render-only smoothing. */
  get frameDelta(): number {
    return this.lastFrameDelta;
  }

  /** Call once per animation frame; returns the number of fixed steps to run this frame. */
  beginFrame(now: number): number {
    if (this.lastTime === null) {
      this.lastTime = now;
      this.lastFrameDelta = 0;
      return 0;
    }
    const frameDelta = Math.min((now - this.lastTime) / 1000, MAX_FRAME_DELTA);
    this.lastTime = now;
    this.lastFrameDelta = frameDelta;
    this.accumulator += frameDelta;

    let steps = 0;
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      steps++;
    }
    return steps;
  }

  /** Interpolation factor in [0, 1) between the previous and current physics state. */
  get alpha(): number {
    return this.accumulator / FIXED_DT;
  }
}
