import type { CatalogItemSummary, CraftbookTemplateManifest } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

export interface CraftbookCatalogArt {
  item: CatalogItemSummary;
  manifest: CraftbookTemplateManifest;
}

/**
 * One in-flight/settled listing per project for the whole surface — a long
 * transcript can hold many receipt cards for the same project, and the
 * composer's attached-task strip reads the same listing; each needs only a
 * manifest lookup.
 */
const projectCraftbooksCache = new Map<
  string,
  Promise<Awaited<ReturnType<typeof api.listProjectCraftbooks>>>
>();

export function useCraftbookCatalogArt(
  projectId: string,
  craftbookId: string | null,
): CraftbookCatalogArt | null {
  const [art, setArt] = useState<CraftbookCatalogArt | null>(null);
  useEffect(() => {
    if (!craftbookId) {
      setArt(null);
      return;
    }
    let cancelled = false;
    let listing = projectCraftbooksCache.get(projectId);
    if (!listing) {
      listing = api.listProjectCraftbooks(projectId);
      projectCraftbooksCache.set(projectId, listing);
      // A failed fetch must not poison the cache for every later lookup.
      listing.catch(() => projectCraftbooksCache.delete(projectId));
    }
    listing
      .then((res) => {
        if (cancelled) return;
        for (const item of res.items ?? []) {
          if (item.manifest.kind === 'craftbook-template' && item.manifest.id === craftbookId) {
            setArt({ item, manifest: item.manifest });
            return;
          }
        }
        setArt(null);
      })
      .catch(() => {
        if (!cancelled) setArt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, craftbookId]);
  return art;
}
