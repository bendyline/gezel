import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Subscribes the "show advanced features" flag (config.showAdvancedFeatures)
 * into a component so power-user surfaces (currently the sidebar's "Scripts"
 * area link) can be gated on it.
 *
 * Listens for the `gezel:config-updated` custom event so the toggle in
 * SettingsView → About → Advanced propagates live to the sidebar without a
 * route change or manual reload.
 */
export function useShowAdvancedFeatures(): boolean {
  const [on, setOn] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setOn(cfg.showAdvancedFeatures ?? false);
      })
      .catch(() => {});
    const onConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { showAdvancedFeatures?: boolean } | undefined;
      if (detail && typeof detail.showAdvancedFeatures === 'boolean') {
        setOn(detail.showAdvancedFeatures);
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
