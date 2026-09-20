/**
 * Raw keyboard state tracker. Deliberately generic (no game-specific "actions"
 * schema) so later systems (combat, menus, etc.) can query whatever keys they
 * need without this module having to know about them in advance.
 */
export class InputManager {
  private readonly downKeys = new Set<string>();
  private readonly justPressedKeys = new Set<string>();

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.downKeys.has(event.code)) {
      this.justPressedKeys.add(event.code);
    }
    this.downKeys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.downKeys.delete(event.code);
  };

  isDown(code: string): boolean {
    return this.downKeys.has(code);
  }

  isAnyDown(codes: string[]): boolean {
    return codes.some((code) => this.downKeys.has(code));
  }

  wasJustPressed(code: string): boolean {
    return this.justPressedKeys.has(code);
  }

  /** Call once per fixed physics step, after all systems have queried this step's input. */
  endStep(): void {
    this.justPressedKeys.clear();
  }
}
