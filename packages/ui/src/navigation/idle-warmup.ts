import type { RecentTab } from '@bendyline/gezel';
import { peekRead } from '../data/api-reads.js';
import { destinationFor } from './destinations.js';

/**
 * After the shell is up, load the code of the destinations a person most
 * likely opens next, one per idle period, so their first visit does not wait
 * on a megabyte of script. Destinations share most of their code (the editor,
 * Squisq's renderer), so the first warm-up does most of the work.
 *
 * It yields to everything that matters more: it waits for the browser to be
 * idle, stops while the window is hidden, and holds off while a turn is
 * running so it never competes with a streaming reply.
 */

const START_AFTER_MS = 2_000;
const IDLE_TIMEOUT_MS = 5_000;
const BUSY_RETRY_MS = 10_000;

const LIKELY_NEXT: RecentTab[] = [
  { kind: 'area', area: 'projects' },
  { kind: 'area', area: 'tasks' },
  { kind: 'area', area: 'gezels' },
  { kind: 'area', area: 'settings' },
].map((tab) => ({ at: 0, order: 0, ...tab }) as RecentTab);

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 200);
  return () => window.clearTimeout(handle);
}

function turnRunning(): boolean {
  return (peekRead('listInflightTurns')?.inflight.length ?? 0) > 0;
}

/** Start warming. `current` names what is on screen now, which needs no warming. */
export function startIdleWarmup(current: () => RecentTab | null): () => void {
  // Under Vitest a warm-up would import whole views beside the test's mocks.
  if (import.meta.env.MODE === 'test') return () => {};
  const queue = [...LIKELY_NEXT];
  let cancel: (() => void) | null = null;
  let stopped = false;

  const step = () => {
    cancel = null;
    if (stopped) return;
    if (document.hidden || turnRunning()) {
      const timer = window.setTimeout(schedule, BUSY_RETRY_MS);
      cancel = () => window.clearTimeout(timer);
      return;
    }
    const shownKey = destinationFor(current()).key;
    let next = queue.shift();
    while (next && destinationFor(next).key === shownKey) next = queue.shift();
    if (!next) return;
    void destinationFor(next)
      .load()
      .catch(() => {})
      .finally(schedule);
  };
  const schedule = () => {
    if (stopped || queue.length === 0) return;
    cancel = whenIdle(step);
  };

  const start = window.setTimeout(schedule, START_AFTER_MS);
  return () => {
    stopped = true;
    window.clearTimeout(start);
    cancel?.();
  };
}
