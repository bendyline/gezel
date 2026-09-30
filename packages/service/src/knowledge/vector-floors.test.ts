import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_VECTOR_FLOORS, resolveKnowledgeVectorFloors } from './vector-floors.js';

const handboek = { catalogKey: 'bendyline/handboek', profileId: 'bge-small-en-v1.5@1' };
const folderCatalog = { catalogKey: 'someone/notes', profileId: 'bge-small-en-v1.5@1' };
const shelf = {
  catalogKey: 'bendyline/wikipedia-food-drink',
  profileId: 'multilingual-e5-small@2',
};

describe('resolveKnowledgeVectorFloors', () => {
  it("prefers a catalog's own floor over its embedder's default", () => {
    const floors = resolveKnowledgeVectorFloors({});
    expect(floors.floorFor(handboek)).toBe(KNOWLEDGE_VECTOR_FLOORS['bendyline/handboek']);
    expect(floors.floorFor(folderCatalog)).toBe(KNOWLEDGE_VECTOR_FLOORS['bge-small-en-v1.5@1']);
    expect(floors.floorFor(handboek)).not.toBe(floors.floorFor(folderCatalog));
    expect(floors.floorFor(shelf)).toBe(KNOWLEDGE_VECTOR_FLOORS['multilingual-e5-small@2']);
  });

  it('reports an unmeasured embedder as null rather than guessing a scale', () => {
    const floors = resolveKnowledgeVectorFloors({});
    expect(floors.floorFor({ catalogKey: 'x/y', profileId: 'some-new-embedder@1' })).toBeNull();
  });

  it('lets calibration turn every floor off or replace named entries', () => {
    const off = resolveKnowledgeVectorFloors({ GEZEL_KNOWLEDGE_VECTOR_FLOORS: 'off' });
    expect(off.floorFor(handboek)).toBe(0);
    expect(off.floorFor({ catalogKey: 'x/y', profileId: 'some-new-embedder@1' })).toBe(0);

    const swept = resolveKnowledgeVectorFloors({
      GEZEL_KNOWLEDGE_VECTOR_FLOORS: 'bendyline/handboek=0.7, some-new-embedder@1=0.4,bogus',
    });
    expect(swept.floorFor(handboek)).toBe(0.7);
    expect(swept.floorFor({ catalogKey: 'x/y', profileId: 'some-new-embedder@1' })).toBe(0.4);
    expect(swept.floorFor(shelf)).toBe(KNOWLEDGE_VECTOR_FLOORS['multilingual-e5-small@2']);
  });
});
