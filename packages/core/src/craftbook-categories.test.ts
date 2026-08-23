import { describe, expect, it } from 'vitest';
import {
  CRAFTBOOK_CATEGORY_FAMILY_META,
  CRAFTBOOK_CATEGORY_META,
  CraftbookCategorySchema,
  craftbookCategoryFamily,
  inferCraftbookCategory,
  resolveCraftbookCategory,
} from './craftbook-categories.js';

describe('craftbook categories', () => {
  it('describes every category exactly once, in a declared family', () => {
    const ids = CRAFTBOOK_CATEGORY_META.map((meta) => meta.id);
    expect([...ids].sort()).toEqual([...CraftbookCategorySchema.options].sort());
    expect(new Set(ids).size).toBe(ids.length);
    const families = new Set(CRAFTBOOK_CATEGORY_FAMILY_META.map((family) => family.id));
    for (const meta of CRAFTBOOK_CATEGORY_META) expect(families.has(meta.family)).toBe(true);
  });

  it('prefers the authored category over inference', () => {
    expect(resolveCraftbookCategory({ category: 'personal', tags: ['tests', 'coverage'] })).toBe(
      'personal',
    );
  });

  it('infers a shelf from tags when none is authored', () => {
    expect(resolveCraftbookCategory({ tags: ['tests', 'coverage', 'gallery'] })).toBe(
      'code-quality',
    );
    expect(inferCraftbookCategory(['api', 'rest', 'backend'])).toBe('code-data');
    expect(inferCraftbookCategory(['meals', 'pantry', 'household'])).toBe('personal');
    expect(inferCraftbookCategory(['audio', 'transcription', 'speech-to-text'])).toBe('media');
  });

  it('keeps shared vocabulary from dragging a book onto a code shelf', () => {
    // `pr`, `review`, and `audit` are weak everywhere; the subject tags win.
    expect(inferCraftbookCategory(['pr', 'press-release', 'writing', 'communications'])).toBe(
      'marketing',
    );
    expect(inferCraftbookCategory(['subscriptions', 'finance', 'audit', 'spend', 'report'])).toBe(
      'business',
    );
    expect(inferCraftbookCategory(['research', 'citations', 'audit', 'verification', 'review'])).toBe(
      'research',
    );
  });

  it('ignores presentation-only tags', () => {
    expect(inferCraftbookCategory(['gallery', 'recommended', 'night-shift'])).toBe('other');
    expect(inferCraftbookCategory([])).toBe('other');
    expect(inferCraftbookCategory(undefined)).toBe('other');
  });

  it('normalizes case and whitespace before matching', () => {
    expect(inferCraftbookCategory([' Tests ', 'COVERAGE'])).toBe('code-quality');
  });

  it('reports the family for grouping, defaulting to the ungrouped shelf', () => {
    expect(craftbookCategoryFamily('code-build')).toBe('code');
    expect(craftbookCategoryFamily('personal')).toBe('non-code');
    expect(craftbookCategoryFamily('practice')).toBe('universal');
  });
});
