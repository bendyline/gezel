import { type GezelConfig, createLogger, nowIso } from '@bendyline/gezel';

const log = createLogger('first-run');

/** How often a held install looks again; the first-use hold answers from cache. */
const RECHECK_MS = 60_000;

export interface OptionalDownloadsOptions {
  readConfig: () => Promise<GezelConfig>;
  writeConfig: (patch: Partial<GezelConfig>) => Promise<unknown>;
  /** The first-use hold background indexing waits on. */
  firstUseHeld: () => Promise<boolean>;
  /** Downloads every install starts at boot: the media-search model. */
  startShared: () => Promise<void>;
  /** Downloads first run deferred: the image reader its install skipped. */
  startDeferred: () => Promise<void>;
}

/**
 * Downloads a new install does not need for its first project: the image
 * reader a chat model that cannot see gets, and the media-search model. Both
 * started within minutes of "Fetch my tools" and shared the connection with
 * the model the person tapped for: the key said 6.3 GB and about 10 minutes,
 * first run fetched 12 GB and took 24 (2026-10-12).
 *
 * They wait until the first project the person asked for has finished, or the
 * first-use hold lets background work start, whichever comes first. An
 * established install (no `firstUseAt`) is never held. The deferred image
 * reader runs once per install, so a reader someone removed is not pulled
 * again at the next boot.
 */
export class OptionalDownloads {
  private readonly opts: OptionalDownloadsOptions;
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: OptionalDownloadsOptions) {
    this.opts = opts;
  }

  /** At boot: start now, or wait for the first project. */
  async boot(): Promise<void> {
    if (await this.held()) {
      log.info('[first-run] optional downloads wait for the first project');
      this.schedule();
      return;
    }
    await this.release('boot');
  }

  /** The first project the person asked for finished. */
  async firstProjectDone(): Promise<void> {
    const config = await this.opts.readConfig().catch(() => null);
    if (config && !config.onboarding?.firstProjectDoneAt) {
      await this.opts
        .writeConfig({ onboarding: { ...config.onboarding, firstProjectDoneAt: nowIso() } })
        .catch((err: unknown) =>
          log.warn(`[first-run] could not record the first project: ${String(err)}`),
        );
    }
    await this.release('the first project finished');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async held(): Promise<boolean> {
    const config = await this.opts.readConfig().catch(() => null);
    if (!config?.firstUseAt || config.onboarding?.firstProjectDoneAt) return false;
    return this.opts.firstUseHeld().catch(() => false);
  }

  private schedule(): void {
    if (this.stopped || this.started) return;
    this.timer = setTimeout(() => void this.tick(), RECHECK_MS);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.started || this.stopped) return;
    if (await this.held()) {
      this.schedule();
      return;
    }
    await this.release('the first-use hold released');
  }

  private async release(why: string): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const config = await this.opts.readConfig().catch(() => null);
    const deferred = Boolean(config?.firstUseAt) && !config?.onboarding?.optionalDownloadsAt;
    if (why !== 'boot') log.info(`[first-run] optional downloads start: ${why}`);
    await this.opts
      .startShared()
      .catch((err: unknown) => log.warn(`[first-run] media download failed: ${String(err)}`));
    if (!deferred || !config) return;
    await this.opts
      .writeConfig({ onboarding: { ...config.onboarding, optionalDownloadsAt: nowIso() } })
      .catch(() => {});
    await this.opts
      .startDeferred()
      .catch((err: unknown) =>
        log.warn(`[first-run] image reader download failed: ${String(err)}`),
      );
  }
}
