import {
  isCapacityDeniedError,
  isEngineBusyError,
} from '@bendyline/gezel-inference/internal/providers/native/capacity-broker';

/**
 * How long a handoff waits before its second and third send when the engine
 * refused the turn instead of running it.
 *
 * A refusal means the request never reached a model: the engine was still
 * unloading another model, or was busy serving one. Three sends 40 ms apart
 * all met the same refusal, and the task paused for help 0.7 s before the
 * memory it wanted came free (default/2, 2026-11-09). The provider pool now
 * waits for a teardown it started itself; this covers what it cannot see,
 * such as another program releasing the graphics card.
 */
const ENGINE_REFUSAL_RETRY_DELAYS_MS = [2_000, 8_000] as const;

// A refusal rewrapped on its way up keeps the pool's wording but not its code.
const ENGINE_REFUSAL_MESSAGE_RE = /^Not enough (?:graphics |unified |free )?memory\b/i;

/** Whether `err` is the engine declining to start a turn, as opposed to a turn that failed. */
export function isEngineRefusal(err: unknown): boolean {
  if (isEngineBusyError(err)) return true;
  if (isCapacityDeniedError(err)) {
    // A model already running with too small a window needs an engine
    // restart; waiting does not change it.
    return (err as { reason?: unknown }).reason !== 'resident-below-minimum';
  }
  const message = err instanceof Error ? err.message : String(err);
  return ENGINE_REFUSAL_MESSAGE_RE.test(message.trim());
}

/** Milliseconds to wait after failed send number `attempt` (1-based); 0 for a turn that ran and failed. */
export function handoffRetryDelayMs(err: unknown, attempt: number): number {
  if (!isEngineRefusal(err)) return 0;
  const index = Math.min(Math.max(attempt, 1), ENGINE_REFUSAL_RETRY_DELAYS_MS.length) - 1;
  return ENGINE_REFUSAL_RETRY_DELAYS_MS[index] ?? 0;
}
