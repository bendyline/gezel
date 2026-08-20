import { KnowledgeEmbeddingProfileSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  GEZEL_BGE_SMALL_EN_V15_1,
  GEZEL_MARKDOWN_CHUNKS_2,
  GEZEL_MULTILINGUAL_E5_SMALL_1,
  KNOWLEDGE_EMBEDDING_PROFILES,
  knowledgeEmbeddingProfile,
} from './registry.js';

describe('embedding profile registry', () => {
  it('every registered profile parses against the core schema', () => {
    for (const profile of KNOWLEDGE_EMBEDDING_PROFILES) {
      expect(() => KnowledgeEmbeddingProfileSchema.parse(profile)).not.toThrow();
    }
  });

  it('pins the frozen identities from gezk-format-v1.md', () => {
    expect(GEZEL_MULTILINGUAL_E5_SMALL_1.id).toBe('gezel-multilingual-e5-small@1');
    expect(GEZEL_MULTILINGUAL_E5_SMALL_1.model.repo).toBe('Xenova/multilingual-e5-small');
    expect(GEZEL_MULTILINGUAL_E5_SMALL_1.queryInstruction).toBe('query: ');
    expect(GEZEL_MULTILINGUAL_E5_SMALL_1.passageInstruction).toBe('passage: ');
    expect(GEZEL_BGE_SMALL_EN_V15_1.model.repo).toBe('Xenova/bge-small-en-v1.5');
    // Trailing space is part of the frozen instruction.
    expect(GEZEL_BGE_SMALL_EN_V15_1.queryInstruction.endsWith(': ')).toBe(true);
    expect(GEZEL_BGE_SMALL_EN_V15_1.passageInstruction).toBe('');
    // Pinned HF commit hashes, never floating refs.
    for (const profile of KNOWLEDGE_EMBEDDING_PROFILES) {
      expect(profile.model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(profile.vectorEncoding).toBe('bit384+int8');
      expect(profile.dimensions).toBe(384);
    }
  });

  it('resolves by id and rejects unknown ids', () => {
    expect(knowledgeEmbeddingProfile('gezel-bge-small-en-v1.5@1')?.model.repo).toBe(
      'Xenova/bge-small-en-v1.5',
    );
    expect(knowledgeEmbeddingProfile('nope@1')).toBeNull();
  });

  it('the knowledge chunking profile matches the frozen spec', () => {
    expect(GEZEL_MARKDOWN_CHUNKS_2).toEqual({
      id: 'gezel-markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      targetTokens: 420,
      overlapTokens: 64,
      contextHeader: { maxTokens: 64 },
    });
  });
});
