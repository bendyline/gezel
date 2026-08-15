import { useCallback, useEffect, useRef, useState } from 'react';

export type BufferedStateUpdate<T> = T | ((current: T) => T);
export type BufferedStateSetter<T> = (update: BufferedStateUpdate<T>) => void;

/**
 * Keep every streamed update in an authoritative ref while publishing at
 * most once per interval to React. Immediate updates cancel the timer and
 * publish the fully reduced value, so lifecycle events and local commands do
 * not race a pending stream fragment.
 */
export function useBufferedState<T>(
  initial: T | (() => T),
  intervalMs: number,
): readonly [T, BufferedStateSetter<T>, BufferedStateSetter<T>] {
  const [rendered, setRendered] = useState(initial);
  const valueRef = useRef(rendered);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const apply = useCallback(
    (update: BufferedStateUpdate<T>, buffered: boolean) => {
      const current = valueRef.current;
      const next = typeof update === 'function' ? (update as (value: T) => T)(current) : update;
      valueRef.current = next;

      if (!buffered) {
        cancelTimer();
        // Publish even when Object.is(current, next): React's rendered value
        // may still trail the authoritative ref while a timer is pending.
        setRendered(next);
        return;
      }
      if (Object.is(current, next) || timerRef.current !== null) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setRendered(valueRef.current);
      }, intervalMs);
    },
    [cancelTimer, intervalMs],
  );

  const setImmediate = useCallback(
    (update: BufferedStateUpdate<T>) => apply(update, false),
    [apply],
  );
  const setBuffered = useCallback((update: BufferedStateUpdate<T>) => apply(update, true), [apply]);

  useEffect(() => cancelTimer, [cancelTimer]);
  return [rendered, setImmediate, setBuffered] as const;
}
