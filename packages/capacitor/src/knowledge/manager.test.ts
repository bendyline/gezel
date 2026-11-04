import type { KnowledgeCatalogHost } from '@bendyline/gezel-inference/internal/knowledge/catalog-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  knowledgeCatalogUrl,
  mobileKnowledgeCatalogs,
  mobileQueryModels,
  queryModelStoreId,
} from './catalog.js';
import type { GezelKnowledgePlugin } from './definitions.js';
import { createMobileKnowledge } from './manager.js';
import { BASE_URL, serveTokenizer } from './test-store.js';

const CATALOG = mobileKnowledgeCatalogs.find((c) => c.id === 'regional-pacific-northwest')!;
const MODEL = mobileQueryModels.find((m) => m.id === CATALOG.embeddingProfile.id)!;
const MODEL_ID = queryModelStoreId(MODEL.id);
const KEY = `bendyline/${CATALOG.id}`;
const ARCHIVE = `${CATALOG.version}/catalog.gezk`;
type Progress = Parameters<GezelKnowledgePlugin['addListener']>[1];

/** Chunk ids are 32 hex digits, as citation URIs require. */
const uid = (n: number) => n.toString(16).padStart(32, '0');
const rejection = (code: string) => Object.assign(new Error(code), { code });
const unit = [1, ...new Array<number>(383).fill(0)];

function fakePlugin(stored: Record<string, string[]> = {}) {
  const files = new Map(Object.entries(stored));
  const listeners = new Set<Progress>();
  const progress = (id: string, receivedBytes: number, totalBytes: number) => {
    for (const listener of listeners) listener({ id, receivedBytes, totalBytes });
  };
  const plugin = {
    info: vi.fn(async () => ({
      baseUrl: BASE_URL,
      catalogs: [...files].map(([id, names]) => ({ id, files: names })),
    })),
    install: vi.fn<GezelKnowledgePlugin['install']>(async ({ id, version }) => {
      files.set(id, [`${version}/catalog.gezk`]);
      return { id };
    }),
    installModel: vi.fn<GezelKnowledgePlugin['installModel']>(async ({ id, files: specs }) => {
      files.set(
        id,
        specs.map((spec) => spec.name),
      );
      return { id };
    }),
    embed: vi.fn<GezelKnowledgePlugin['embed']>(async () => ({ vector: unit })),
    cancelInstall: vi.fn(async () => undefined),
    remove: vi.fn(async ({ id }: { id: string }) => void files.delete(id)),
    addListener: vi.fn(async (_event: 'knowledgeDownload', listener: Progress) => {
      listeners.add(listener);
      return { remove: async () => void listeners.delete(listener) };
    }),
  } satisfies GezelKnowledgePlugin;
  return { plugin, files, progress };
}

function hit(chunkUid: string, documentId: string, cosine?: number) {
  return {
    catalogKey: KEY,
    catalogId: CATALOG.id,
    chunkUid,
    documentId,
    title: documentId,
    headingPath: [],
    lineStart: 1,
    lineEnd: 2,
    text: `${documentId} passage`,
    ...(cosine === undefined ? {} : { cosine }),
    source: cosine === undefined ? ('fts' as const) : ('vector' as const),
    shardId: 0,
  };
}

/** A catalog whose vector arm finds one document over e5's floor and one under it. */
function fakeHost() {
  const host = {
    mount: vi.fn(async () => undefined),
    unmount: vi.fn(async () => undefined),
    topics: vi.fn(async () => [{ id: 'places', name: 'Places' }]),
    search: vi.fn(async (request: { vector?: Float32Array }) => ({
      chunks: request.vector
        ? [hit(uid(1), 'panama-hotel', 0.89), hit(uid(2), 'space-needle', 0.8)]
        : [hit(uid(3), 'panama-hotel')],
      documents: [],
    })),
    getDocument: vi.fn(async (_key: string, documentId: string) => ({
      documentId,
      title: documentId === 'panama-hotel' ? 'Panama Hotel' : documentId,
      topicId: 'places',
      markdown: `${documentId} body`,
    })),
    getChunk: vi.fn(async (_key: string, documentId: string, chunkUid: string) => ({
      chunkUid,
      documentId,
      text: `${documentId} chunk ${chunkUid}`,
    })),
    terminate: vi.fn(),
  };
  return host as typeof host & KnowledgeCatalogHost;
}

