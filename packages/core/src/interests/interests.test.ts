import { describe, expect, it } from 'vitest';
import {
  INTEREST_AREAS,
  InterestAreaIdSchema,
  interestAreasForCraftbook,
  interestAreasForKnowledgeCatalog,
  interestAreasForProjectType,
  interestAreasToSave,
  interestsAsked,
  orderByInterests,
  pickWithRange,
  resolveInterestAreas,
  shippedInterestAreas,
  suggestKnowledgeCatalogs,
} from './index.js';

describe('interest areas', () => {
  it('has copy for every id, and holds Health and Legal', () => {
    expect(INTEREST_AREAS.map((a) => a.id)).toEqual(InterestAreaIdSchema.options);
    expect(shippedInterestAreas().map((a) => a.id)).toEqual([
      'software',
      'data',
      'work',
      'business',
      'content',
      'home',
      'learning',
      'play',
    ]);
  });

  it('reads the stored choice as known, shipped ids in the order picked, once each', () => {
    expect(
      resolveInterestAreas({
        interests: { areas: ['home', 'health', 'from-a-newer-build', 'software', 'home'] },
      }),
    ).toEqual(['home', 'software']);
    expect(resolveInterestAreas({})).toEqual([]);
    expect(resolveInterestAreas(null)).toEqual([]);
  });

  it('keeps ids this build cannot show when it saves a new choice', () => {
    const stored = { interests: { areas: ['home', 'health', 'from-a-newer-build'] } };
    expect(interestAreasToSave(stored, ['data', 'data'])).toEqual([
      'data',
      'health',
      'from-a-newer-build',
    ]);
    expect(interestAreasToSave(null, [])).toEqual([]);
  });

  it('counts a skip as asked', () => {
    expect(interestsAsked({ interests: { askedAt: '2026-10-12T10:00:00Z' } })).toBe(true);
    expect(interestsAsked({ interests: {} })).toBe(false);
    expect(interestsAsked(undefined)).toBe(false);
  });
});

describe('interestAreasFor*', () => {
  it('lets a book say what its category gets wrong', () => {
    expect(interestAreasForCraftbook({ category: 'business' })).toEqual(['work', 'business']);
    expect(interestAreasForCraftbook({ category: 'business', interests: ['learning'] })).toEqual([
      'learning',
    ]);
    // Ways of working serve no subject.
    expect(interestAreasForCraftbook({ category: 'practice' })).toEqual([]);
  });

  it('falls back to tag inference when a book declares no category', () => {
    expect(interestAreasForCraftbook({ tags: ['code-review', 'pull-request'] })).toEqual([
      'software',
    ]);
  });

  it('maps project-type categories, games to Play', () => {
    expect(interestAreasForProjectType({ category: 'game' })).toEqual(['play']);
    expect(interestAreasForProjectType({ category: 'events' })).toEqual(['home']);
    expect(interestAreasForProjectType({})).toEqual([]);
  });
});

describe('orderByInterests', () => {
  const items = [
    { id: 'invoice', areas: ['business'] as const },
    { id: 'trip', areas: ['home'] as const },
    { id: 'review', areas: ['software'] as const },
    { id: 'plan', areas: [] as const },
    { id: 'meals', areas: ['home'] as const },
  ];
  const areasOf = (item: (typeof items)[number]) => item.areas;

  it('puts the chosen areas first, in the order picked, and drops nothing', () => {
    expect(orderByInterests(items, areasOf, ['software', 'home']).map((i) => i.id)).toEqual([
      'review',
      'trip',
      'meals',
      'invoice',
      'plan',
    ]);
  });

  it('leaves the order alone when nothing is chosen', () => {
    expect(orderByInterests(items, areasOf, []).map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
});

describe('pickWithRange', () => {
  const items = [
    { id: 'a', areas: ['home'] as const },
    { id: 'b', areas: ['home'] as const },
    { id: 'c', areas: ['software'] as const },
    { id: 'd', areas: ['home'] as const },
  ];
  const areasOf = (item: (typeof items)[number]) => item.areas;

  it('keeps one place for another area when the chosen one would fill them all', () => {
    expect(pickWithRange(items, areasOf, ['home'], 3).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('is plain interest order when there is room', () => {
    expect(pickWithRange(items, areasOf, ['software'], 2).map((i) => i.id)).toEqual(['c', 'a']);
  });
});

describe('knowledge catalogs', () => {
  const catalogs = [
    { id: 'microsoftdocs-dotnet-en', archiveBytes: 367 },
    { id: 'microsoftdocs-powershell-en', archiveBytes: 149 },
    { id: 'microsoftdocs-entity-framework-en', archiveBytes: 28, installed: { version: '1' } },
    { id: 'regional-midwest', archiveBytes: 32 },
    { id: 'wikipedia-food-drink', archiveBytes: 183 },
    { id: 'wikipedia-games', archiveBytes: 579 },
  ];

  it('places catalogs by family and subject', () => {
    expect(interestAreasForKnowledgeCatalog('microsoftdocs-sql-server-en')).toEqual(['software']);
    expect(interestAreasForKnowledgeCatalog('wikipedia-sports')).toEqual(['play']);
    expect(interestAreasForKnowledgeCatalog('wikipedia-something-new')).toEqual(['learning']);
  });

  it('offers the smallest two per area, never one installed or about one place', () => {
    expect(suggestKnowledgeCatalogs(catalogs, ['software', 'home']).map((c) => c.id)).toEqual([
      'microsoftdocs-powershell-en',
      'microsoftdocs-dotnet-en',
      'wikipedia-food-drink',
    ]);
  });
});
