import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Subscribes the debug-mode flag (`config.debugMode`) into a component.
 *
 * Gates developer surfaces that are not designed for ordinary users — the
 * Benchmarks panel is the current one. Mirrors {@link useShowAdvancedFeatures}
 * and listens for `gezel:config-updated`, so flipping the toggle in Settings
 * takes effect without a reload.
 */
export function useDebugMode(): boolean {
  const [on, setOn] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setOn(cfg.debugMode ?? false);
      })
      .catch(() => {});
    const onConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { debugMode?: boolean } | undefined;
      if (detail && typeof detail.debugMode === 'boolean') setOn(detail.debugMode);
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:config-updated', onConfigUpdated);
    };
  }, []);

  return on;
}
