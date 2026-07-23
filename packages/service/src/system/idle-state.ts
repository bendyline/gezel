/**
 * Holds the most recent OS idle reading reported by the Electron shell
 * (`powerMonitor.getSystemIdleTime()`), so the background enrichment loop can
 * gate "the computer is actually idle" — not just "no chat turn in flight".
 *
 * Headless runs (no Electron) never report, so `osIdleSeconds()` returns null,
 * which callers treat as "unknown → don't block on OS idle" (the session-idle
 * gate still applies). A stale reading (older than `STALE_MS`) is also treated
 * as unknown so a crashed reporter doesn't pin the gate open or shut.
 */

const STALE_MS = 90_000;

export class SystemIdleState {
  private idleSeconds: number | null = null;
  private reportedAtMs = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Called by the OS-idle HTTP report. */
  report(idleSeconds: number): void {
    this.idleSeconds = Math.max(0, idleSeconds);
    this.reportedAtMs = this.now();
  }

  /** Latest OS idle seconds, or null when unknown/stale. */
  osIdleSeconds(): number | null {
    if (this.idleSeconds === null) return null;
    if (this.now() - this.reportedAtMs > STALE_MS) return null;
    return this.idleSeconds;
  }
}
