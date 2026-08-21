import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Gate for the Knowledge area: true once the user has ≥1 registered catalog.
 * The sidebar link and the deep-link route both read this, so the area
 * appears the moment a catalog is installed and vanishes when the last one
 * is removed. Surfaces that change the registry dispatch
 * `gezel:knowledge-catalogs-updated` to refresh every listener.
 */
export function useHasKnowledgeCatalogs(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      api
        .listKnowledgeCatalogs()
        .then((r) => {
          if (!cancelled) setHas(r.catalogs.length > 0);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('gezel:knowledge-catalogs-updated', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:knowledge-catalogs-updated', refresh);
    };
  }, []);
  return has;
}
