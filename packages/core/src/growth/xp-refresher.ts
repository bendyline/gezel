/**
 * Coalesces completion-triggered XP updates and runs one refresh at a time.
 * A large task corpus can take longer to scan than the debounce delay; keep
 * only one follow-up per gezel instead of filling the engine's lock queue.
 * Disposal drops queued work without interrupting an already durable refresh.
 *
 * A refresh rescans the gezel's history and every task, so its cost grows
 * with the home. Each gezel therefore waits out a cooldown proportional to
 * its last refresh before the next one: in a small home that is a few seconds,
 * and XP still follows finished work almost at once. In a bulk workflow home
 * (1.4M history events, 117k tasks) one refresh took 3–8 minutes; completions
 * every second kept them running back to back, a fifth of the daemon's main
 * thread for XP nobody was watching (2026-10-27).
 */
import { createLogger } from '../log.js';

const log = createLogger('growth');

/** Long enough to fold a gate loop's burst of step completions into one refresh. */
export const XP_REFRESH_DELAY_MS = 3_000;

/**
 * The share of time one gezel's refreshes may take: after a refresh that ran
 * for `d`, the next one for that gezel waits until `d / XP_REFRESH_DUTY_CYCLE`
 * has passed since it started.
 */
export const XP_REFRESH_DUTY_CYCLE = 0.02;

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
  /** When each gezel may refresh again, from its last refresh's cost. */
  const readyAt = new Map<string, number>();
  let running = false;
  let disposed = false;
  const schedule = (gezelId: string, waitMs: number): void => {
    // Work noted while a refresh is already scheduled folds into it.
    if (timers.has(gezelId)) return;
    const timer = setTimeout(() => {
      timers.delete(gezelId);
      pending.add(gezelId);
      void drain();
    }, waitMs);
    timer.unref?.();
    timers.set(gezelId, timer);
  };
  const cooldownLeft = (gezelId: string): number =>
    Math.max(0, (readyAt.get(gezelId) ?? 0) - Date.now());
  const drain = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && pending.size > 0) {
        const gezelId = pending.values().next().value!;
        pending.delete(gezelId);
        // Work that arrived during this gezel's last refresh waits out the
        // cooldown that refresh earned.
        const wait = cooldownLeft(gezelId);
        if (wait > 0) {
          schedule(gezelId, wait);
          continue;
        }
        const startedAt = Date.now();
        try {
          const state = await opts.refresh(gezelId);
          if (!disposed) opts.onRefreshed(gezelId, state.xp);
        } catch (err) {
          log.warn(`[growth] xp refresh failed for ${gezelId}: ${String(err)}`);
        } finally {
          readyAt.set(gezelId, startedAt + (Date.now() - startedAt) / XP_REFRESH_DUTY_CYCLE);
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    note(gezelId) {
      if (!gezelId || disposed) return;
      schedule(gezelId, Math.max(delay, cooldownLeft(gezelId)));
    },
    dispose() {
      disposed = true;
      pending.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
