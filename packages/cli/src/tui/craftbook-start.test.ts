import type { CatalogItemSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  craftbookCategories,
  craftbookStartRequest,
  findCraftbook,
  normalizeCraftbooks,
} from './craftbook-start.js';

function catalogCraftbook(input: {
  id: string;
  name: string;
  sourceId?: string;
  stepCount?: number;
  tags?: string[];
  description?: string;
  version?: string;
  role?: 'project-starter' | 'maintenance-review' | 'general';
  connectors?: Array<{ typeId: string; optional?: boolean }>;
}): CatalogItemSummary {
  const stepCount = input.stepCount ?? 1;
  return {
    sourceId: input.sourceId ?? 'bundled',
    kind: 'craftbook-template',
    manifest: {
      kind: 'craftbook-template',
      id: input.id,
      name: input.name,
      description: input.description,
      version: input.version ?? '1.0.0',
      role: input.role ?? 'general',
      connectors: input.connectors,
      tags: input.tags ?? [],
      steps: Array.from({ length: stepCount }, (_, index) => ({
        id: `step-${index + 1}`,
        name: `Step ${index + 1}`,
      })),
    },
  } as unknown as CatalogItemSummary;
}

describe('craftbook start helpers', () => {
  it('deduplicates by source precedence and sorts for the picker', () => {
    const normalized = normalizeCraftbooks([
      catalogCraftbook({
        id: 'review',
        name: 'Project Review',
        sourceId: 'project',
        stepCount: 2,
      }),
      catalogCraftbook({ id: 'release', name: 'Release', stepCount: 3 }),
      catalogCraftbook({ id: 'review', name: 'Bundled Review', stepCount: 4 }),
    ]);

    expect(normalized.map((book) => [book.id, book.name])).toEqual([
      ['review', 'Project Review'],
      ['release', 'Release'],
    ]);
    expect(normalized[0]).toMatchObject({ source: 'project', sourceId: 'project' });
  });

  it('hides connector-backed craftbooks unless WIP features are enabled', () => {
    const items = [
      catalogCraftbook({ id: 'plain', name: 'Plain' }),
      catalogCraftbook({
        id: 'social-digest',
        name: 'Social Digest',
        connectors: [{ typeId: 'bluesky-posts', optional: true }],
      }),
    ];

    expect(normalizeCraftbooks(items).map((book) => book.id)).toEqual(['plain']);
    expect(normalizeCraftbooks(items, true).map((book) => book.id)).toEqual([
      'plain',
      'social-digest',
    ]);
  });

  it('builds a recommended first stage plus subject shelves', () => {
    const books = normalizeCraftbooks([
      catalogCraftbook({
        id: 'game-loop',
        name: 'Game Loop',
        tags: ['game'],
        role: 'project-starter',
      }),
      catalogCraftbook({
        id: 'project-check',
        name: 'Project Check',
        sourceId: 'project',
        tags: ['testing'],
        role: 'maintenance-review',
      }),
      catalogCraftbook({ id: 'general', name: 'General Work', tags: ['misc'] }),
    ]);

    const categories = craftbookCategories(books, new Set(['game-loop']), {
      id: 'browser-game',
      label: 'Browser Game',
    });

    expect(categories[0]).toMatchObject({
      id: 'recommended',
      label: 'Recommended for Browser Game',
      hint: '1 craftbook',
    });
    expect(categories[0]?.bookIds).toEqual(new Set(['game-loop']));
    expect(categories.find((category) => category.id === 'project')?.bookIds).toEqual(
      new Set(['project-check']),
    );
    expect(
      categories.find((category) => category.id === 'role:project-starter')?.bookIds,
    ).toContain('game-loop');
    expect(categories.find((category) => category.id === 'category:code-build')).toMatchObject({
      label: 'Build & features',
      hint: 'Code · 1 craftbook',
    });
    expect(
      categories.find((category) => category.id === 'category:code-quality')?.bookIds,
    ).toContain('project-check');
    // No subject signal at all still lands somewhere the picker can show.
    expect(categories.find((category) => category.id === 'category:other')?.bookIds).toContain(
      'general',
    );
    expect(categories.at(-1)).toMatchObject({ id: 'all', hint: '3 craftbooks' });
  });

  it('finds the selected book by id or display name', () => {
    const books = [
      {
        id: 'code-review',
        name: 'Code Review',
        sourceId: 'bundled',
        source: 'bundled' as const,
        stepCount: 3,
        tags: [],
        role: 'general' as const,
        category: 'code-review' as const,
      },
    ];
    expect(findCraftbook(books, 'CODE-REVIEW')?.id).toBe('code-review');
    expect(findCraftbook(books, 'code review')?.id).toBe('code-review');
  });

  it('creates and immediately dispatches a task from the selected craftbook', () => {
    const request = craftbookStartRequest({
      id: 'code-review',
      name: 'Code Review',
      description: 'Review the selected change and report actionable findings.',
      version: '2.1.0',
      sourceId: 'bundled',
      source: 'bundled',
      stepCount: 3,
      tags: ['review'],
      role: 'maintenance-review',
      category: 'code-review',
    });

    expect(request).toMatchObject({
      title: 'Code Review',
      craftbookId: 'code-review',
      craftbookSourceId: 'bundled',
      craftbookVersion: '2.1.0',
      dispatchEntry: true,
    });
    expect(request.description.length).toBeGreaterThanOrEqual(40);
  });
});
