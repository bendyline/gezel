import { afterEach, describe, expect, it, vi } from 'vitest';
import { mobileQueryModels, queryModelStoreId } from './catalog.js';
import type { GezelKnowledgePlugin } from './definitions.js';
import { BASE_URL, VOCAB, serveTokenizer } from './test-store.js';
import { createMobileTextEmbedder } from './text-embedder.js';

const BGE = mobileQueryModels.find((model) => model.id === 'bge-small-en-v1.5@1')!;
const STORE_ID = queryModelStoreId(BGE.id);
const ALL_FILES = BGE.files.map((file) => file.name);

function plugin(options: { files?: string[]; installFails?: unknown[] } = {}) {
  let files = options.files ?? [];
  const failures = [...(options.installFails ?? [])];
  let progress:
    | ((event: { id: string; receivedBytes: number; totalBytes: number }) => void)
    | null = null;
  const embed = vi.fn<GezelKnowledgePlugin['embed']>(async ({ ids }) => ({
    vector: [ids.length, 1, ...new Array<number>(382).fill(0)],
  }));
  const installModel = vi.fn<GezelKnowledgePlugin['installModel']>(async ({ id }) => {
    progress?.({ id, receivedBytes: 1_000, totalBytes: 2_000 });
    const failure = failures.shift();
    if (failure) throw failure;
    files = ALL_FILES;
    return { id };
  });
  const fake = {
    info: async () => ({ baseUrl: BASE_URL, catalogs: [{ id: STORE_ID, files }] }),
    installModel,
    embed,
    addListener: async (_event: string, listener: typeof progress) => {
      progress = listener;
      return {
        remove: async () => {
          progress = null;
        },
      };
    },
  } as unknown as GezelKnowledgePlugin;
  return { fake, embed, installModel };
}

afterEach(() => vi.unstubAllGlobals());

describe('createMobileTextEmbedder', () => {
  it('reports ready when the profile model is installed, and embeds passages as given', async () => {
    vi.stubGlobal('fetch', serveTokenizer(STORE_ID));
    const { fake, embed } = plugin({ files: ALL_FILES });
    const subject = createMobileTextEmbedder({ plugin: fake });
    expect(subject.profileId).toBe('bge-small-en-v1.5@1');
    expect(subject.dimensions).toBe(384);
    expect((await subject.status()).state).toBe('ready');

    const [passage] = await subject.embed('passage', ['panama hotel']);
    expect(embed).toHaveBeenLastCalledWith({
      model: STORE_ID,
      file: 'onnx/model.onnx',
      ids: [VOCAB.panama, VOCAB.hotel],
    });
    expect(passage).toHaveLength(384);
    // The query carries the profile's instruction; unknown words map to [UNK].
    await subject.embed('query', ['panama']);
    const { ids } = embed.mock.calls.at(-1)![0];
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.at(-1)).toBe(VOCAB.panama);
    expect(await subject.tokenizer()).toMatchObject({ config: '{}' });
  });

  it('downloads on request, reporting progress, then is ready', async () => {
    const { fake, installModel } = plugin();
    const subject = createMobileTextEmbedder({ plugin: fake });
    expect(await subject.status()).toMatchObject({
      state: 'download-required',
      totalBytes: BGE.files.reduce((sum, file) => sum + file.size, 0),
    });
    const done = subject.install();
    expect(subject.install()).toBe(done);
    await done;
    expect(installModel).toHaveBeenCalledTimes(1);
    expect(installModel.mock.calls[0]![0]).toMatchObject({ id: STORE_ID, files: BGE.files });
    expect((await subject.status()).state).toBe('ready');
  });

  it('retries an interrupted download and explains one that fails', async () => {
    const interrupted = Object.assign(new Error('lost'), { code: 'interrupted' });
    const retried = plugin({ installFails: [interrupted] });
    await createMobileTextEmbedder({ plugin: retried.fake, downloadRetryDelaysMs: [0] }).install();
    expect(retried.installModel).toHaveBeenCalledTimes(2);

    const storage = Object.assign(new Error('full'), { code: 'storage' });
    const failing = plugin({ installFails: [storage] });
    const subject = createMobileTextEmbedder({ plugin: failing.fake });
    await expect(subject.install()).rejects.toThrow('full');
    expect(await subject.status()).toMatchObject({
      state: 'download-required',
      error: expect.stringContaining('Free up storage'),
    });
  });

  it('refuses a profile it has no mobile model for', () => {
    expect(() => createMobileTextEmbedder({ profileId: 'unknown@1' })).toThrow('No mobile model');
  });
});
