import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BGE_SMALL_EN_V15_1, MULTILINGUAL_E5_SMALL_1 } from '@bendyline/gezel-knowledge';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PipelineLoadError,
  daemonEmbedderPin,
  daemonEmbedderVerified,
  embedModelId,
  embedProfileId,
  isRetryablePipelineLoadFailure,
  queryInstruction,
  resetDaemonEmbedderVerification,
} from './embed-core.js';
import { embed, embeddingsDisabledReason, sharesDaemonEmbedder } from './embeddings.js';

const prior = process.env.GEZEL_EMBED_MODEL;
const priorNoInstr = process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
const priorDisable = process.env.GEZEL_DISABLE_EMBEDDINGS;
afterEach(() => {
  if (prior === undefined) delete process.env.GEZEL_EMBED_MODEL;
  else process.env.GEZEL_EMBED_MODEL = prior;
  if (priorNoInstr === undefined) delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
  else process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION = priorNoInstr;
  if (priorDisable === undefined) delete process.env.GEZEL_DISABLE_EMBEDDINGS;
  else process.env.GEZEL_DISABLE_EMBEDDINGS = priorDisable;
});

describe('embedModelId', () => {
  it('defaults to bge-small-en-v1.5 and honors the GEZEL_EMBED_MODEL override', () => {
    delete process.env.GEZEL_EMBED_MODEL;
    expect(embedModelId()).toBe('Xenova/bge-small-en-v1.5');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/gte-small';
    expect(embedModelId()).toBe('Xenova/gte-small');
  });
});

describe('queryInstruction', () => {
  it('returns the bge retrieval prefix for bge-* models and empty for symmetric ones', () => {
    delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
    process.env.GEZEL_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
    expect(queryInstruction()).toBe('Represent this sentence for searching relevant passages: ');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
    expect(queryInstruction()).toBe('');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/gte-small';
    expect(queryInstruction()).toBe('');
  });

  it('is disabled by GEZEL_EMBED_NO_QUERY_INSTRUCTION for A/B isolation', () => {
    process.env.GEZEL_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
    process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION = '1';
    expect(queryInstruction()).toBe('');
  });
});

describe('embedProfileId (C5: the full vector-space identity)', () => {
  it('changes when the model, the instructions, or the dim change', () => {
    delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
    process.env.GEZEL_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
    const bge = embedProfileId();
    expect(bge).toMatch(
      /^Xenova\/bge-small-en-v1\.5\|d384\|mean\|norm\|q:[0-9a-f]{8}\|p:[0-9a-f]{8}$/,
    );

    // Instruction kill-switch changes vectors → must change the profile,
    // which the bare model-id stamp never caught.
    process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION = '1';
    expect(embedProfileId()).not.toBe(bge);
    delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;

    // e5 prefixes BOTH sides — different profile despite same dim/pooling.
    process.env.GEZEL_EMBED_MODEL = 'Xenova/multilingual-e5-small';
    expect(embedProfileId()).not.toBe(bge);

    // The empty passage instruction hashes to the well-known empty-string
    // sha prefix — pins that bge's passage side really is unprefixed.
    expect(bge.endsWith('|p:e3b0c442')).toBe(true);
  });
});

describe('embedding kill switch', () => {
  it('disables embedding without loading the model', async () => {
    process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
    expect(embeddingsDisabledReason()).toBe('disabled by GEZEL_DISABLE_EMBEDDINGS');
    await expect(embed('offline fixture text')).rejects.toMatchObject({
      code: 'EMBEDDINGS_DISABLED',
    });
  });
});

describe('embedding model-load failure classification', () => {
  it('retries transport and registry-capacity failures', () => {
    expect(isRetryablePipelineLoadFailure(new Error('fetch failed'))).toBe(true);
    expect(isRetryablePipelineLoadFailure(new Error('HTTP 503 while downloading model.onnx'))).toBe(
      true,
    );
    expect(
      isRetryablePipelineLoadFailure(
        Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
      ),
    ).toBe(true);
  });

  it('retries undici mid-stream aborts (the killed-download family)', () => {
    // Wild-caught: a model download killed at ~103s surfaced as a bare
    // TypeError('terminated'), classified fatal, and stickily disabled
    // semantic search for the daemon's lifetime with no visible error.
    expect(isRetryablePipelineLoadFailure(new TypeError('terminated'))).toBe(true);
    expect(isRetryablePipelineLoadFailure(new Error('other side closed'))).toBe(true);
    expect(isRetryablePipelineLoadFailure(new Error('premature close'))).toBe(true);
    expect(
      isRetryablePipelineLoadFailure(
        Object.assign(new Error('stream ended'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }),
      ),
    ).toBe(true);
    expect(isRetryablePipelineLoadFailure(new Error('The operation was aborted'))).toBe(true);
  });

  it('keeps configuration and runtime failures non-retryable', () => {
    expect(isRetryablePipelineLoadFailure(new Error('Unknown model id'))).toBe(false);
    expect(isRetryablePipelineLoadFailure(new Error('ERR_DLOPEN_FAILED'))).toBe(false);
    expect(isRetryablePipelineLoadFailure(new Error('Cannot find module sharp'))).toBe(false);
    expect(new PipelineLoadError('invalid model').retryable).toBe(false);
  });
});

