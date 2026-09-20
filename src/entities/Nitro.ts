/**
 * Nitro boost: a bar that fires when full, drains over a fixed time, and
 * refills slowly once empty.
 *
 *   READY (full) --N--> ACTIVE (drains 5 s) --> RECHARGING (fills over 20 s) --> READY
 *
 * Three rules from the spec that shape the code:
 *  - Once fired it drains at the same rate whatever the rider does — braking
 *    does not pause it. So the drain is a pure function of time.
 *  - Only a full bar fires; pressing N while recharging does nothing.
 *  - The bike is boosted for exactly as long as the bar is draining.
 *
 * This object knows nothing about keys or bikes: something calls
 * `tryActivate()` and something else reads `isActive`. The player's controller
 * does the first; `Game` hands the second to the vehicle each step.
 */
export const NITRO_DRAIN_SECONDS = 5;
export const NITRO_RECHARGE_SECONDS = 20;

export enum NitroState {
  READY = "ready",
  ACTIVE = "active",
  RECHARGING = "recharging",
}

export class Nitro {
  private state = NitroState.READY;
  /** 0..1 — full when ready, falling while active, rising while recharging. */
  private level = 1;

  get charge(): number {
    return this.level;
  }

  get current(): NitroState {
    return this.state;
  }

  get isActive(): boolean {
    return this.state === NitroState.ACTIVE;
  }

  get isReady(): boolean {
    return this.state === NitroState.READY;
  }

  /** Fires the boost if the bar is full. Returns whether it did. */
  tryActivate(): boolean {
    if (this.state !== NitroState.READY) return false;
    this.state = NitroState.ACTIVE;
    return true;
  }

  tick(dt: number): void {
    switch (this.state) {
      case NitroState.ACTIVE:
        this.level -= dt / NITRO_DRAIN_SECONDS;
        if (this.level <= 0) {
          this.level = 0;
          this.state = NitroState.RECHARGING;
        }
        break;
      case NitroState.RECHARGING:
        this.level += dt / NITRO_RECHARGE_SECONDS;
        if (this.level >= 1) {
          this.level = 1;
          this.state = NitroState.READY;
        }
        break;
      case NitroState.READY:
        break;
    }
  }

  /** Back to a full bar — for a race restart. */
  reset(): void {
    this.state = NitroState.READY;
    this.level = 1;
  }
}
