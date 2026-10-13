import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { MODEL_CFG_DEFAULTS } from './sd-cpp.js';

describe('sd-server settings against the pinned catalog', () => {
  // Flux-flow models carry their guidance separately and burn at sd-server's
  // default CFG. Their entries were once dropped while the catalog still
  // offered the models for download.
  it('runs every Flux model the catalog offers at CFG 1', async () => {
    const catalog = new CatalogService([new BundledSource()]);
    const fluxIds = (await catalog.list('image-model'))
      .map((item) => item.manifest.id)
      .filter((id) => id.startsWith('flux-'));
    expect(fluxIds.length).toBeGreaterThan(0);
    for (const id of fluxIds) expect(MODEL_CFG_DEFAULTS.get(id), id).toBe(1);
  });
});
