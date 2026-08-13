import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Live view of the UI/CLI-only work-in-progress feature bucket. The default
 * stays false while config is loading or unavailable; this gate is for
 * discoverability only and deliberately does not change service capability.
 */
export function useShowWorkInProgressFeatures(): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((config) => {
        if (!cancelled) setOn(config.showWorkInProgressFeatures === true);
      })
      .catch(() => {});

    const onConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { showWorkInProgressFeatures?: boolean }
        | undefined;
      if (typeof detail?.showWorkInProgressFeatures === 'boolean') {
        setOn(detail.showWorkInProgressFeatures);
      }
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:config-updated', onConfigUpdated);
    };
  }, []);

  return on;
}
