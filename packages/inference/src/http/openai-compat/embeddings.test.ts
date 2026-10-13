import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingsDisabledError, EmbeddingsUnavailableError } from '../../memory/embeddings.js';
import type { LLMProvider } from '../../providers/types.js';
import { createEmbeddings, isLocalEmbeddingModel } from './embeddings.js';

const embedBatch = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());
vi.mock('../../memory/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/embeddings.js')>()),
  embedBatch,
}));

const provider = (extra: Partial<LLMProvider> = {}) =>
  ({
    name: 'openai',
    initialize: async () => {},
    shutdown: async () => {},
    listModels: async () => [],
    createSession: async () => {
      throw new Error('unused');
    },
    ...extra,
  }) as LLMProvider;

const ctx = (chat: Partial<Parameters<typeof createEmbeddings>[0]['chat']> = {}) => ({
  chat: {
    getProviderForModel: () => Promise.reject(new Error('must not bind a model')),
    listModelsForProvider: async () => [],
    resolveModelSessionDefaults: () => {
      throw new Error('unused');
    },
    ...chat,
  } as Parameters<typeof createEmbeddings>[0]['chat'],
});

afterEach(() => {
  embedBatch.mockReset();
  vi.unstubAllEnvs();
});

describe('isLocalEmbeddingModel', () => {
  it('accepts the alias, the configured model id and its bare name', () => {
    vi.stubEnv('GEZEL_EMBED_MODEL', '');
    for (const model of ['gezel:embeddings', 'Xenova/bge-small-en-v1.5', 'BGE-small-en-v1.5']) {
      expect(isLocalEmbeddingModel(model), model).toBe(true);
    }
    for (const model of ['llama-cpp:qwen3-8b', 'gezel:writer-ada', 'bge-base-en-v1.5']) {
      expect(isLocalEmbeddingModel(model), model).toBe(false);
    }
  });

  it('follows a custom GEZEL_EMBED_MODEL', () => {
    vi.stubEnv('GEZEL_EMBED_MODEL', 'Xenova/all-MiniLM-L6-v2');
    expect(isLocalEmbeddingModel('all-MiniLM-L6-v2')).toBe(true);
    expect(isLocalEmbeddingModel('bge-small-en-v1.5')).toBe(false);
  });
});

describe('createEmbeddings', () => {
  it('runs the on-device embedder and reports the model that produced the vectors', async () => {
    vi.stubEnv('GEZEL_EMBED_MODEL', '');
    embedBatch.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const outcome = await createEmbeddings(ctx(), 'gezel:embeddings', ['hello', 'world!!!']);
    expect(embedBatch).toHaveBeenCalledWith(['hello', 'world!!!']);
    expect(outcome).toEqual({
      ok: true,
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      model: 'Xenova/bge-small-en-v1.5',
      inputTokens: 4,
    });
  });

  it('wraps a single string input', async () => {
    embedBatch.mockResolvedValue([[1]]);
    await createEmbeddings(ctx(), 'gezel:embeddings', 'one');
    expect(embedBatch).toHaveBeenCalledWith(['one']);
  });

  it('maps a disabled or unavailable embedder to 503 with its reason', async () => {
    for (const err of [
      new EmbeddingsDisabledError('Install @huggingface/transformers'),
      new EmbeddingsUnavailableError('download failed'),
    ]) {
      embedBatch.mockRejectedValueOnce(err);
      const outcome = await createEmbeddings(ctx(), 'gezel:embeddings', 'x');
      expect(outcome).toMatchObject({ ok: false, status: 503, code: 'embeddings_unavailable' });
      expect(!outcome.ok && outcome.message).toContain(err.message);
    }
  });

  it('names the alias when the model is unknown', async () => {
    const outcome = await createEmbeddings(ctx(), 'Xenova/some-other-model', 'x');
    expect(outcome).toMatchObject({ ok: false, status: 404, code: 'model_not_found' });
    expect(!outcome.ok && outcome.message).toContain('gezel:embeddings');
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('never swaps a chat model for the embedder', async () => {
    const outcome = await createEmbeddings(
      ctx({ getProvider: async () => provider() }),
      'openai:gpt-5',
      'x',
    );
    expect(outcome).toMatchObject({ ok: false, status: 400, code: 'embeddings_not_supported' });
    expect(!outcome.ok && outcome.message).toContain('gezel:embeddings');
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('refuses provider models without binding one when the host has no provider lookup', async () => {
    const outcome = await createEmbeddings(ctx(), 'llama-cpp:qwen3-8b', 'x');
    expect(outcome).toMatchObject({ ok: false, status: 400, code: 'embeddings_not_supported' });
  });

  it('serves a provider that implements createEmbedding and echoes the requested model', async () => {
    const createEmbedding = vi.fn(async () => ({
      vectors: [[9]],
      model: 'text-embedding-3-small',
      usage: { inputTokens: 3 },
    }));
    const outcome = await createEmbeddings(
      ctx({ getProvider: async () => provider({ createEmbedding }) }),
      'openai:text-embedding-3-small',
      'abc',
    );
    expect(createEmbedding).toHaveBeenCalledWith({ input: 'abc', model: 'text-embedding-3-small' });
    expect(outcome).toEqual({
      ok: true,
      vectors: [[9]],
      model: 'openai:text-embedding-3-small',
      inputTokens: 3,
    });
  });

  it('reports a provider failure as a 500', async () => {
    const outcome = await createEmbeddings(
      ctx({
        getProvider: async () =>
          provider({
            createEmbedding: async () => {
              throw new Error('rate limited');
            },
          }),
      }),
      'openai:text-embedding-3-small',
      'abc',
    );
    expect(outcome).toEqual({
      ok: false,
      status: 500,
      code: 'provider_error',
      message: 'rate limited',
    });
  });
});
