import { KnowledgeEmbeddingProfileSchema } from '@bendyline/gezk';
import { describe, expect, it } from 'vitest';
import {
  BGE_SMALL_EN_V15_1,
  KNOWLEDGE_EMBEDDING_PROFILES,
  MARKDOWN_CHUNKS_2,
  MULTILINGUAL_E5_SMALL_1,
  knowledgeEmbeddingProfile,
} from './registry.js';

describe('embedding profile registry', () => {
  it('every registered profile parses against the format schema', () => {
    for (const profile of KNOWLEDGE_EMBEDDING_PROFILES) {
      expect(() => KnowledgeEmbeddingProfileSchema.parse(profile)).not.toThrow();
    }
  });

  it('pins the frozen identities', () => {
    expect(MULTILINGUAL_E5_SMALL_1.id).toBe('multilingual-e5-small@1');
    expect(MULTILINGUAL_E5_SMALL_1.model.repo).toBe('Xenova/multilingual-e5-small');
    expect(MULTILINGUAL_E5_SMALL_1.queryInstruction).toBe('query: ');
    expect(MULTILINGUAL_E5_SMALL_1.passageInstruction).toBe('passage: ');
    expect(BGE_SMALL_EN_V15_1.model.repo).toBe('Xenova/bge-small-en-v1.5');
    // Trailing space is part of the frozen instruction.
    expect(BGE_SMALL_EN_V15_1.queryInstruction.endsWith(': ')).toBe(true);
    expect(BGE_SMALL_EN_V15_1.passageInstruction).toBe('');
    // Pinned HF commit hashes, never floating refs.
    for (const profile of KNOWLEDGE_EMBEDDING_PROFILES) {
      expect(profile.model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(profile.vectorEncoding).toBe('bit+int8');
      expect(profile.dimensions).toBe(384);
      expect(profile.id.startsWith('gezel-')).toBe(false);
    }
  });

  it('pins the exact model files by name and sha256', () => {
    // The precision the vectors were produced at is a stated fact of the
    // profile, not whatever the runtime defaults to, and the digests are the
    // Hub's LFS object ids at the pinned revisions (2026-09-03).
    for (const profile of KNOWLEDGE_EMBEDDING_PROFILES) {
      expect(profile.model.onnxFile).toBe('onnx/model.onnx');
      expect(profile.model.onnxDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(profile.tokenizer.file).toBe('tokenizer.json');
      expect(profile.tokenizer.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(MULTILINGUAL_E5_SMALL_1.model.onnxDigest).toBe(
      'sha256:4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff',
    );
    expect(BGE_SMALL_EN_V15_1.model.onnxDigest).toBe(
      'sha256:828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
    );
    // Two distinct models never share an artifact.
    expect(MULTILINGUAL_E5_SMALL_1.model.onnxDigest).not.toBe(BGE_SMALL_EN_V15_1.model.onnxDigest);
    expect(MULTILINGUAL_E5_SMALL_1.tokenizer.digest).not.toBe(BGE_SMALL_EN_V15_1.tokenizer.digest);
  });

  it('resolves by id and rejects unknown ids', () => {
    expect(knowledgeEmbeddingProfile('bge-small-en-v1.5@1')?.model.repo).toBe(
      'Xenova/bge-small-en-v1.5',
    );
    expect(knowledgeEmbeddingProfile('gezel-bge-small-en-v1.5@1')).toBeNull();
    expect(knowledgeEmbeddingProfile('nope@1')).toBeNull();
  });

  it('the knowledge chunking profile matches the spec', () => {
    expect(MARKDOWN_CHUNKS_2).toEqual({
      id: 'markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      target: 420,
      overlap: 64,
      contextHeader: { max: 64 },
    });
  });
});
