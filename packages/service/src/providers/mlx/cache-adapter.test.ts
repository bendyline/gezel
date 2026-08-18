import { describe, expect, it } from 'vitest';
import { MlxCacheAdapter, gezelLayerPrefixIds, gezelPrefixId } from './cache-adapter.js';

describe('MlxCacheAdapter — layered prefix caching', () => {
  it('gezelLayerPrefixIds: distinct gp/gezel namespaces, stable, gp rotates with project', () => {
    const a = gezelLayerPrefixIds({ gezel: 'IDENT', project: 'IDENT+projA' });
    expect(a.gp).toMatch(/^prefix-gp-[0-9a-f]{16}$/);
    expect(a.gezel).toMatch(/^prefix-gezel-[0-9a-f]{16}$/);
    expect(gezelLayerPrefixIds({ gezel: 'IDENT', project: 'IDENT+projA' })).toEqual(a);
    const b = gezelLayerPrefixIds({ gezel: 'IDENT', project: 'IDENT+projB' });
    expect(b.gezel).toBe(a.gezel); // identity unchanged
    expect(b.gp).not.toBe(a.gp); // project changed
  });

  it('buildRequestExtras emits prefix_cache_ids (most-specific first) under layered prepareForSend', async () => {
    const adapter = new MlxCacheAdapter({ resolveBaseUrl: async () => null });
    await adapter.prepareForSend('sess-1', 'STABLE SYSTEM', {
      gezel: 'IDENT',
      project: 'IDENT+PROJECT',
    });
    const extras = adapter.buildRequestExtras('sess-1') as {
      cache_id: string;
      prefix_cache_ids?: string[];
      prefix_cache_id?: string;
    };
    expect(extras.cache_id).toBe('sess-1');
    expect(extras.prefix_cache_ids).toHaveLength(2);
    expect(extras.prefix_cache_ids?.[0]).toMatch(/^prefix-gp-/);
    expect(extras.prefix_cache_ids?.[1]).toMatch(/^prefix-gezel-/);
    // Back-compat singular = most-specific.
    expect(extras.prefix_cache_id).toBe(extras.prefix_cache_ids?.[0]);
  });

  it('legacy (no layers) still emits the singular prefix_cache_id', async () => {
    const adapter = new MlxCacheAdapter({ resolveBaseUrl: async () => null });
    await adapter.prepareForSend('sess-2', 'STABLE SYSTEM');
    const extras = adapter.buildRequestExtras('sess-2') as {
      prefix_cache_ids?: string[];
      prefix_cache_id?: string;
    };
    expect(extras.prefix_cache_ids).toBeUndefined();
    expect(extras.prefix_cache_id).toBe(gezelPrefixId('STABLE SYSTEM'));
  });
});

function makeFetchSpy() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(url), method: init?.method ?? 'GET', body });
    return new Response(JSON.stringify({ warmed: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('MlxCacheAdapter — buildRequestExtras', () => {
  it('always includes cache_id keyed on the session', () => {
    const a = new MlxCacheAdapter({ resolveBaseUrl: async () => null });
    expect(a.buildRequestExtras('sess-1')).toEqual({ cache_id: 'sess-1' });
  });

  it('includes prefix_cache_id once a system prompt has been registered', () => {
    const a = new MlxCacheAdapter({ resolveBaseUrl: async () => null });
    a.setSessionPrefix('sess-1', 'Stable system prompt for gezel A.');
    const extras = a.buildRequestExtras('sess-1');
    expect(extras.cache_id).toBe('sess-1');
    expect(extras.prefix_cache_id).toBe(gezelPrefixId('Stable system prompt for gezel A.'));
  });

  it('different gezels get different prefix ids', () => {
    expect(gezelPrefixId('You are A.')).not.toBe(gezelPrefixId('You are B.'));
    expect(gezelPrefixId('A')).toMatch(/^prefix-[0-9a-f]{16}$/);
  });
});

describe('MlxCacheAdapter — prepareForSend', () => {
  it('awaits warmPrefix on first call', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new MlxCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      fetchImpl,
    });
    await a.prepareForSend('sess-1', 'system prompt');
    const warm = calls.find((c) => c.url.endsWith('/v1/cache/warm'));
    expect(warm).toBeDefined();
    expect(warm!.method).toBe('POST');
    const body = warm!.body as { cache_id: string; persist: boolean; messages: unknown[] };
    expect(body.cache_id).toBe(gezelPrefixId('system prompt'));
    expect(body.persist).toBe(true);
  });

  it('does NOT fire a second warm for the same prefix in the same process', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new MlxCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      fetchImpl,
    });
    await a.prepareForSend('sess-1', 'shared prompt');
    await a.prepareForSend('sess-2', 'shared prompt');
    const warmCalls = calls.filter((c) => c.url.endsWith('/v1/cache/warm'));
    expect(warmCalls).toHaveLength(1);
  });

  it('joins concurrent warmers for the same prefix instead of submitting duplicate work', async () => {
    let releaseFetch = (): void => {};
    let markStarted = (): void => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      markStarted();
      await fetchGate;
      return new Response(JSON.stringify({ warmed: true }), { status: 200 });
    }) as typeof fetch;
    const a = new MlxCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      fetchImpl,
    });

    const first = a.prepareForSend('sess-1', 'shared prompt');
    await fetchStarted;
    const second = a.prepareForSend('sess-2', 'shared prompt');
    await Promise.resolve();
    expect(fetchCalls).toBe(1);

    releaseFetch();
    await Promise.all([first, second]);
    expect(fetchCalls).toBe(1);
  });

  it('routes prefix warming through the exclusive engine gate', async () => {
    const { fetchImpl } = makeFetchSpy();
    const labels: string[] = [];
    const a = new MlxCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      fetchImpl,
      runExclusive: async (label, work) => {
        labels.push(label);
        return work();
      },
    });
    await a.prepareForSend('sess-1', 'system prompt');
    expect(labels).toEqual([`cache-prefix:${gezelPrefixId('system prompt')}`]);
  });

  it('no-ops when systemPrompt is undefined', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new MlxCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      fetchImpl,
    });
    await a.prepareForSend('sess-1', undefined);
    expect(a.buildRequestExtras('sess-1')).toEqual({ cache_id: 'sess-1' });
    expect(calls).toHaveLength(0);
  });
});

describe('MlxCacheAdapter — evict', () => {
  it('clears the prefix mapping for evicted sessions', async () => {
    const { fetchImpl } = makeFetchSpy();
    const a = new MlxCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      fetchImpl,
    });
    a.setSessionPrefix('s1', 'prompt');
    expect(a.buildRequestExtras('s1').prefix_cache_id).toBeDefined();
    await a.evict(['s1']);
    expect(a.buildRequestExtras('s1').prefix_cache_id).toBeUndefined();
  });
});
