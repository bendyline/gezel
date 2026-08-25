import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Which of `refs` name a task that has settled — `complete` or `canceled`.
 *
 * Callers hand in the task refs carried by chat sessions whose task is not
 * in the project's active list; each unknown ref costs one `getTask` read,
 * and the verdict is cached for the life of the mount.
 *
 * Two deliberate behaviours:
 *
 * - **Fail open.** A ref we can't read is reported as unsettled, so a
 *   transient service error hides nothing the user was relying on.
 * - **Only terminal verdicts survive `resetKey`.** A task that was merely
 *   paused when we asked can settle while this stays mounted, so a bump of
 *   `resetKey` re-asks about everything that wasn't already finished.
 */
export function useFinishedTaskRefs(
  refs: readonly string[],
  resetKey?: number | undefined,
): ReadonlySet<string> {
  const verdicts = useRef(new Map<string, boolean>());
  const inFlight = useRef(new Set<string>());
  const [version, setVersion] = useState(0);

  // Sorted, de-duplicated, and joined so a re-render that rebuilds the same
  // array doesn't re-run the lookup effect.
  const key = useMemo(() => [...new Set(refs)].sort().join('\n'), [refs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the invalidation trigger — the body reads a ref, so the bump is the only thing that can re-run it.
  useEffect(() => {
    for (const [ref, finished] of [...verdicts.current]) {
      if (!finished) verdicts.current.delete(ref);
    }
  }, [resetKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the re-ask trigger — the effect above clears the non-terminal verdicts first, and this one must then run again to refill them.
  useEffect(() => {
    const wanted = key ? key.split('\n') : [];
    const unknown = wanted.filter(
      (ref) => !verdicts.current.has(ref) && !inFlight.current.has(ref),
    );
    if (unknown.length === 0) return;
    let cancelled = false;
    for (const ref of unknown) inFlight.current.add(ref);
    void Promise.all(
      unknown.map(async (ref) => {
        try {
          const task = await api.getTaskByRef(ref);
          verdicts.current.set(ref, task.status === 'complete' || task.status === 'canceled');
        } catch {
          verdicts.current.set(ref, false);
        } finally {
          inFlight.current.delete(ref);
        }
      }),
    ).then(() => {
      if (!cancelled) setVersion((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [key, resetKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the recompute trigger for the verdict ref — the body reads the map, not the counter.
  return useMemo(() => {
    const wanted = key ? key.split('\n') : [];
    return new Set(wanted.filter((ref) => verdicts.current.get(ref) === true));
  }, [key, version]);
}
