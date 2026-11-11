import type { CatalogItemSummary, CraftbookTemplateManifest } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type BookItem, orderForYou, seedParamDefaults } from './new-task-meta.js';

describe('seedParamDefaults', () => {
  it('seeds plain declared defaults', () => {
    const schema = {
      properties: {
        intensity: { type: 'string', default: 'medium' },
        dryRun: { type: 'boolean', default: false },
      },
    };
    expect(seedParamDefaults(schema)).toEqual({ intensity: 'medium', dryRun: false });
  });

  it('leaves runtime-template defaults unseeded so the server resolves them', () => {
    const schema = {
      properties: {
        workPath: { type: 'string', default: '{{task.dir}}' },
        focus: { type: 'string', default: 'everything' },
      },
    };
    expect(seedParamDefaults(schema)).toEqual({ focus: 'everything' });
  });

  it('handles a schema without properties', () => {
    expect(seedParamDefaults(undefined)).toEqual({});
    expect(seedParamDefaults({})).toEqual({});
  });
});

function book(id: string, name: string, extra: Partial<CraftbookTemplateManifest> = {}): BookItem {
  const manifest = {
    kind: 'craftbook-template',
    id,
    name,
    description: '',
    tags: [],
    ...extra,
  } as unknown as CraftbookTemplateManifest;
  return { item: { manifest } as unknown as CatalogItemSummary, manifest };
}

describe('orderForYou', () => {
  // Alphabetical, the way the listing arrives.
  const shelf = [
    book('ad-variations', 'A/B Ad Copy Variations', { category: 'marketing' }),
    book('audio-ad-spot', 'Audio Ad Spot', { interests: ['content', 'business'] }),
    book('audit-evidence-pack', 'Audit Evidence Pack', { interests: ['business', 'work'] }),
    book('invoice-generator', 'Invoice Generator', { interests: ['business'] }),
    book('meal-plan', 'Meal Plan', { interests: ['home'] }),
    book('proposal-sow', 'Proposal / Statement of Work', { interests: ['business'] }),
    book('tidy-books', 'Tidy the Books', {
      interests: ['business'],
      connectors: [{ typeId: 'mail-gmail' }],
    }),
  ];

  it('leads a small business with its first project, not the alphabet', () => {
    const ids = orderForYou(shelf, ['business']).map((b) => b.manifest.id);
    expect(ids).toEqual([
      // The welcome's first project for the area.
      'proposal-sow',
      // Written for the area alone, then for it first, then for it second,
      // then only through a category.
      'invoice-generator',
      'audit-evidence-pack',
      'audio-ad-spot',
      'ad-variations',
      // Needs a connector bound before it can run.
      'tidy-books',
    ]);
  });

  it('puts books ready to try ahead of the rest', () => {
    const sampled = book('expense-sheet', 'Expense Sheet', {
      interests: ['business', 'data'],
      samples: [{ id: 'q1', title: 'a quarter of receipts', param: 'source', files: [] }],
    } as Partial<CraftbookTemplateManifest>);
    const ids = orderForYou([...shelf, sampled], ['business'], {
      starterIds: ['ad-variations'],
    }).map((b) => b.manifest.id);
    expect(ids.slice(0, 4)).toEqual([
      'proposal-sow',
      'expense-sheet',
      'ad-variations',
      'invoice-generator',
    ]);
  });

  it('orders by the areas in the order they were picked and never drops one', () => {
    const ids = orderForYou(shelf, ['home', 'business'], {
      needsSetup: () => false,
    }).map((b) => b.manifest.id);
    expect(ids[0]).toBe('proposal-sow');
    expect(ids[1]).toBe('meal-plan');
    expect(ids).toHaveLength(shelf.length);
  });

  it('is empty when no area was picked', () => {
    expect(orderForYou(shelf, [])).toEqual([]);
  });
});
