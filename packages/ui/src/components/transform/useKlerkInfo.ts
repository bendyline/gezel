import type { GezelSummary } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

/**
 * Resolve the configured Klerk gezel's summary (name + poppetje) for the
 * transformation dialog's "Transform with {Klerk}" button. One fetch per
 * mount — the dialog is short-lived, and a stale pointer just falls back
 * to the generic "Transform with AI" label.
 */
export function useKlerkInfo(): GezelSummary | null {
  const [klerk, setKlerk] = useState<GezelSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await api.getConfig();
        if (!config.klerkGezelId) return;
        const { gezels } = await api.listGezels();
        const found = gezels.find((g) => g.id === config.klerkGezelId);
        if (!cancelled && found) setKlerk(found);
      } catch {
        // Fallback label handles it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return klerk;
}
