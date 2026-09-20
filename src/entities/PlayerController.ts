import type { InputManager } from "../core/InputManager";
import type { Bike } from "./Bike";
import type { Driver, Racer } from "./Racer";
import type { CombatSystem } from "../combat/CombatSystem";
import { AttackKind } from "../combat/AttackDefinitions";
import type { Nitro } from "./Nitro";

const THROTTLE_KEYS = ["KeyW", "ArrowUp"];
const BRAKE_KEYS = ["KeyS", "ArrowDown"];
const STEER_LEFT_KEYS = ["KeyA", "ArrowLeft"];
const STEER_RIGHT_KEYS = ["KeyD", "ArrowRight"];
const PUNCH_KEY = "KeyP";
const KICK_KEY = "KeyK";
const NITRO_KEY = "KeyN";

/**
 * Maps raw keyboard input to bike throttle/steer input each fixed physics step.
 *
 * Implements the same `Driver` interface the opponent AI does, so the game
 * loop drives all six riders through one code path and the player's bike has
 * no capability the bots lack (or vice versa).
 */
export class PlayerController implements Driver {
  constructor(
    private readonly input: InputManager,
    private readonly bike: Bike,
    private readonly combat: CombatSystem,
    private readonly self: Racer,
    private readonly nitro: Nitro,
  ) {}

  tick(): void {
    // Same entry point the AI's combat behaviour will use next phase.
    if (this.input.wasJustPressed(PUNCH_KEY)) this.combat.request(this.self, AttackKind.PUNCH);
    if (this.input.wasJustPressed(KICK_KEY)) this.combat.request(this.self, AttackKind.KICK);
    if (this.input.wasJustPressed(NITRO_KEY)) this.nitro.tryActivate();

    const throttle = this.input.isAnyDown(THROTTLE_KEYS) ? 1 : 0;
    const brake = this.input.isAnyDown(BRAKE_KEYS) ? 1 : 0;
    const steerLeft = this.input.isAnyDown(STEER_LEFT_KEYS) ? 1 : 0;
    const steerRight = this.input.isAnyDown(STEER_RIGHT_KEYS) ? 1 : 0;

    const throttleInput = throttle - brake;
    const steerInput = steerRight - steerLeft;

    this.bike.setInput(throttleInput, steerInput);
  }
}
