/**
 * What the main process does when the window's renderer dies.
 *
 * It used to log the crash (in dev builds only) and nothing else, so the
 * window sat on its bare sage background until someone quit the app: a renderer
 * that crashed at 01:47 with exit code 5 left the window green for five hours
 * (2026-10-10). A crash is answered with a reload, a few times; a renderer that
 * keeps dying stops being reloaded so a crash loop cannot spin the machine.
 */
export class RendererRecovery {
  private crashes: number[] = [];
  private readonly maxReloads: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { maxReloads?: number; windowMs?: number; now?: () => number } = {}) {
    this.maxReloads = opts.maxReloads ?? 3;
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Whether to reload after a renderer exit with Electron's `reason`. */
  shouldReload(reason: string): boolean {
    if (reason === 'clean-exit') return false;
    const now = this.now();
    this.crashes = this.crashes.filter((at) => now - at < this.windowMs);
    this.crashes.push(now);
    return this.crashes.length <= this.maxReloads;
  }
}

/**
 * The renderer's memory, logged only when it grows past the last logged level
 * by a step. Nothing recorded why the 01:47 renderer died; exit code 5 is a
 * Chromium fatal check, most often the page running out of memory after a
 * night of live updates. A handful of lines a night is enough to tell a leak
 * from a one-off.
 */
export class RendererMemoryLog {
  private loggedMb = 0;

  constructor(private readonly stepMb = 256) {}

  /** The line to log for a reading, or null when it is not a new high step. */
  reading(workingSetMb: number): string | null {
    if (workingSetMb < this.loggedMb + this.stepMb) return null;
    this.loggedMb = workingSetMb;
    return `[renderer] memory ${Math.round(workingSetMb)} MB`;
  }

  /** A reload starts a fresh renderer, so its growth is measured from zero. */
  reset(): void {
    this.loggedMb = 0;
  }
}
