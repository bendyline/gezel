import { useEffect, useState } from 'react';

/**
 * Below this window width the app gives the work the room: the navigation
 * rail folds to icons and a project's docked board steps aside on the tabs
 * that need the width (Tasks, Settings). At 1024 x 700 the rail took 23% of
 * the window while a task's detail was 120 px wide, its title wrapped to
 * three lines and its status keys were cut off.
 */
export const NARROW_WINDOW_PX = 1200;

/** True while the window is narrower than `threshold` CSS pixels. */
export function useNarrowWindow(threshold = NARROW_WINDOW_PX): boolean {
  const query = `(max-width: ${threshold - 0.02}px)`;
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setNarrow(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return narrow;
}
