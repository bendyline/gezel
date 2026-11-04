import { afterEach, describe, expect, it, vi } from 'vitest';
import { mobileQueryModels, queryModelStoreId } from './catalog.js';
import type { GezelKnowledgePlugin } from './definitions.js';
import { createQueryEmbedder } from './query-model.js';
import { BASE_URL, VOCAB, serveTokenizer } from './test-store.js';

const E5 = mobileQueryModels.find((model) => model.id === 'multilingual-e5-small@2')!;
const STORE_ID = queryModelStoreId(E5.id);

function embedder(vector: number[] = [3, 4, ...new Array<number>(398).fill(0)]) {
  const embed = vi.fn<GezelKnowledgePlugin['embed']>(async () => ({ vector }));
  const plugin = { embed } as unknown as GezelKnowledgePlugin;
  return { embed, embedder: createQueryEmbedder(plugin, async () => BASE_URL) };
}

afterEach(() => vi.unstubAllGlobals());

describe('createQueryEmbedder', () => {
  it("embeds with the profile's instruction and returns the profile's unit vector", async () => {
    vi.stubGlobal('fetch', serveTokenizer(STORE_ID));
    const { embed, embedder: subject } = embedder();
    const vector = await subject.embed(E5.id, 'Panama Hotel');
    expect(embed).toHaveBeenCalledWith({
      model: 'query-multilingual-e5-small-2',
      file: 'onnx/model.onnx',
      ids: [VOCAB.query, VOCAB[':'], VOCAB.panama, VOCAB.hotel],
    });
    expect(vector).toHaveLength(E5.dimensions);
    expect(vector[0]).toBeCloseTo(0.6);
    expect(vector[1]).toBeCloseTo(0.8);
  });

  it('truncates a long question as the pipeline does, keeping its closing token', async () => {
    vi.stubGlobal('fetch', serveTokenizer(STORE_ID));
    const { embed, embedder: subject } = embedder();
    await subject.embed(E5.id, `${'panama '.repeat(600)}hotel`);
    const { ids } = embed.mock.calls[0]![0];
    expect(ids).toHaveLength(E5.maxTokens);
    expect(ids.at(-1)).toBe(VOCAB.hotel);
  });

  it('reads the tokenizer in ranges and loads it once', async () => {
    const fetch = serveTokenizer(STORE_ID);
    vi.stubGlobal('fetch', fetch);
    const { embedder: subject } = embedder();
    await subject.embed(E5.id, 'Panama');
    await subject.embed(E5.id, 'Hotel');
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(init?.headers).get('Range')).toBe(`bytes=0-${8 * 1024 * 1024 - 1}`);
  });

  it('loads the tokenizer again after a failed load', async () => {
    const served = serveTokenizer(STORE_ID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const { embedder: subject } = embedder();
    await expect(subject.embed(E5.id, 'Panama')).rejects.toThrow('HTTP 404');
    vi.stubGlobal('fetch', served);
    await expect(subject.embed(E5.id, 'Panama')).resolves.toHaveLength(E5.dimensions);
  });

  it('refuses an empty vector and a profile it has no model for', async () => {
    vi.stubGlobal('fetch', serveTokenizer(STORE_ID));
    const { embedder: subject } = embedder(new Array<number>(384).fill(0));
    await expect(subject.embed(E5.id, 'Panama')).rejects.toThrow('empty vector');
    expect(subject.model('unknown@1')).toBeUndefined();
    await expect(subject.embed('unknown@1', 'Panama')).rejects.toThrow('No query model');
  });
});
