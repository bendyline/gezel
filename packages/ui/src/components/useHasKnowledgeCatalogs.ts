import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { MODEL_INVENTORY_CHANGED_EVENT, changedInventoryKey } from '../model-inventory.js';

/**
 * Gate for the Knowledge area: true once the user has ≥1 registered catalog.
 * The sidebar link and the deep-link route both read this, so the area
 * appears the moment a catalog is installed and vanishes when the last one
 * is removed. Surfaces that change the registry announce it on the shared
 * inventory bus (`announceInventoryChanged('knowledge')`).
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
    const onChanged = (event: Event) => {
      if (changedInventoryKey(event) === 'knowledge') refresh();
    };
    refresh();
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    };
  }, []);
  return has;
}
