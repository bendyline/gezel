/**
 * Holds the most recent OS idle reading reported by the Electron shell
 * (`powerMonitor.getSystemIdleTime()`), so the background enrichment loop can
 * gate "the computer is actually idle" — not just "no chat turn in flight".
 *
 * Headless runs (no Electron) never report, so `osIdleSeconds()` returns null,
 * which callers treat as "unknown → don't block on OS idle" (the session-idle
 * gate still applies). A stale reading (older than `STALE_MS`) is also treated
 * as unknown so a crashed reporter doesn't pin the gate open or shut.
 *
 * The boot grace exists because "unknown → idle" is exactly wrong in the
 * minutes after a daemon starts. A machine service boots at login (or at
 * install time), never hears an idle report, and used to conclude the user
 * was away — so index enrichment fired one-shot completions ~20s after
 * boot, which cold-loaded a multi-GB local model while the user was
 * actively logging in / installing. With no evidence either way, the
 * honest reading of "just booted" is "someone probably just started this
 * machine"; background work that needs the user to be away waits out the
 * grace. Any real report ends the grace immediately (the desktop is
 * connected and the normal gate takes over), and explicit windows like
 * Night Shift bypass it at the caller.
 */

const STALE_MS = 90_000;
const UNREPORTED_BOOT_GRACE_MS = 30 * 60_000;

export class SystemIdleState {
  private idleSeconds: number | null = null;
  private reportedAtMs = 0;
  private everReported = false;
  private readonly startedAtMs: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAtMs = now();
  }

  /** Called by the OS-idle HTTP report. */
  report(idleSeconds: number): void {
    this.idleSeconds = Math.max(0, idleSeconds);
    this.reportedAtMs = this.now();
    this.everReported = true;
  }

  /** Latest OS idle seconds, or null when unknown/stale. */
  osIdleSeconds(): number | null {
    if (this.idleSeconds === null) return null;
    if (this.now() - this.reportedAtMs > STALE_MS) return null;
    return this.idleSeconds;
  }

  /**
   * True while this daemon has never received an idle report AND is young
   * enough that "the machine just started" is the likeliest explanation.
   * Deferrable background work treats this as NOT idle.
   */
  unreportedBootGraceActive(): boolean {
    if (this.everReported) return false;
    return this.now() - this.startedAtMs < UNREPORTED_BOOT_GRACE_MS;
  }
}
