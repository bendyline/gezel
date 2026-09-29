import { createLogger } from '@bendyline/gezel';

const log = createLogger('growth');

/** Long enough to fold a gate loop's burst of step completions into one refresh. */
export const XP_REFRESH_DELAY_MS = 3_000;

export interface XpRefresher {
  /** Schedule a refresh for the gezel credited with finished work. */
  note(gezelId: string | undefined): void;
  dispose(): void;
}

/**
 * Keeps XP current as work lands. XP is recomputed from the task corpus, and
 * that used to happen only on the daily sweep or a stale sheet read, so a
 * gezel who had just finished a step still showed 0 XP. A completion
 * schedules a signals-only refresh for its gezel; bursts coalesce per gezel.
 */
export function createXpRefresher(opts: {
  refresh: (gezelId: string) => Promise<{ xp: number }>;
  onRefreshed: (gezelId: string, xp: number) => void;
  delayMs?: number;
}): XpRefresher {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const delay = opts.delayMs ?? XP_REFRESH_DELAY_MS;
  return {
    note(gezelId) {
      if (!gezelId) return;
      clearTimeout(timers.get(gezelId));
      const timer = setTimeout(() => {
        timers.delete(gezelId);
        opts
          .refresh(gezelId)
          .then((state) => opts.onRefreshed(gezelId, state.xp))
          .catch((err) => log.warn(`[growth] xp refresh failed for ${gezelId}: ${String(err)}`));
      }, delay);
      timer.unref?.();
      timers.set(gezelId, timer);
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
