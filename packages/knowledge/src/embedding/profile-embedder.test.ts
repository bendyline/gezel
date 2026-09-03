import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MULTILINGUAL_E5_SMALL_1 } from '../profiles/registry.js';
import {
  EmbedderArtifactError,
  transformersCachePath,
  verifyProfileArtifacts,
} from './artifact-verify.js';
import {
  EmbedderUnavailableError,
  type PipelineFn,
  type TransformersModule,
  createProfileEmbedder,
  resolveTransformersModelOptions,
} from './profile-embedder.js';

const ONNX_BYTES = Buffer.from('not really a graph, but stable bytes');
const TOKENIZER_BYTES = Buffer.from('{"model":{"type":"WordPiece"}}');
const sha = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function profileWith(patch: {
  onnxFile?: string;
  onnxDigest?: string;
  tokenizerFile?: string;
  tokenizerDigest?: string;
}): KnowledgeEmbeddingProfile {
  const base = MULTILINGUAL_E5_SMALL_1;
  return {
    ...base,
    model: {
      repo: base.model.repo,
      revision: base.model.revision,
      ...(patch.onnxFile ? { onnxFile: patch.onnxFile } : {}),
      ...(patch.onnxDigest ? { onnxDigest: patch.onnxDigest } : {}),
    },
    tokenizer: {
      kind: base.tokenizer.kind,
      ...(patch.tokenizerFile ? { file: patch.tokenizerFile } : {}),
      ...(patch.tokenizerDigest ? { digest: patch.tokenizerDigest } : {}),
    },
  };
}

interface FakeRuntime {
  module: TransformersModule;
  pipelineCalls: Array<{ model: string; options: Record<string, unknown> | undefined }>;
  tokenizerCalls: Array<{ model: string; options: Record<string, unknown> | undefined }>;
  disposed: number;
}

function fakeTransformers(): FakeRuntime {
  const runtime: FakeRuntime = {
    pipelineCalls: [],
    tokenizerCalls: [],
    disposed: 0,
    module: {
      env: {},
      pipeline: async (_task, model, options) => {
        runtime.pipelineCalls.push({ model, options });
        const pipe = (async (texts: string[]) => ({
          tolist: () => texts.map((text) => [text.length, 1, 0]),
        })) as PipelineFn;
        pipe.dispose = async () => {
          runtime.disposed++;
        };
        return pipe;
      },
      AutoTokenizer: {
        from_pretrained: async (model, options) => {
          runtime.tokenizerCalls.push({ model, options });
          return { encode: (text: string) => text.split(/\s+/).filter(Boolean) as never };
        },
      },
    },
  };
  return runtime;
}

describe('resolveTransformersModelOptions', () => {
  it('pins the full-precision graph by default', () => {
    expect(resolveTransformersModelOptions(profileWith({}))).toEqual({
      revision: MULTILINGUAL_E5_SMALL_1.model.revision,
      dtype: 'fp32',
      subfolder: 'onnx',
      model_file_name: 'model',
    });
  });

  it('reads the precision variant back off the pinned file name', () => {
    const cases: Array<[string, string, string, string]> = [
      ['onnx/model_fp16.onnx', 'fp16', 'onnx', 'model'],
      ['onnx/model_quantized.onnx', 'q8', 'onnx', 'model'],
      ['onnx/model_int8.onnx', 'int8', 'onnx', 'model'],
      ['onnx/model_q4.onnx', 'q4', 'onnx', 'model'],
      ['onnx/model_q4f16.onnx', 'q4f16', 'onnx', 'model'],
      ['graphs/text_model_uint8.onnx', 'uint8', 'graphs', 'text_model'],
      ['model.onnx', 'fp32', '', 'model'],
    ];
    for (const [onnxFile, dtype, subfolder, name] of cases) {
      expect(resolveTransformersModelOptions(profileWith({ onnxFile }))).toMatchObject({
        dtype,
        subfolder,
        model_file_name: name,
      });
    }
  });

  it('refuses files this runtime cannot load', () => {
    expect(() =>
      resolveTransformersModelOptions(profileWith({ onnxFile: 'onnx/model.bin' })),
    ).toThrow(EmbedderUnavailableError);
    expect(() =>
      resolveTransformersModelOptions(profileWith({ tokenizerFile: 'spm/tokenizer.json' })),
    ).toThrow(EmbedderUnavailableError);
    expect(() =>
      resolveTransformersModelOptions(profileWith({ onnxFile: 'onnx/_fp16.onnx' })),
    ).toThrow(EmbedderUnavailableError);
  });
});

