import type { CatalogItemSummary, ProjectType } from '@bendyline/gezel';
import { getProjectType } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { suggestedCraftbookIdsForType } from './applicable.js';

/** Minimal craftbook-template catalog summary carrying just id + tags. */
function book(id: string, tags: string[]): CatalogItemSummary {
  return {
    sourceId: 'bundled',
    kind: 'craftbook-template',
    manifest: {
      kind: 'craftbook-template',
      id,
      name: id,
      description: '',
      tags,
    },
  } as unknown as CatalogItemSummary;
}

describe('suggestedCraftbookIdsForType', () => {
  const items = [
    book('html-arcade-game', ['game', 'html', 'canvas', 'interactive', 'gallery']),
    book('sprite-sheet', ['sprite', 'game-art', 'animation', 'image-generation', 'gallery']),
    book('physics-toy', ['physics', 'simulation', 'interactive', 'gallery']),
    book('animated-svg-hero', ['svg', 'html', 'gallery']),
    book('accessibility-audit', ['accessibility', 'a11y', 'gallery']),
    book('audio-highlight-reel', ['audio', 'video', 'gallery']),
    book('rest-api-review', ['api', 'backend', 'gallery']),
  ];

  it('returns books whose tags intersect the type craftbookTags', () => {
    const type = getProjectType('browser-game') as ProjectType;
    const ids = suggestedCraftbookIdsForType(items, type);
    expect(ids).toContain('html-arcade-game');
    expect(ids).toContain('sprite-sheet');
    expect(ids).toContain('physics-toy');
    expect(ids).not.toContain('animated-svg-hero');
    expect(ids).not.toContain('accessibility-audit');
    expect(ids).not.toContain('audio-highlight-reel');
    expect(ids).not.toContain('rest-api-review');
  });

  it('matches case-insensitively', () => {
    const type: ProjectType = {
      id: 'x',
      label: 'X',
      description: '',
      icon: 'sheet',
      detect: {},
      craftbookTags: ['SVG'],
      gezelRoles: { default: [], suggested: [] },
    };
    expect(suggestedCraftbookIdsForType(items, type)).toContain('animated-svg-hero');
  });

  it('returns empty when no type resolves (rail shows the full list)', () => {
    expect(suggestedCraftbookIdsForType(items, null)).toEqual([]);
    expect(suggestedCraftbookIdsForType(items, undefined)).toEqual([]);
  });

  it('does not over-match on the near-universal gallery tag', () => {
    // The taxonomy never lists `gallery`; a type that did would match all.
    const apiType = getProjectType('api-service') as ProjectType;
    const ids = suggestedCraftbookIdsForType(items, apiType);
    expect(ids).toEqual(['rest-api-review']);
  });

  it('keeps browser-game suggestions focused instead of matching generic web tags', () => {
    const type = getProjectType('browser-game') as ProjectType;
    const ids = suggestedCraftbookIdsForType(
      [
        book('html-arcade-game', ['game', 'html', 'canvas', 'interactive']),
        book('game-with-screens', ['game', 'html', 'multiscreen', 'canvas', 'arcade']),
        book('accessibility-audit', ['accessibility', 'a11y', 'wcag', 'audit']),
        book('branding-website', ['website', 'branding', 'marketing', 'design', 'html']),
        book('canvas-generative-art', ['canvas', 'generative', 'art', 'html']),
        book('perf-audit', ['performance', 'audit', 'optimization']),
      ],
      type,
    );

    expect(ids).toEqual(['html-arcade-game', 'game-with-screens']);
  });
});
