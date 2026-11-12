import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function whose identity never changes but which always calls the latest
 * `callback`. For handlers passed to memoized rows: a fresh closure per
 * render would make every row redraw on every parent render. Call it from
 * events and effects, never during render (it sees the previous render's
 * callback until the layout phase).
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
