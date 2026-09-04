/**
 * The registered embedding profiles — the single source both the compiler
 * and the reader import. A profile is the FULL vector-space identity:
 * readers refuse to mix vectors across profile ids, and any change to model,
 * instructions, or encoding is a NEW id.
 *
 * Revisions are the Hugging Face commit hashes the profiles were frozen at
 * (2026-08-20). The artifact digests (recorded 2026-09-03) are the sha256 of
 * the exact files at those revisions — the Hub's LFS object ids for the ONNX
 * graphs and the e5 tokenizer, a hashed download for the bge tokenizer — and
 * name the full-precision graph explicitly, so the precision the vectors were
 * produced at is a pinned fact rather than a runtime default. Every embedder
 * built from a profile verifies the files it loaded against these digests.
 */

import type { KnowledgeChunkingProfile, KnowledgeEmbeddingProfile } from '@bendyline/gezk';

const SHARED_ENCODING = {
  pooling: 'mean',
  normalized: true,
  dimensions: 384,
  maxTokens: 512,
  vectorEncoding: 'bit+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
  },
} as const;

/** The public profile: multilingual, so world catalogs serve every reader. */
export const MULTILINGUAL_E5_SMALL_1: KnowledgeEmbeddingProfile = {
  id: 'multilingual-e5-small@1',
  model: {
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    onnxFile: 'onnx/model.onnx',
    onnxDigest: 'sha256:4aa845c27760e06e9a686b9d8b5d440eae4b6612cd09e5b522b716d3941f77ff',
  },
  tokenizer: {
    kind: 'sentencepiece-xlmr',
    file: 'tokenizer.json',
    digest: 'sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  },
  queryInstruction: 'query: ',
  passageInstruction: 'passage: ',
  ...SHARED_ENCODING,
};

/** The local-build default — matches gezel's shipped project embedder. */
export const BGE_SMALL_EN_V15_1: KnowledgeEmbeddingProfile = {
  id: 'bge-small-en-v1.5@1',
  model: {
    repo: 'Xenova/bge-small-en-v1.5',
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    onnxFile: 'onnx/model.onnx',
    onnxDigest: 'sha256:828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35',
  },
  tokenizer: {
    kind: 'wordpiece-bert',
    file: 'tokenizer.json',
    digest: 'sha256:d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  },
  queryInstruction: 'Represent this sentence for searching relevant passages: ',
  passageInstruction: '',
  ...SHARED_ENCODING,
};

export const KNOWLEDGE_EMBEDDING_PROFILES: readonly KnowledgeEmbeddingProfile[] = [
  MULTILINGUAL_E5_SMALL_1,
  BGE_SMALL_EN_V15_1,
];

export function knowledgeEmbeddingProfile(id: string): KnowledgeEmbeddingProfile | null {
  return KNOWLEDGE_EMBEDDING_PROFILES.find((p) => p.id === id) ?? null;
}

/** The knowledge chunking profile: token-bounded, heading-aware Markdown sections. */
export const MARKDOWN_CHUNKS_2: KnowledgeChunkingProfile = {
  id: 'markdown-chunks@2',
  unit: 'tokens',
  tokenizer: 'profile',
  target: 420,
  overlap: 64,
  contextHeader: { max: 64 },
};

/** @deprecated gezk 0.4 names; removed with the next minor. */
export const GEZEL_MULTILINGUAL_E5_SMALL_1 = MULTILINGUAL_E5_SMALL_1;
/** @deprecated gezk 0.4 names; removed with the next minor. */
export const GEZEL_BGE_SMALL_EN_V15_1 = BGE_SMALL_EN_V15_1;
/** @deprecated gezk 0.4 names; removed with the next minor. */
export const GEZEL_MARKDOWN_CHUNKS_2 = MARKDOWN_CHUNKS_2;
