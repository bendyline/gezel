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

describe('MlxCacheAdapter — tool roster in the prefix identity', () => {
  it('separates prefixes whose tool rosters differ', () => {
    const sys = 'IDENTICAL SYSTEM PROMPT';
    const rosterA = [
      { function: { name: 'write_file', parameters: { properties: { path: {} } } } },
    ];
    const rosterB = [{ function: { name: 'read_file', parameters: { properties: { path: {} } } } }];
    // Qwen renders the tool block at the top of the system message, so two
    // sessions with different rosters share no token prefix even with the
    // same prompt text. Sharing an id would make every hit a false hit.
    expect(gezelPrefixId(sys, rosterA)).not.toBe(gezelPrefixId(sys, rosterB));
  });

  it('is stable across roster ORDER and description churn', () => {
    const sys = 'IDENTICAL SYSTEM PROMPT';
    const a = [
      { function: { name: 'a', description: 'one', parameters: { properties: { p: {} } } } },
      { function: { name: 'b', description: 'two', parameters: { properties: { q: {} } } } },
    ];
    const b = [
      { function: { name: 'b', description: 'REWORDED', parameters: { properties: { q: {} } } } },
      {
        function: {
          name: 'a',
          description: 'ALSO REWORDED',
          parameters: { properties: { p: {} } },
        },
      },
    ];
    expect(gezelPrefixId(sys, a)).toBe(gezelPrefixId(sys, b));
  });

  it('keeps the no-tools id unchanged (back-compat with existing prefix files)', () => {
    const sys = 'IDENTICAL SYSTEM PROMPT';
    expect(gezelPrefixId(sys, [])).toBe(gezelPrefixId(sys));
  });

  it('warms with tools when the flag is on, and NOT AT ALL when it is off', async () => {
    // Both states are pinned. Flag ON warms with the roster — the warmed
    // tokens are a real prefix of later turns. Flag OFF must not warm a
    // tool-bearing session AT ALL: the old behavior warmed system-only,
    // which renders Qwen's no-tools template branch (~3 shared tokens with
    // the real turn) and persists it, overwriting the good entry the last
    // real session saved back. Wild-caught (koray PR-review fanout):
    // `prefix-0b60345fcefa9ffd` oscillated between the two shapes on every
    // daemon boot — 40 full re-prefills, 1.58M tokens re-prefilled against
    // 238K of new work. The flag still defaults OFF because the paired
    // arms measured warm-with-tools as a reuse regression without the
    // snapshot boundary (34% -> 14%); "no warm" keeps that result while
    // never writing a shape that cannot match.
    const run = async (flag: string | undefined) => {
      const prev = process.env.GEZEL_MLX_STABLE_PREFIX;
      if (flag === undefined) delete process.env.GEZEL_MLX_STABLE_PREFIX;
      else process.env.GEZEL_MLX_STABLE_PREFIX = flag;
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const a = new MlxCacheAdapter({
        resolveBaseUrl: async () => 'http://127.0.0.1:1',
        fetchImpl: (async (url: string, init: { body: string }) => {
          calls.push({ url: String(url), body: JSON.parse(init.body) });
          return { ok: true, json: async () => ({}) };
        }) as unknown as typeof fetch,
      });
      const tools = [
        { function: { name: 'write_file', parameters: { properties: { path: {} } } } },
      ];
      await a.prepareForSend(`sess-${flag ?? 'off'}`, 'system prompt', undefined, tools);
      if (prev === undefined) delete process.env.GEZEL_MLX_STABLE_PREFIX;
      else process.env.GEZEL_MLX_STABLE_PREFIX = prev;
      return calls.find((c) => c.url.includes('/v1/cache/warm'));
    };

    const on = await run('1');
    expect(on, 'a warm request should have been issued').toBeTruthy();
    expect(on?.body.tools).toBeTruthy();

    const off = await run(undefined);
    expect(off, 'flag off must not warm a tool-bearing prefix at all').toBeUndefined();
  });

  it('still warms a genuinely tool-less session system-only', async () => {
    // A no-tools render IS the token prefix of a no-tools turn — skipping
    // the warm here would throw away the one case where the system-only
    // warm has always been correct.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const a = new MlxCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:1',
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    await a.prepareForSend('sess-no-tools', 'system prompt', undefined, []);
    const warm = calls.find((c) => c.url.includes('/v1/cache/warm'));
    expect(warm, 'the tool-less warm should have been issued').toBeTruthy();
    expect(warm?.body.tools).toBeUndefined();
    expect(warm?.body.persist).toBe(true);
  });

  it('routes save-backs by roster: registration alone still separates rosters', async () => {
    // Flag off, tools present: no warm fires, but the session must still
    // be registered under a roster-aware id so its save-back cannot land
    // in (or later seed from) another roster's entry.
    const a = new MlxCacheAdapter({ resolveBaseUrl: async () => null });
    const rosterA = [
      { function: { name: 'write_file', parameters: { properties: { path: {} } } } },
    ];
    const rosterB = [{ function: { name: 'read_file', parameters: { properties: { path: {} } } } }];
    await a.prepareForSend('sess-a', 'IDENTICAL SYSTEM PROMPT', undefined, rosterA);
    await a.prepareForSend('sess-b', 'IDENTICAL SYSTEM PROMPT', undefined, rosterB);
    const idA = a.buildRequestExtras('sess-a').prefix_cache_id;
    const idB = a.buildRequestExtras('sess-b').prefix_cache_id;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  it('folds the roster into the layered gp/gezel ids', () => {
    const layers = { gezel: 'GEZEL LAYER', project: 'PROJECT LAYER' };
    const rosterA = [
      { function: { name: 'write_file', parameters: { properties: { path: {} } } } },
    ];
    const rosterB = [{ function: { name: 'read_file', parameters: { properties: { path: {} } } } }];
    // Same layer text, different rosters: the server seeds session caches
    // from these entries before any LCP check, so an id collision is a
    // wrong-shape seed, not a miss.
    expect(gezelLayerPrefixIds(layers, rosterA)).not.toEqual(gezelLayerPrefixIds(layers, rosterB));
    // No-roster ids stay byte-identical to the pre-roster scheme so
    // existing tool-less prefix files stay warm across the upgrade.
    expect(gezelLayerPrefixIds(layers, [])).toEqual(gezelLayerPrefixIds(layers));
  });
});
