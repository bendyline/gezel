/**
 * The registered embedding profiles (gezk-format-v1.md §4) — the single
 * source both the compiler and the reader import. A profile is the FULL
 * vector-space identity: readers refuse to mix vectors across profile ids,
 * and any change to model, instructions, or encoding is a NEW id.
 *
 * Revisions are the HF commit hashes captured at Phase-0 freeze
 * (2026-08-20). The onnx/tokenizer digests are recorded when the release
 * pipeline first pulls the artifacts (Phase 5/6 hardening); their absence
 * does not weaken catalog verification, which pins vectors by content.
 */

import type { KnowledgeChunkingProfile, KnowledgeEmbeddingProfile } from '@bendyline/gezel';

const SHARED_ENCODING = {
  pooling: 'mean',
  normalized: true,
  dimensions: 384,
  maxTokens: 512,
  vectorEncoding: 'bit384+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
  },
} as const;

/** The public Qualla profile (user decision: multilingual for world catalogs). */
export const GEZEL_MULTILINGUAL_E5_SMALL_1: KnowledgeEmbeddingProfile = {
  id: 'gezel-multilingual-e5-small@1',
  model: {
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  },
  tokenizer: { kind: 'sentencepiece-xlmr' },
  queryInstruction: 'query: ',
  passageInstruction: 'passage: ',
  ...SHARED_ENCODING,
};

/** The local-build default — matches gezel's shipped project embedder. */
export const GEZEL_BGE_SMALL_EN_V15_1: KnowledgeEmbeddingProfile = {
  id: 'gezel-bge-small-en-v1.5@1',
  model: {
    repo: 'Xenova/bge-small-en-v1.5',
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  },
  tokenizer: { kind: 'wordpiece-bert' },
  queryInstruction: 'Represent this sentence for searching relevant passages: ',
  passageInstruction: '',
  ...SHARED_ENCODING,
};

export const KNOWLEDGE_EMBEDDING_PROFILES: readonly KnowledgeEmbeddingProfile[] = [
  GEZEL_MULTILINGUAL_E5_SMALL_1,
  GEZEL_BGE_SMALL_EN_V15_1,
];

export function knowledgeEmbeddingProfile(id: string): KnowledgeEmbeddingProfile | null {
  return KNOWLEDGE_EMBEDDING_PROFILES.find((p) => p.id === id) ?? null;
}

/** The knowledge chunking profile (gezk-format-v1.md §5). */
export const GEZEL_MARKDOWN_CHUNKS_2: KnowledgeChunkingProfile = {
  id: 'gezel-markdown-chunks@2',
  unit: 'tokens',
  tokenizer: 'profile',
  targetTokens: 420,
  overlapTokens: 64,
  contextHeader: { maxTokens: 64 },
};
