import { describe, expect, it } from 'vitest';
import {
  CATALOG_GROUND_TONES,
  CRAFTBOOK_CATEGORY_GROUND,
  PROJECT_TYPE_CATEGORY_GROUND,
  catalogGroundFor,
} from './catalog-ground.js';
import {
  CRAFTBOOK_CATEGORY_FAMILY_META,
  CRAFTBOOK_CATEGORY_META,
  CraftbookCategorySchema,
} from './craftbook-categories.js';
import { ProjectTypeCategorySchema } from './schemas/catalog.js';

describe('catalog grounds', () => {
  it('gives every craftbook and project-type category a known tone', () => {
    const tones = new Set<string>(CATALOG_GROUND_TONES);
    for (const category of CraftbookCategorySchema.options) {
      expect(tones.has(CRAFTBOOK_CATEGORY_GROUND[category])).toBe(true);
    }
    for (const category of ProjectTypeCategorySchema.options) {
      expect(tones.has(PROJECT_TYPE_CATEGORY_GROUND[category])).toBe(true);
    }
  });

  it('gives each code shelf a tone of its own', () => {
    const code = CRAFTBOOK_CATEGORY_META.filter((meta) => meta.family === 'code');
    const tones = code.map((meta) => CRAFTBOOK_CATEGORY_GROUND[meta.id]);
    expect(new Set(tones).size).toBe(tones.length);
  });

  it('never gives two neighboring shelves in the rail the same tone', () => {
    const rail = CRAFTBOOK_CATEGORY_FAMILY_META.flatMap((family) =>
      CRAFTBOOK_CATEGORY_META.filter((meta) => meta.family === family.id).map((meta) => meta.id),
    );
    for (let i = 1; i < rail.length; i += 1) {
      const [before, after] = [rail[i - 1], rail[i]];
      if (!before || !after) continue;
      expect(CRAFTBOOK_CATEGORY_GROUND[before], `${before} beside ${after}`).not.toBe(
        CRAFTBOOK_CATEGORY_GROUND[after],
      );
    }
  });

  it('resolves a craftbook by its authored category, else by its tags', () => {
    expect(catalogGroundFor({ kind: 'craftbook-template', category: 'code-review' })).toBe(
      'terracotta',
    );
    expect(catalogGroundFor({ kind: 'craftbook-template', tags: ['tests', 'coverage'] })).toBe(
      CRAFTBOOK_CATEGORY_GROUND['code-quality'],
    );
  });

  it('falls back to the other tone for a project type without a known category', () => {
    expect(catalogGroundFor({ kind: 'project-type', category: 'game' })).toBe('plum');
    expect(catalogGroundFor({ kind: 'project-type', category: 'from-a-newer-gilde' })).toBe(
      PROJECT_TYPE_CATEGORY_GROUND.other,
    );
  });

  it('leaves kinds whose artwork carries its own ground alone', () => {
    expect(catalogGroundFor({ kind: 'knowledge-catalog' })).toBeUndefined();
    expect(catalogGroundFor({ kind: 'toolset' })).toBeUndefined();
  });
});
