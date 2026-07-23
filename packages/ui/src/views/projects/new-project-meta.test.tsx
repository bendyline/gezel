import type { CatalogItemSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { PROJECT_CATEGORIES, PROJECT_KINDS, categorizeCatalogType } from './new-project-meta.js';

function summaryFor(manifest: Record<string, unknown>): CatalogItemSummary {
  return {
    sourceId: 'bundled',
    kind: 'project-type',
    manifest: { kind: 'project-type', tags: [], ...manifest },
  } as never;
}

describe('categorizeCatalogType', () => {
  it('prefers the declared manifest category', () => {
    const item = summaryFor({ id: 'design-scheme', category: 'creative', tags: ['language'] });
    expect(categorizeCatalogType(item)).toBe('creative');
  });

  it('falls back to a keyword heuristic for undeclared manifests', () => {
    expect(categorizeCatalogType(summaryFor({ id: 'design-scheme' }))).toBe('creative');
    expect(categorizeCatalogType(summaryFor({ id: 'language-trainer' }))).toBe('growth');
    expect(categorizeCatalogType(summaryFor({ id: 'x', tags: ['blog', 'writing'] }))).toBe(
      'writing',
    );
    expect(categorizeCatalogType(summaryFor({ id: 'x', extends: 'web-app' }))).toBe('code');
  });

  it('lands unknowns in the other bucket', () => {
    expect(categorizeCatalogType(summaryFor({ id: 'mystery-thing' }))).toBe('other');
  });
});

describe('project kind registry', () => {
  it('assigns every kind a category that exists in the registry', () => {
    const known = new Set(PROJECT_CATEGORIES.map((c) => c.id));
    for (const kind of PROJECT_KINDS) {
      expect(known.has(kind.category)).toBe(true);
    }
  });
});
