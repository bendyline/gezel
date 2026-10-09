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
import { MULTILINGUAL_E5_SMALL_CENTER } from './e5-small-center.js';
import { EMBEDDINGGEMMA_2_512_CENTER } from './embeddinggemma-2-center.js';

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

/**
 * The public profile's first revision: multilingual, so world catalogs serve
 * every reader. Superseded for new builds by MULTILINGUAL_E5_SMALL_2 (same
 * vectors, centered stage-1 bits); catalogs built with this revision stay
 * readable and searchable, at the lower stage-1 recall of raw sign bits.
 */
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

/**
 * The public profile, revision 2: the model, files, instructions and int8
 * rerank of revision 1, with the stage-1 sign bits taken from
 * `vector − center` (`centered-sign`). e5-small vectors share one dominant
 * direction, so raw sign bits mostly encode that direction rather than the
 * passage and the hamming pre-filter loses most true neighbours; centering
 * on the pinned corpus mean restores them (see e5-small-center.ts for the
 * provenance and the measurements). A query vector for revision 1 is a
 * valid query vector for revision 2 — `sameVectorSpace` says so — and the
 * reader centers it itself from the catalog's profile echo.
 */
export const MULTILINGUAL_E5_SMALL_2: KnowledgeEmbeddingProfile = {
  ...MULTILINGUAL_E5_SMALL_1,
  id: 'multilingual-e5-small@2',
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: {
      method: 'centered-sign',
      threshold: 0,
      packing: 'lsb-first',
      center: [...MULTILINGUAL_E5_SMALL_CENTER],
    },
  },
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

/**
 * EmbeddingGemma 2 — one space for text, images, video and audio (Apache 2.0;
 * deployments follow the Gemma Prohibited Use Policy). Text uses the q8 graph
 * of the community ONNX conversion at a pinned revision, cut from 768 to 512
 * dimensions (Matryoshka prefix), with centered stage-1 bits: its vectors
 * share a dominant direction like e5's (see embeddinggemma-2-center.ts).
 *
 * Every file a load reads is pinned, including the external-data sidecars
 * that hold all of the weights. `media` pins the vision and audio encoders
 * and the settings media rows were embedded with: 280 vision tokens per
 * image (the processor's default; the pure-JS bicubic resize matches the
 * reference processor to cosine ≥ 0.997 there), video at 1 frame per second
 * and at most 32 frames of 140 tokens, mono 16 kHz audio in windows of at
 * most 30 s. Media embed with no prefix; queries with the search prefix.
 */
const GEMMA2_REPO = 'onnx-community/embeddinggemma-2-ONNX';
const GEMMA2_PROCESSOR_CONFIG = {
  path: 'processor_config.json',
  digest: 'sha256:168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c',
} as const;
export const EMBEDDINGGEMMA_2_512_1: KnowledgeEmbeddingProfile = {
  id: 'embeddinggemma-2-512@1',
  model: {
    repo: GEMMA2_REPO,
    revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
    onnxFile: 'onnx/model_quantized.onnx',
    onnxDigest: 'sha256:d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953',
    files: [
      {
        path: 'onnx/model_quantized.onnx_data',
        digest: 'sha256:278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b',
      },
      {
        path: 'config.json',
        digest: 'sha256:8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d',
      },
      {
        path: 'tokenizer_config.json',
        digest: 'sha256:17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874',
      },
    ],
  },
  tokenizer: {
    kind: 'gemma-bpe',
    file: 'tokenizer.json',
    digest: 'sha256:4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  },
  pooling: 'mean',
  normalized: true,
  dimensions: 512,
  truncation: { method: 'prefix', sourceDimensions: 768 },
  maxTokens: 512,
  queryInstruction: 'task: search result | query: ',
  passageInstruction: 'title: none | text: ',
  vectorEncoding: 'bit+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: {
      method: 'centered-sign',
      threshold: 0,
      packing: 'lsb-first',
      center: [...EMBEDDINGGEMMA_2_512_CENTER],
    },
  },
  media: {
    image: {
      encoder: {
        onnxFile: 'onnx/vision_encoder_quantized.onnx',
        onnxDigest: 'sha256:bb0de2df53a2448a32dc7908a187c168c8afd514d4d6f674f7f46024875fa4e3',
        files: [
          {
            path: 'onnx/vision_encoder_quantized.onnx_data',
            digest: 'sha256:3dabd69c0a36e9a8771ad82030dde74daa5a0e02b7047a5d3f3382b1137bab89',
          },
          GEMMA2_PROCESSOR_CONFIG,
        ],
      },
      tokenBudget: 280,
      resample: 'bicubic',
      alpha: 'composite-white',
    },
    video: { framesPerSecond: 1, maxFrames: 32, tokenBudgetPerFrame: 140 },
    audio: {
      encoder: {
        onnxFile: 'onnx/audio_encoder_quantized.onnx',
        onnxDigest: 'sha256:04a9a9094ba76fb169e4c69be45a4b621580188654d6be59eab860eadcd42d3c',
        files: [
          {
            path: 'onnx/audio_encoder_quantized.onnx_data',
            digest: 'sha256:aa6361d898e1f1d6303f8dd2b5fabf4fd3629e15fd709e9cb06ac5cb9416a030',
          },
          GEMMA2_PROCESSOR_CONFIG,
        ],
      },
      sampleRate: 16_000,
      channels: 1,
      maxWindowMs: 30_000,
    },
  },
};

/** Newest revision of a model first: `daemonEmbedderPin` picks the first match by repo. */
export const KNOWLEDGE_EMBEDDING_PROFILES: readonly KnowledgeEmbeddingProfile[] = [
  EMBEDDINGGEMMA_2_512_1,
  MULTILINGUAL_E5_SMALL_2,
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