describe('daemon embedder pin', () => {
  const priorCacheDir = process.env.GEZEL_HF_CACHE_DIR;
  afterEach(() => {
    resetDaemonEmbedderVerification();
    if (priorCacheDir === undefined) delete process.env.GEZEL_HF_CACHE_DIR;
    else process.env.GEZEL_HF_CACHE_DIR = priorCacheDir;
  });

  it('is the registered profile of the configured model, or nothing', () => {
    delete process.env.GEZEL_EMBED_MODEL;
    expect(daemonEmbedderPin()?.id).toBe('bge-small-en-v1.5@1');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/multilingual-e5-small';
    expect(daemonEmbedderPin()?.id).toBe('multilingual-e5-small@1');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/gte-small';
    expect(daemonEmbedderPin()).toBeNull();
  });

  it('shares the daemon embedder only with a profile in exactly its vector space', () => {
    delete process.env.GEZEL_EMBED_MODEL;
    delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
    expect(sharesDaemonEmbedder(BGE_SMALL_EN_V15_1)).toBe(true);
    expect(sharesDaemonEmbedder(MULTILINGUAL_E5_SMALL_1)).toBe(false);
    // A pin naming other bytes, or another graph, is another space whatever the id says.
    expect(
      sharesDaemonEmbedder({
        ...BGE_SMALL_EN_V15_1,
        model: { ...BGE_SMALL_EN_V15_1.model, onnxDigest: `sha256:${'0'.repeat(64)}` },
      }),
    ).toBe(false);
    expect(
      sharesDaemonEmbedder({
        ...BGE_SMALL_EN_V15_1,
        model: {
          repo: BGE_SMALL_EN_V15_1.model.repo,
          revision: BGE_SMALL_EN_V15_1.model.revision,
          onnxFile: 'onnx/model_fp16.onnx',
        },
      }),
    ).toBe(false);
    // An older archive that pins nothing still shares: it makes no contrary claim.
    expect(
      sharesDaemonEmbedder({
        ...BGE_SMALL_EN_V15_1,
        model: { repo: BGE_SMALL_EN_V15_1.model.repo, revision: BGE_SMALL_EN_V15_1.model.revision },
        tokenizer: { kind: BGE_SMALL_EN_V15_1.tokenizer.kind },
      }),
    ).toBe(true);
    // The instruction kill-switch changes the daemon's query vectors.
    process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION = '1';
    expect(sharesDaemonEmbedder(BGE_SMALL_EN_V15_1)).toBe(false);
    delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
    process.env.GEZEL_EMBED_MODEL = 'Xenova/gte-small';
    expect(sharesDaemonEmbedder(BGE_SMALL_EN_V15_1)).toBe(false);
  });

  it('refuses to vouch for daemon model files that are absent or hash differently', async () => {
    delete process.env.GEZEL_EMBED_MODEL;
    const cacheDir = await mkdtemp(join(tmpdir(), 'gezel-daemon-pin-'));
    try {
      process.env.GEZEL_HF_CACHE_DIR = cacheDir;
      expect(await daemonEmbedderVerified()).toBe(false);

      const repoDir = join(cacheDir, 'Xenova', 'bge-small-en-v1.5');
      await mkdir(join(repoDir, 'onnx'), { recursive: true });
      await writeFile(join(repoDir, 'onnx', 'model.onnx'), 'not the pinned graph');
      await writeFile(join(repoDir, 'tokenizer.json'), '{}');
      resetDaemonEmbedderVerification();
      expect(await daemonEmbedderVerified()).toBe(false);

      // A custom model has no pin, so there is nothing to vouch for.
      process.env.GEZEL_EMBED_MODEL = 'Xenova/gte-small';
      resetDaemonEmbedderVerification();
      expect(await daemonEmbedderVerified()).toBe(false);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
