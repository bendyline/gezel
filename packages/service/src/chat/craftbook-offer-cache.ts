import type { CatalogService } from '@bendyline/gezel-catalog';
import { listProjectCraftbookOffer } from '../craftbook/applicable.js';
import type { Store } from '../fs/store.js';

type CraftbookOffer = Awaited<ReturnType<typeof listProjectCraftbookOffer>>;

/** How long a project's launchable-craftbook listing serves typing previews. */
export const CRAFTBOOK_OFFER_TTL_MS = 60_000;

/**
 * A project's launchable craftbooks, held for a short while. The composer
 * previews on every pause in typing, and the listing walks the workspace and
 * the git state — far too much per keystroke, and it changes far too rarely
 * to matter within a minute. A failed listing is not kept.
 */
export class CraftbookOfferCache {
  private readonly entries = new Map<string, { at: number; offer: Promise<CraftbookOffer> }>();

  constructor(
    private readonly deps: { catalog: CatalogService; store: Store },
    private readonly ttlMs = CRAFTBOOK_OFFER_TTL_MS,
  ) {}

  get(projectId: string): Promise<CraftbookOffer> {
    const now = Date.now();
    const cached = this.entries.get(projectId);
    if (cached && now - cached.at < this.ttlMs) return cached.offer;
    const offer = listProjectCraftbookOffer(this.deps.catalog, this.deps.store, projectId);
    this.entries.set(projectId, { at: now, offer });
    offer.catch(() => this.entries.delete(projectId));
    return offer;
  }
}
