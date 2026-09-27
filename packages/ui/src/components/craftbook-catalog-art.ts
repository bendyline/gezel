import type { CatalogItemSummary, CraftbookTemplateManifest } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

export interface CraftbookCatalogArt {
  item: CatalogItemSummary;
  manifest: CraftbookTemplateManifest;
}

export interface CraftbookCatalogLookup {
  art: CraftbookCatalogArt | null;
  /** `missing` once a fresh listing has been asked and the book is not in it. */
  status: 'idle' | 'loading' | 'found' | 'missing';
}

type Listing = Awaited<ReturnType<typeof api.listProjectCraftbooks>>;

/**
 * One in-flight/settled listing per project for the whole surface — a long
 * transcript can hold many receipt cards for the same project, and the
 * composer's attached-task strip reads the same listing; each needs only a
 * manifest lookup.
 */
const projectCraftbooksCache = new Map<string, Promise<Listing>>();

function fetchListing(projectId: string): Promise<Listing> {
  const listing = api.listProjectCraftbooks(projectId);
  projectCraftbooksCache.set(projectId, listing);
  // A failed fetch must not poison the cache for every later lookup.
  listing.catch(() => {
    if (projectCraftbooksCache.get(projectId) === listing) projectCraftbooksCache.delete(projectId);
  });
  return listing;
}

function findBook(listing: Listing, craftbookId: string): CraftbookCatalogArt | null {
  for (const item of listing.items ?? []) {
    if (item.manifest.kind === 'craftbook-template' && item.manifest.id === craftbookId) {
      return { item, manifest: item.manifest };
    }
  }
  return null;
}

/**
 * Find a craftbook in the project's listing. A miss in a cached listing asks
 * once more: the cache predates any book installed or written since, and a
 * miss that stuck would hold the composer's Send on "Loading…" until restart.
 */
export function useCraftbookCatalogLookup(
  projectId: string,
  craftbookId: string | null,
): CraftbookCatalogLookup {
  const [lookup, setLookup] = useState<CraftbookCatalogLookup>({ art: null, status: 'idle' });
  useEffect(() => {
    if (!craftbookId) {
      setLookup({ art: null, status: 'idle' });
      return;
    }
    let cancelled = false;
    setLookup((prev) =>
      prev.art?.manifest.id === craftbookId ? prev : { art: null, status: 'loading' },
    );
    const cached = projectCraftbooksCache.get(projectId);
    const settle = (art: CraftbookCatalogArt | null) => {
      if (!cancelled) setLookup({ art, status: art ? 'found' : 'missing' });
    };
    void (async () => {
      try {
        const hit = findBook(await (cached ?? fetchListing(projectId)), craftbookId);
        if (hit || !cached) {
          settle(hit);
          return;
        }
        settle(findBook(await fetchListing(projectId), craftbookId));
      } catch {
        settle(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, craftbookId]);
  return lookup;
}

export function useCraftbookCatalogArt(
  projectId: string,
  craftbookId: string | null,
): CraftbookCatalogArt | null {
  return useCraftbookCatalogLookup(projectId, craftbookId).art;
}
