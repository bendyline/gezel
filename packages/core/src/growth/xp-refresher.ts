/**
 * Coalesces completion-triggered XP updates and runs one refresh at a time.
 * A large task corpus can take longer to scan than the debounce delay; keep
 * only one follow-up per gezel instead of filling the engine's lock queue.
 * Disposal drops queued work without interrupting an already durable refresh.
 */
import { createLogger } from '../log.js';

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
  const pending = new Set<string>();
  let running = false;
  let disposed = false;
  const drain = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && pending.size > 0) {
        const gezelId = pending.values().next().value!;
        pending.delete(gezelId);
        try {
          const state = await opts.refresh(gezelId);
          if (!disposed) opts.onRefreshed(gezelId, state.xp);
        } catch (err) {
          log.warn(`[growth] xp refresh failed for ${gezelId}: ${String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    note(gezelId) {
      if (!gezelId || disposed) return;
      clearTimeout(timers.get(gezelId));
      const timer = setTimeout(() => {
        timers.delete(gezelId);
        pending.add(gezelId);
        void drain();
      }, delay);
      timer.unref?.();
      timers.set(gezelId, timer);
    },
    dispose() {
      disposed = true;
      pending.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
