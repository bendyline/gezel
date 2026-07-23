import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Subscribes the "boring mode" flag (config.roleBasedNameOnlyMode) into
 * a component so name-rendering chokepoints can pass it to `displayName`.
 *
 * Listens for the `gezel:config-updated` custom event so a toggle in
 * SettingsView propagates live to every mounted name-renderer without
 * a route change or manual reload.
 */
export function useRoleBasedNameOnlyMode(): boolean {
  const [on, setOn] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setOn(cfg.roleBasedNameOnlyMode ?? false);
      })
      .catch(() => {});
    const onConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { roleBasedNameOnlyMode?: boolean } | undefined;
      if (detail && typeof detail.roleBasedNameOnlyMode === 'boolean') {
        setOn(detail.roleBasedNameOnlyMode);
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
