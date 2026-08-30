import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bendyline/squisq-editor-react', () => ({
  createHarperProofingProvider: vi.fn((config: unknown) => ({ config })),
}));

/**
 * Re-import with a clean module registry: the provider seeds its
 * dictionary from localStorage at module scope, so a test that wants to
 * observe that has to arrange storage before the import runs.
 */
async function load() {
  vi.resetModules();
  return import('./proofing.js');
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('proofing provider', () => {
  it('points the engine at the binary gezel serves itself', async () => {
    const { gezelProofingProvider } = await load();
    const { config } = gezelProofingProvider() as unknown as { config: { wasmUrl: string } };
    expect(config.wasmUrl).toBe('/harper/harper_wasm_bg.wasm');
  });

  it('builds nothing until first use', async () => {
    // Importing the SquisqIntegration barrel must not reach into squisq at
    // module-evaluation time — that broke every unrelated test mocking
    // @bendyline/squisq-editor-react.
    const { createHarperProofingProvider } = await import('@bendyline/squisq-editor-react');
    vi.mocked(createHarperProofingProvider).mockClear();
    const { gezelProofingProvider } = await load();
    expect(createHarperProofingProvider).not.toHaveBeenCalled();

    gezelProofingProvider();
    expect(createHarperProofingProvider).toHaveBeenCalledTimes(1);
  });

  it('reuses one warm instance, and is never handed over as a factory', async () => {
    // Squisq disposes a provider it created from a factory on unmount. The
    // editors remount on every document switch and harper's cold WASM setup
    // is ~5s, so callers must pass the INSTANCE this returns.
    const { gezelProofingProvider } = await load();
    const first = gezelProofingProvider();
    expect(gezelProofingProvider()).toBe(first);
    expect(typeof first).not.toBe('function');
  });

  it('seeds the engine with previously accepted words and appends new ones', async () => {
    window.localStorage.setItem('gezel:proof-dictionary', JSON.stringify(['gezel', 'poppetje']));
    const { gezelProofingProvider } = await load();
    const { config } = gezelProofingProvider() as unknown as {
      config: { initialWords: string[]; onDictionaryWord: (w: string) => void };
    };

    expect(config.initialWords).toEqual(['gezel', 'poppetje']);

    config.onDictionaryWord('craftbook');
    expect(JSON.parse(window.localStorage.getItem('gezel:proof-dictionary') ?? '[]')).toEqual([
      'gezel',
      'poppetje',
      'craftbook',
    ]);
  });

  it('supplies onDictionaryWord, which is what shows the app-wide menu item', async () => {
    // squisq reports `hasAppDictionary: onDictionaryWord != null` and hides
    // "Add to dictionary" when it is false, so a word can never look saved
    // app-wide and then reappear on the next launch.
    const { gezelProofingProvider } = await load();
    const { config } = gezelProofingProvider() as unknown as { config: Record<string, unknown> };
    expect(typeof config.onDictionaryWord).toBe('function');
  });

  it('ignores unreadable dictionary storage rather than failing to construct', async () => {
    window.localStorage.setItem('gezel:proof-dictionary', 'not json');
    const { gezelProofingProvider } = await load();
    const { config } = gezelProofingProvider() as unknown as { config: { initialWords: string[] } };
    expect(config.initialWords).toEqual([]);
  });
});

describe('proofing ignore store', () => {
  it('round-trips the engine payload verbatim, keyed by file path', async () => {
    const { gezelProofingIgnoreStore } = await load();
    // Context hashes exceed 2^53, so the payload is opaque: stored and
    // returned as-is, never parsed.
    const opaque = '{"hashes":[9007199254740993,9007199254740995]}';
    const doc = { articleId: 'a1', fileName: 'notes/plan.md' };

    gezelProofingIgnoreStore.save(doc, opaque);
    expect(gezelProofingIgnoreStore.load(doc)).toBe(opaque);
  });

  it('keys by articleId when the document has no file name', async () => {
    const { gezelProofingIgnoreStore } = await load();
    gezelProofingIgnoreStore.save({ articleId: 'scratch' }, 'payload');

    expect(gezelProofingIgnoreStore.load({ articleId: 'scratch' })).toBe('payload');
    expect(gezelProofingIgnoreStore.load({ articleId: 'other' })).toBeUndefined();
  });

  it('does not leak one document’s dismissals into another', async () => {
    const { gezelProofingIgnoreStore } = await load();
    gezelProofingIgnoreStore.save({ articleId: 'a', fileName: 'one.md' }, 'first');
    gezelProofingIgnoreStore.save({ articleId: 'b', fileName: 'two.md' }, 'second');

    expect(gezelProofingIgnoreStore.load({ articleId: 'a', fileName: 'one.md' })).toBe('first');
    expect(gezelProofingIgnoreStore.load({ articleId: 'b', fileName: 'two.md' })).toBe('second');
  });

  it('caps the record so it cannot exhaust the shared storage budget', async () => {
    const { gezelProofingIgnoreStore } = await load();
    for (let i = 0; i < 260; i += 1) {
      gezelProofingIgnoreStore.save({ articleId: `a${i}`, fileName: `doc-${i}.md` }, `state-${i}`);
    }

    const record = JSON.parse(window.localStorage.getItem('gezel:proof-ignored') ?? '{}');
    expect(Object.keys(record)).toHaveLength(250);
    // Oldest touched are dropped; the most recent are kept.
    expect(record['doc-0.md']).toBeUndefined();
    expect(record['doc-259.md']).toBe('state-259');
  });

  it('keeps a document alive in the cap by re-saving it', async () => {
    const { gezelProofingIgnoreStore } = await load();
    const veteran = { articleId: 'v', fileName: 'veteran.md' };
    gezelProofingIgnoreStore.save(veteran, 'old');

    for (let i = 0; i < 249; i += 1) {
      gezelProofingIgnoreStore.save({ articleId: `a${i}`, fileName: `doc-${i}.md` }, `state-${i}`);
    }
    gezelProofingIgnoreStore.save(veteran, 'refreshed');
    for (let i = 249; i < 300; i += 1) {
      gezelProofingIgnoreStore.save({ articleId: `a${i}`, fileName: `doc-${i}.md` }, `state-${i}`);
    }

    expect(gezelProofingIgnoreStore.load(veteran)).toBe('refreshed');
  });

  it('survives a storage failure instead of breaking the editor', async () => {
    const { gezelProofingIgnoreStore } = await load();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    expect(() =>
      gezelProofingIgnoreStore.save({ articleId: 'a', fileName: 'one.md' }, 'payload'),
    ).not.toThrow();
  });
});
