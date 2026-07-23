import { type GezelConfig, securityPolicyForLevel } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretKey, SecretStore } from '../../secrets/types.js';
import { BraveSearchProvider } from './brave.js';
import { ChainedSearchProvider } from './chained.js';
import { createSearchProvider } from './factory.js';
import { MockSearchProvider } from './mock.js';
import { WikipediaSearchProvider } from './wikipedia.js';

function fakeStore(config: GezelConfig): Store {
  return {
    readConfig: async () => ({
      securityPolicy: securityPolicyForLevel('free'),
      ...config,
    }),
  } as unknown as Store;
}

function fakeSecrets(values: Partial<Record<string, string>> = {}): SecretStore {
  return {
    backend: 'file',
    async get(key: SecretKey): Promise<string | null> {
      if (key.kind !== 'providerCredential') return null;
      return values[key.name] ?? null;
    },
    async set() {},
    async delete() {},
    async has() {
      return false;
    },
    async listForToolset() {
      return [];
    },
  };
}

describe('createSearchProvider', () => {
  it('returns Mock when GEZEL_MOCK_PROVIDER=1', async () => {
    const p = await createSearchProvider({
      store: fakeStore({}),
      secrets: fakeSecrets(),
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    expect(p).toBeInstanceOf(MockSearchProvider);
  });

  it('defaults to Wikipedia when nothing is configured', async () => {
    const p = await createSearchProvider({
      store: fakeStore({}),
      secrets: fakeSecrets(),
      env: {},
    });
    expect(p).toBeInstanceOf(WikipediaSearchProvider);
  });

  it('returns Brave with unavailableReason when configured but no key', async () => {
    const p = await createSearchProvider({
      store: fakeStore({ webSearch: { provider: 'brave' } }),
      secrets: fakeSecrets({}),
      env: {},
    });
    expect(p).toBeInstanceOf(BraveSearchProvider);
    expect(p.unavailableReason).toMatch(/Brave/);
  });

  it('returns Brave (available) when key is set', async () => {
    const p = await createSearchProvider({
      store: fakeStore({ webSearch: { provider: 'brave' } }),
      secrets: fakeSecrets({ braveSearchApiKey: 'k' }),
      env: {},
    });
    expect(p).toBeInstanceOf(BraveSearchProvider);
    expect(p.unavailableReason).toBeUndefined();
  });

  it('wraps in ChainedSearchProvider when fallbackProvider is set', async () => {
    const p = await createSearchProvider({
      store: fakeStore({
        webSearch: { provider: 'brave', fallbackProvider: 'wikipedia' },
      }),
      secrets: fakeSecrets({}),
      env: {},
    });
    expect(p).toBeInstanceOf(ChainedSearchProvider);
  });

  it('does not wrap when primary === fallback', async () => {
    const p = await createSearchProvider({
      store: fakeStore({
        webSearch: { provider: 'brave', fallbackProvider: 'brave' },
      }),
      secrets: fakeSecrets({ braveSearchApiKey: 'k' }),
      env: {},
    });
    expect(p).toBeInstanceOf(BraveSearchProvider);
  });
});

describe('ChainedSearchProvider', () => {
  it('falls back when primary is unavailable', async () => {
    const fallback = new MockSearchProvider();
    const primary = new BraveSearchProvider({ apiKey: null });
    const chained = new ChainedSearchProvider(primary, fallback);
    const out = await chained.search({ query: 'q', limit: 2 }, new AbortController().signal);
    expect(out[0]?.source).toBe('mock');
  });

  it('falls back when primary throws', async () => {
    const fallback = new MockSearchProvider();
    const primary: import('./types.js').SearchProvider = {
      name: 'brave',
      async search() {
        throw new Error('upstream 500');
      },
    };
    const chained = new ChainedSearchProvider(primary, fallback);
    const out = await chained.search({ query: 'q', limit: 1 }, new AbortController().signal);
    expect(out[0]?.source).toBe('mock');
  });

  it('does not fall back on abort', async () => {
    const fallback = new MockSearchProvider();
    const primary: import('./types.js').SearchProvider = {
      name: 'brave',
      async search(_input, signal) {
        signal.throwIfAborted?.();
        throw new Error('aborted');
      },
    };
    const chained = new ChainedSearchProvider(primary, fallback);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(chained.search({ query: 'q', limit: 1 }, ctrl.signal)).rejects.toThrow();
  });
});
