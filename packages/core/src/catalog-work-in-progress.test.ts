import { describe, expect, it } from 'vitest';
import {
  catalogItemUsesConnectors,
  connectorCraftbookIds,
  resolveShowWorkInProgressFeatures,
  visibleCatalogItems,
} from './catalog-work-in-progress.js';
import type { CatalogItemSummary } from './schemas/catalog.js';

function item(manifest: Record<string, unknown>): CatalogItemSummary {
  return {
    sourceId: 'bundled',
    kind: manifest.kind,
    manifest,
  } as unknown as CatalogItemSummary;
}

describe('work-in-progress catalog visibility', () => {
  const plainBook = item({
    kind: 'craftbook-template',
    id: 'plain',
    connectors: [],
  });
  const connectorBook = item({
    kind: 'craftbook-template',
    id: 'social-digest',
    connectors: [{ typeId: 'bluesky-posts', optional: true }],
  });

  it('treats optional connector declarations as connector-backed content', () => {
    expect(catalogItemUsesConnectors(plainBook)).toBe(false);
    expect(catalogItemUsesConnectors(connectorBook)).toBe(true);
    expect(connectorCraftbookIds([plainBook, connectorBook])).toEqual(new Set(['social-digest']));
  });

  it('recognizes connector-backed project types through bases, craftbooks, and schedules', () => {
    const ids = new Set(['social-digest']);
    expect(
      catalogItemUsesConnectors(
        item({
          kind: 'project-type',
          id: 'email',
          extends: 'email',
          craftbooks: [],
          schedules: [],
        }),
        ids,
      ),
    ).toBe(true);
    expect(
      catalogItemUsesConnectors(
        item({
          kind: 'project-type',
          id: 'image-feed',
          extends: 'social-media',
          craftbooks: [],
          schedules: [],
        }),
        ids,
      ),
    ).toBe(true);
    expect(
      catalogItemUsesConnectors(
        item({
          kind: 'project-type',
          id: 'social-feed',
          craftbooks: ['social-digest'],
          schedules: [],
        }),
        ids,
      ),
    ).toBe(true);
    expect(
      catalogItemUsesConnectors(
        item({
          kind: 'project-type',
          id: 'scheduled-feed',
          craftbooks: [],
          schedules: [{ craftbook: 'social-digest' }],
        }),
        ids,
      ),
    ).toBe(true);
  });

  it('filters only while the WIP bucket is disabled', () => {
    expect(visibleCatalogItems([plainBook, connectorBook], false)).toEqual([plainBook]);
    expect(visibleCatalogItems([plainBook, connectorBook], true)).toEqual([
      plainBook,
      connectorBook,
    ]);
  });

  it('defaults on in development and off in releases while respecting explicit choices', () => {
    expect(resolveShowWorkInProgressFeatures(undefined, '0.0.0')).toBe(true);
    expect(resolveShowWorkInProgressFeatures(undefined, '1.26225.1')).toBe(false);
    expect(resolveShowWorkInProgressFeatures(false, '0.0.0')).toBe(false);
    expect(resolveShowWorkInProgressFeatures(true, '1.26225.1')).toBe(true);
  });
});
