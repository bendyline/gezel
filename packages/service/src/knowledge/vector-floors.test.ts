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

  it('measures every embedding profile a catalog can be built with', async () => {
    const { KNOWLEDGE_EMBEDDING_PROFILES } = await import('@bendyline/gezel-knowledge');
    const floors = resolveKnowledgeVectorFloors({});
    for (const profile of KNOWLEDGE_EMBEDDING_PROFILES) {
      expect(
        floors.floorFor({ catalogKey: 'x/y', profileId: profile.id }),
        profile.id,
      ).not.toBeNull();
    }
  });

  it('measures every media modality of every profile that describes media encoders', async () => {
    const { KNOWLEDGE_EMBEDDING_PROFILES } = await import('@bendyline/gezel-knowledge');
    const floors = resolveKnowledgeVectorFloors({});
    for (const profile of KNOWLEDGE_EMBEDDING_PROFILES) {
      for (const modality of ['image', 'video', 'audio'] as const) {
        if (!profile.media?.[modality]) continue;
        expect(
          floors.floorFor({ catalogKey: 'workspace', profileId: profile.id, modality }),
          `${profile.id}#${modality}`,
        ).not.toBeNull();
      }
    }
  });

  it('keeps a media modality without a measured floor at null, never the text floor', () => {
    const floors = resolveKnowledgeVectorFloors({});
    expect(floors.floorFor({ catalogKey: 'x/y', profileId: 'bge-small-en-v1.5@1', modality: 'image' })).toBeNull();
    expect(
      floors.floorFor({ catalogKey: 'x/y', profileId: 'embeddinggemma-2-512@1', modality: 'image' }),
    ).toBe(KNOWLEDGE_VECTOR_FLOORS['embeddinggemma-2-512@1#image']);
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
