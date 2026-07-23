/**
 * Process-wide debug flag.
 *
 * Subsystems hold a shared reference and read `isEnabled()` at the
 * point of logging so a config flip — via `PUT /api/config` —
 * propagates instantly without re-spawning anything. The flag never
 * touches disk itself; the source of truth is `GezelConfig.debugMode`
 * in `~/.gezel/config.json`, re-read on service boot and on every
 * config PUT.
 */
export class DebugFlag {
  private _enabled: boolean;

  constructor(initial = false) {
    this._enabled = initial;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  set(next: boolean): void {
    this._enabled = next === true;
  }
}