describe('createProfileEmbedder', () => {
  let cacheDir: string;
  const repo = MULTILINGUAL_E5_SMALL_1.model.repo;
  const revision = MULTILINGUAL_E5_SMALL_1.model.revision;

  beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'gezel-profile-embedder-'));
    for (const [file, bytes] of [
      ['onnx/model.onnx', ONNX_BYTES],
      ['tokenizer.json', TOKENIZER_BYTES],
    ] as const) {
      const path = transformersCachePath(cacheDir, repo, revision, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
  });

  afterAll(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('loads exactly the pinned graph and verifies the fetched files', async () => {
    const runtime = fakeTransformers();
    const profile = profileWith({
      onnxFile: 'onnx/model.onnx',
      onnxDigest: sha(ONNX_BYTES),
      tokenizerFile: 'tokenizer.json',
      tokenizerDigest: sha(TOKENIZER_BYTES),
    });
    const embedder = await createProfileEmbedder(profile, {
      cacheDir,
      transformers: runtime.module,
      sessionOptions: { intraOpNumThreads: 2 },
    });
    expect(runtime.pipelineCalls).toEqual([
      {
        model: repo,
        options: {
          revision,
          dtype: 'fp32',
          subfolder: 'onnx',
          model_file_name: 'model',
          session_options: { intraOpNumThreads: 2 },
        },
      },
    ]);
    expect(runtime.tokenizerCalls).toEqual([{ model: repo, options: { revision } }]);
    expect(runtime.module.env).toEqual({ cacheDir, useFSCache: true, allowRemoteModels: true });
    expect(embedder.verification.status).toBe('verified');
    expect(embedder.verification.checks.map((c) => c.role)).toEqual(['onnx', 'tokenizer']);
    // The query instruction is applied by the embedder, the text capped by the pipe.
    const vector = await embedder.embedQuery('hello');
    expect(Array.from(vector)).toEqual(['query: hello'.length, 1, 0]);
    expect(embedder.countTokens('one two three')).toBe(3);
    await embedder.dispose();
    expect(runtime.disposed).toBe(1);
  });

  it('refuses a graph whose bytes differ from the pin and releases the session', async () => {
    const runtime = fakeTransformers();
    const profile = profileWith({ onnxDigest: `sha256:${'0'.repeat(64)}` });
    const failure = await createProfileEmbedder(profile, {
      cacheDir,
      transformers: runtime.module,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(EmbedderArtifactError);
    const error = failure as EmbedderArtifactError;
    expect(error.reason).toBe('mismatch');
    expect(error.isActionable).toBe(true);
    expect(error.message).toContain('onnx/model.onnx');
    expect(error.message).toContain(sha(ONNX_BYTES));
    expect(runtime.disposed).toBe(1);
  });

  it('fails closed when a pinned file is not where the runtime cached it', async () => {
    const runtime = fakeTransformers();
    const profile = profileWith({ tokenizerDigest: sha(TOKENIZER_BYTES) });
    const elsewhere = await mkdtemp(join(tmpdir(), 'gezel-empty-cache-'));
    try {
      const failure = await createProfileEmbedder(profile, {
        cacheDir: elsewhere,
        transformers: runtime.module,
      }).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(EmbedderArtifactError);
      expect((failure as EmbedderArtifactError).reason).toBe('missing');
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('marks a profile without digests as unpinned rather than failing', async () => {
    const runtime = fakeTransformers();
    const embedder = await createProfileEmbedder(profileWith({}), {
      cacheDir,
      transformers: runtime.module,
    });
    expect(embedder.verification).toEqual({ status: 'unpinned', checks: [] });
  });
});

describe('verifyProfileArtifacts', () => {
  it('looks under the bare repo key for a pipeline loaded from main', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gezel-main-cache-'));
    try {
      const repo = MULTILINGUAL_E5_SMALL_1.model.repo;
      const path = transformersCachePath(cacheDir, repo, 'main', 'onnx/model.onnx');
      expect(path).toBe(join(cacheDir, repo, 'onnx/model.onnx'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, ONNX_BYTES);
      const profile = profileWith({ onnxDigest: sha(ONNX_BYTES) });
      const result = await verifyProfileArtifacts(profile, { cacheDir, revision: 'main' });
      expect(result.status).toBe('verified');
      expect(result.checks[0]?.path).toBe(path);
      await expect(verifyProfileArtifacts(profile, { cacheDir })).rejects.toMatchObject({
        reason: 'missing',
      });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