function subject(stored?: Record<string, string[]>) {
  let disabled: readonly string[] = [];
  const fake = fakePlugin(stored);
  const host = fakeHost();
  const writeDisabled = vi.fn((ids: readonly string[]) => {
    disabled = ids;
  });
  const knowledge = createMobileKnowledge({
    workerUrl: 'knowledge-worker.js',
    wasmUrl: 'sqlite3.wasm',
    plugin: fake.plugin,
    host,
    readDisabled: () => disabled,
    writeDisabled,
    downloadRetryDelaysMs: [0, 0],
  });
  const entry = async () =>
    (await knowledge.state()).catalogs.find((catalog) => catalog.id === CATALOG.id)!;
  return { ...fake, host, knowledge, entry, writeDisabled };
}

const query = {
  query: 'Panama Hotel',
  rerank: 'auto' as const,
  maxResults: 4,
  maxCharacters: 2000,
};

afterEach(() => vi.unstubAllGlobals());

describe('createMobileKnowledge', () => {
  it('lists the pinned catalogs and the versions this device holds', async () => {
    const { knowledge } = subject({ [CATALOG.id]: ['2025.1.0/catalog.gezk'] });
    const state = await knowledge.state();
    expect(state.catalogs).toHaveLength(mobileKnowledgeCatalogs.length);
    expect(state.catalogs.find((c) => c.id === CATALOG.id)).toMatchObject({
      version: CATALOG.version,
      installedVersion: '2025.1.0',
      enabled: true,
      updateAvailable: true,
      state: 'installed',
    });
    expect(state.catalogs.find((c) => c.id !== CATALOG.id)).toMatchObject({
      installedVersion: null,
      state: 'available',
      downloadBytes: expect.any(Number),
    });
    expect(state.improvement).toBeNull();
  });

  it("downloads the pinned archive, then its profile's query model, as one job", async () => {
    vi.stubGlobal('fetch', serveTokenizer(MODEL_ID));
    const { knowledge, plugin, host, progress, entry } = subject();
    let finish = () => {};
    plugin.install.mockImplementationOnce(async ({ id, version }) => {
      progress(id, CATALOG.archiveBytes / 2, CATALOG.archiveBytes);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return plugin.install.getMockImplementation()!({ id, version, url: '', sha256: '', size: 0 });
    });
    await knowledge.update({ action: 'install', catalogId: CATALOG.id });
    await vi.waitFor(() => expect(plugin.install).toHaveBeenCalled());
    const modelBytes = MODEL.files.reduce((sum, file) => sum + file.size, 0);
    expect(await entry()).toMatchObject({
      state: 'downloading',
      percent: (CATALOG.archiveBytes / 2 / (CATALOG.archiveBytes + modelBytes)) * 100,
    });
    finish();
    await vi.waitFor(() => expect(host.mount).toHaveBeenCalled());
    expect(plugin.install).toHaveBeenCalledWith({
      id: CATALOG.id,
      version: CATALOG.version,
      url: knowledgeCatalogUrl(CATALOG),
      sha256: CATALOG.sha256,
      size: CATALOG.archiveBytes,
    });
    expect(plugin.installModel).toHaveBeenCalledWith({ id: MODEL_ID, files: MODEL.files });
    expect(host.mount).toHaveBeenCalledWith({
      key: KEY,
      rootDir: `/${CATALOG.id}/${CATALOG.version}/catalog.gezk`,
      catalogId: CATALOG.id,
      version: CATALOG.version,
    });
    expect(await entry()).toMatchObject({ state: 'installed', installedVersion: CATALOG.version });
  });

  it('skips the query model when the device already has it', async () => {
    const { knowledge, plugin, host } = subject({
      [MODEL_ID]: MODEL.files.map((file) => file.name),
    });
    vi.stubGlobal('fetch', serveTokenizer(MODEL_ID));
    await knowledge.update({ action: 'install', catalogId: CATALOG.id });
    await vi.waitFor(() => expect(host.mount).toHaveBeenCalled());
    expect(plugin.installModel).not.toHaveBeenCalled();
  });

  it('retries an interrupted download while it makes progress, then explains', async () => {
    const { knowledge, plugin, progress, entry } = subject();
    let attempt = 0;
    plugin.install.mockImplementation(async ({ id }) => {
      attempt++;
      if (attempt <= 2) progress(id, attempt * 1000, CATALOG.archiveBytes);
      throw rejection('interrupted');
    });
    await knowledge.update({ action: 'install', catalogId: CATALOG.id });
    await vi.waitFor(async () => expect((await entry()).state).toBe('error'));
    // Two attempts that saved bytes, then the first stalled attempt and its two retries.
    expect(plugin.install).toHaveBeenCalledTimes(4);
    expect((await entry()).message).toBe(
      'The download stopped. Download the catalog again to continue where it stopped.',
    );
  });

  it.each([
    ['storage', 'This catalog could not be saved. Free up storage on this device and try again.'],
    ['verification', 'The catalog download failed. Try downloading it again.'],
  ])('explains a %s failure without retrying', async (code, message) => {
    const { knowledge, plugin, entry } = subject();
    plugin.install.mockRejectedValue(rejection(code));
    await knowledge.update({ action: 'install', catalogId: CATALOG.id });
    await vi.waitFor(async () => expect((await entry()).state).toBe('error'));
    expect(plugin.install).toHaveBeenCalledTimes(1);
    expect((await entry()).message).toBe(message);
  });

  it('leaves no error behind a cancelled download', async () => {
    const { knowledge, plugin, entry } = subject();
    plugin.install.mockRejectedValue(rejection('cancelled'));
    await knowledge.update({ action: 'install', catalogId: CATALOG.id });
    await vi.waitFor(() => expect(plugin.install).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await entry()).state).toBe('available'));
  });

  it('refuses a catalog outside the pinned snapshot', async () => {
    const { knowledge } = subject();
    await expect(
      knowledge.update({ action: 'install', catalogId: 'not-a-catalog' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('searches only enabled catalogs', async () => {
    const { knowledge, host, writeDisabled, entry } = subject({ [CATALOG.id]: [ARCHIVE] });
    await knowledge.retrieve(query);
    expect(host.mount).toHaveBeenCalledTimes(1);
    await knowledge.update({ action: 'disable', catalogId: CATALOG.id });
    expect(writeDisabled).toHaveBeenLastCalledWith([CATALOG.id]);
    expect(host.unmount).toHaveBeenCalledWith(KEY);
    expect(await entry()).toMatchObject({ enabled: false });
    expect(await knowledge.retrieve(query)).toEqual({ reranked: true, passages: [] });
    await knowledge.update({ action: 'enable', catalogId: CATALOG.id });
    expect(writeDisabled).toHaveBeenLastCalledWith([]);
    expect(host.mount).toHaveBeenCalledTimes(2);
  });

  it("admits only vector evidence over the profile's floor", async () => {
    vi.stubGlobal('fetch', serveTokenizer(MODEL_ID));
    const { knowledge, host, plugin } = subject({
      [CATALOG.id]: [ARCHIVE],
      [MODEL_ID]: MODEL.files.map((file) => file.name),
    });
    const result = await knowledge.retrieve(query);
    expect(plugin.embed).toHaveBeenCalled();
    expect(host.search).toHaveBeenCalledWith(
      expect.objectContaining({ vector: expect.any(Float32Array) }),
    );
    expect(result).toEqual({
      reranked: false,
      passages: [
        {
          uri: expect.stringContaining('panama-hotel'),
          title: 'Panama Hotel',
          text: `panama-hotel chunk ${uid(1)}`,
          catalogId: CATALOG.id,
          version: CATALOG.version,
        },
      ],
    });
  });

  it('admits nothing from keyword search alone', async () => {
    const { knowledge, host } = subject({ [CATALOG.id]: [ARCHIVE] });
    expect(await knowledge.retrieve(query)).toEqual({ reranked: false, passages: [] });
    expect(host.search).toHaveBeenCalledWith(
      expect.not.objectContaining({ vector: expect.anything() }),
    );
  });

  it('keeps passages within the character budget', async () => {
    vi.stubGlobal('fetch', serveTokenizer(MODEL_ID));
    const { knowledge } = subject({
      [CATALOG.id]: [ARCHIVE],
      [MODEL_ID]: MODEL.files.map((file) => file.name),
    });
    const { passages } = await knowledge.retrieve({ ...query, maxCharacters: 6 });
    expect(passages.map((passage) => passage.text)).toEqual(['panama']);
  });

  it('has no relevance model to offer or require', async () => {
    const { knowledge } = subject({ [CATALOG.id]: [ARCHIVE] });
    await expect(knowledge.update({ action: 'prepare-reranker' })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(knowledge.retrieve({ ...query, rerank: 'required' })).rejects.toMatchObject({
      code: 'reranker_required',
    });
  });

  it('removes a catalog from search and from the device', async () => {
    const { knowledge, host, plugin, entry } = subject({ [CATALOG.id]: [ARCHIVE] });
    await knowledge.retrieve(query);
    await knowledge.update({ action: 'remove', catalogId: CATALOG.id });
    expect(host.unmount).toHaveBeenCalledWith(KEY);
    expect(plugin.remove).toHaveBeenCalledWith({ id: CATALOG.id });
    expect(await entry()).toMatchObject({ state: 'available', installedVersion: null });
  });
});
