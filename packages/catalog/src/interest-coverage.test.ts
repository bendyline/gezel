/**
 * Every craftbook and project type the pinned catalog carries must serve at
 * least one interest area, or interests could never bring it forward. The
 * only exceptions are ways of working (gilde's `practice` books: plan,
 * build-loop) and the `general` project type, which serve whatever the
 * person is doing. A gilde release that adds a category, or a book whose
 * category says nothing about its area, fails here until the book declares
 * its `interests` or the map learns the category.
 */

import { interestAreasForCraftbook, interestAreasForProjectType } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CatalogService } from './service.js';

const AREA_NEUTRAL_CRAFTBOOK_CATEGORIES = new Set(['practice']);
const AREA_NEUTRAL_PROJECT_TYPE_CATEGORIES = new Set(['general']);

describe('interest areas against the pinned catalog', () => {
  it('maps every craftbook to an area, except ways of working', async () => {
    const items = await new CatalogService().list('craftbook-template');
    const unmapped = items
      .map(
        (item) => item.manifest as Parameters<typeof interestAreasForCraftbook>[0] & { id: string },
      )
      .filter((manifest) => interestAreasForCraftbook(manifest).length === 0)
      .filter((manifest) => !AREA_NEUTRAL_CRAFTBOOK_CATEGORIES.has(String(manifest.category)))
      .map((manifest) => `${manifest.id} (${manifest.category ?? 'no category'})`);
    expect(unmapped).toEqual([]);
  });

  it('maps every project type to an area, except the general one', async () => {
    const items = await new CatalogService().list('project-type');
    const unmapped = items
      .map(
        (item) =>
          item.manifest as Parameters<typeof interestAreasForProjectType>[0] & { id: string },
      )
      .filter((manifest) => interestAreasForProjectType(manifest).length === 0)
      .filter((manifest) => !AREA_NEUTRAL_PROJECT_TYPE_CATEGORIES.has(String(manifest.category)))
      .map((manifest) => `${manifest.id} (${manifest.category ?? 'no category'})`);
    expect(unmapped).toEqual([]);
  });
});
