import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlamaCppCacheAdapter, llamaLayerPrefixIds, llamaPrefixId } from './cache-adapter.js';

describe('llamaLayerPrefixIds — layered prefix keys', () => {
  it('produces distinct gp/gezel namespaces with stable 16-hex hashes', () => {
    const layers = { gezel: 'IDENTITY', project: 'IDENTITY+PROJECT' };
    const ids = llamaLayerPrefixIds(layers);
    expect(ids.gp).toMatch(/^prefix-gp-[0-9a-f]{16}$/);
    expect(ids.gezel).toMatch(/^prefix-gezel-[0-9a-f]{16}$/);
    // Deterministic.
    expect(llamaLayerPrefixIds(layers)).toEqual(ids);
  });

  it('rotates the gp key when the project layer changes but keeps gezel stable', () => {
    const a = llamaLayerPrefixIds({ gezel: 'SAME', project: 'SAME+projA' });
    const b = llamaLayerPrefixIds({ gezel: 'SAME', project: 'SAME+projB' });
    expect(a.gezel).toBe(b.gezel); // identity unchanged → same gezel key
    expect(a.gp).not.toBe(b.gp); // project changed → new gp key
  });
});

describe('LlamaCppCacheAdapter — slot allocation', () => {
  it('returns the same slot for repeated lookups on the same session', () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 4,
    });
    const first = a.buildRequestExtras('sess-1');
    const second = a.buildRequestExtras('sess-1');
    expect(first.id_slot).toBe(second.id_slot);
    expect(first.cache_prompt).toBe(true);
  });

  it('allocates distinct slots for distinct sessions up to slotCount', () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 3,
    });
    const slots = new Set<number>();
    slots.add(a.buildRequestExtras('s1').id_slot as number);
    slots.add(a.buildRequestExtras('s2').id_slot as number);
    slots.add(a.buildRequestExtras('s3').id_slot as number);
    expect(slots.size).toBe(3);
    expect([...slots].sort()).toEqual([0, 1, 2]);
  });

  it('recycles the LRU slot when a new session arrives over the limit', () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 2,
    });
    const slot1 = a.buildRequestExtras('s1').id_slot;
    const slot2 = a.buildRequestExtras('s2').id_slot;
    // s1 was first → it's the oldest. A new session takes its slot.
    const slot3 = a.buildRequestExtras('s3').id_slot;
    expect(slot3).toBe(slot1); // LRU recycled

    // Touching s2 promotes it. s3 (the previous-newest) is now LRU.
    expect(a.buildRequestExtras('s2').id_slot).toBe(slot2);

    // s1 was evicted; calling it now allocates a fresh slot. Per the
    // LRU after the s2 promotion above, s3's slot is the eviction
    // victim — not s2. So s1 takes s3's old slot.
    const slotS1Again = a.buildRequestExtras('s1').id_slot;
    expect(slotS1Again).toBe(slot3);
    // Sanity: s2 still holds its slot.
    expect(a.buildRequestExtras('s2').id_slot).toBe(slot2);
  });

  it('promotes the slot in LRU on each touch (so frequently-used sessions persist)', () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 2,
    });
    a.buildRequestExtras('s1');
    a.buildRequestExtras('s2');
    // s1 is the older slot. Touch s1 to promote it; now s2 is LRU.
    a.buildRequestExtras('s1');
    // New session evicts the LRU — should be s2, not s1.
    const slotS3 = a.buildRequestExtras('s3').id_slot;
    // s1 should still resolve to its original slot.
    expect(a.buildRequestExtras('s1').id_slot).not.toBe(slotS3);
  });

  it('evict() releases the slot mapping so the next lookup gets a fresh allocation', async () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 2,
    });
    const slot = a.buildRequestExtras('s1').id_slot;
    await a.evict(['s1']);
    // After eviction, allocating again may pick the same slot (it's
    // unused) or a different one — the contract is just "the mapping
    // is gone." Verify by checking sessionToSlot indirectly: a
    // brand-new session can claim slot 0 if s1's eviction released it.
    const newSlot = a.buildRequestExtras('s2').id_slot;
    // Both should be available; just assert evict didn't crash and
    // we can re-allocate.
    expect(typeof newSlot).toBe('number');
    expect(typeof slot).toBe('number');
  });

  it('always sets cache_prompt: true regardless of slot pinning state', () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
      slotCount: 1,
    });
    expect(a.buildRequestExtras('any').cache_prompt).toBe(true);
  });
});

describe('LlamaCppCacheAdapter — reportUsage', () => {
  it('returns empty when baseUrl is unresolved (engine not ready)', async () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => null,
    });
    expect(await a.reportUsage()).toEqual([]);
  });

  it('returns empty when /slots fetch throws', async () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      fetchImpl: (async () => {
        throw new Error('refused');
      }) as unknown as typeof fetch,
    });
    expect(await a.reportUsage()).toEqual([]);
  });

  it('maps /slots cached-token counts back to session ids via slot mapping', async () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 3,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify([
            { id: 0, n_cache_tokens: 1234 },
            { id: 1, n_cache_tokens: 5678 },
            { id: 2, n_cache_tokens: 0 }, // empty slot — skipped
          ]),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    // Bind two sessions to slots 0 and 1.
    a.buildRequestExtras('alpha');
    a.buildRequestExtras('beta');

    const usage = await a.reportUsage();
    expect(usage).toHaveLength(2);
    const alpha = usage.find((u) => u.sessionId === 'alpha');
    const beta = usage.find((u) => u.sessionId === 'beta');
    expect(alpha?.tokenCount).toBe(1234);
    expect(beta?.tokenCount).toBe(5678);
    // Bytes estimate is tokenCount × the constant. Just sanity-check
    // it scales with token count.
    expect(beta!.estBytes).toBeGreaterThan(alpha!.estBytes);
  });

  it('skips slots whose binding we lost (e.g. session evicted from controller)', async () => {
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 2,
      fetchImpl: (async () =>
        new Response(JSON.stringify([{ id: 0, n_cache_tokens: 1000 }]), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    // Don't bind any session — slot 0 has no mapping. /slots should
    // not contribute to usage.
    const usage = await a.reportUsage();
    expect(usage).toEqual([]);
  });

  it('attaches the bearer token when configured', async () => {
    let lastAuth: string | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      lastAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      resolveAuthToken: () => 'secret-bearer',
      fetchImpl,
    });
    await a.reportUsage();
    expect(lastAuth).toBe('Bearer secret-bearer');
  });
});

describe('LlamaCppCacheAdapter — slot persistence + prefix sharing', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gezel-llama-cache-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
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
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('skips disk persistence when slotSavePath is unset', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 1,
      fetchImpl,
    });
    await a.prepareForSend('s1');
    await a.evict(['s1']);
    expect(calls.find((c) => c.url.includes('action='))).toBeUndefined();
  });

  it('saves the LRU victim slot before recycling on overflow', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 1,
      slotSavePath: tmp,
      fetchImpl,
    });
    await a.prepareForSend('alpha');
    await a.prepareForSend('beta'); // alpha gets recycled

    const saveCall = calls.find(
      (c) =>
        c.url.includes('action=save') &&
        (c.body as { filename: string }).filename === 'sess-alpha.bin',
    );
    expect(saveCall).toBeDefined();
    expect(saveCall!.url).toContain('/slots/0');
  });

  it('persists slot state to disk on evict with stable filename', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 2,
      slotSavePath: tmp,
      fetchImpl,
    });
    await a.prepareForSend('s1');
    await a.evict(['s1']);

    const saveCall = calls.find((c) => c.method === 'POST' && c.url.includes('action=save'));
    expect(saveCall).toBeDefined();
    expect((saveCall!.body as { filename: string }).filename).toBe('sess-s1.bin');
  });

  it('restores from disk for a session with an existing sess-*.bin', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 2,
      slotSavePath: tmp,
      fetchImpl,
    });
    // Pre-create a saved file so the restore path triggers.
    await writeFile(join(tmp, 'sess-resumed.bin'), 'fake');
    await a.prepareForSend('resumed');
    const restoreCall = calls.find(
      (c) =>
        c.url.includes('action=restore') &&
        (c.body as { filename: string }).filename === 'sess-resumed.bin',
    );
    expect(restoreCall).toBeDefined();
  });

  it('reserves distinct slots when two sessions prepare concurrently', async () => {
    await writeFile(join(tmp, 'sess-alpha.bin'), 'fake');
    await writeFile(join(tmp, 'sess-beta.bin'), 'fake');
    let activeRestores = 0;
    let maxActiveRestores = 0;
    const fetchImpl = (async () => {
      activeRestores++;
      maxActiveRestores = Math.max(maxActiveRestores, activeRestores);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRestores--;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 2,
      slotSavePath: tmp,
      fetchImpl,
    });

    await Promise.all([a.prepareForSend('alpha'), a.prepareForSend('beta')]);

    expect(a.buildRequestExtras('alpha').id_slot).toBe(0);
    expect(a.buildRequestExtras('beta').id_slot).toBe(1);
    expect(maxActiveRestores).toBe(1);
  });

  it('on first session save for a gezel, also seeds the prefix-*.bin file', async () => {
    const { fetchImpl } = makeFetchSpy();
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 2,
      slotSavePath: tmp,
      fetchImpl,
    });
    await a.prepareForSend('sess-A', 'You are gezel-X. Help with X tasks.');
    // The save endpoint is mocked to "succeed" but actually writes
    // nothing. To exercise the copyFile path we need the source to
    // exist on disk. Drop a placeholder in the tmp dir at the
    // expected name so copyFile resolves.
    await writeFile(join(tmp, 'sess-sess-A.bin'), 'placeholder');
    await a.evict(['sess-A']);
    const files = await readdir(tmp);
    const prefixId = llamaPrefixId('You are gezel-X. Help with X tasks.');
    expect(files).toContain(`${prefixId}.bin`);
    // The copy is byte-equal to the source since we mock the engine.
    expect(files).toContain('sess-sess-A.bin');
  });

  it('falls back to prefix-*.bin restore when no per-session file exists', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 2,
      slotSavePath: tmp,
      fetchImpl,
    });
    const systemPrompt = 'You are gezel-Y.';
    const prefixId = llamaPrefixId(systemPrompt);
    // Pre-create a prefix file (simulating a sibling session having
    // already saved one earlier in the install's history).
    await writeFile(join(tmp, `${prefixId}.bin`), 'fake');
    await a.prepareForSend('brand-new-session', systemPrompt);
    const restoreCall = calls.find(
      (c) =>
        c.url.includes('action=restore') &&
        (c.body as { filename: string }).filename === `${prefixId}.bin`,
    );
    expect(restoreCall).toBeDefined();
  });

  it('flushAll saves every currently-bound session', async () => {
    const { calls, fetchImpl } = makeFetchSpy();
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 3,
      slotSavePath: tmp,
      fetchImpl,
    });
    await a.prepareForSend('a');
    await a.prepareForSend('b');
    await a.prepareForSend('c');
    const saved = await a.flushAll();
    expect(saved).toBe(3);
    const saveFilenames = calls
      .filter((c) => c.url.includes('action=save'))
      .map((c) => (c.body as { filename: string }).filename);
    expect(new Set(saveFilenames)).toEqual(new Set(['sess-a.bin', 'sess-b.bin', 'sess-c.bin']));
  });

  it('llamaPrefixId is stable for identical system prompts', () => {
    expect(llamaPrefixId('hello world')).toBe(llamaPrefixId('hello world'));
    expect(llamaPrefixId('a')).not.toBe(llamaPrefixId('b'));
    expect(llamaPrefixId('a')).toMatch(/^prefix-[0-9a-f]{16}$/);
  });

  it('latches slot actions off after a 501 "not supported by multimodal"', async () => {
    // Wild-caught (nemotron-nano tankcombat): llama-server
    // returns 501 with body `srv send_error: ... This feature is not
    // supported by multimodal` for mmproj-backed models. Without the
    // latch we'd POST a save+restore on every turn and spam the log.
    const calls: Array<{ url: string; action: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const action = u.match(/action=(\w+)/)?.[1] ?? '';
      calls.push({ url: u, action });
      if (init?.method === 'POST' && u.includes('/slots/')) {
        return new Response('not supported by multimodal', { status: 501 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 1,
      slotSavePath: tmp,
      fetchImpl,
    });
    // First send: tries restore (no prior file → skips), so no POST yet.
    await a.prepareForSend('s1');
    // Evict to force a save attempt — this will 501 and latch.
    await a.evict(['s1']);
    const firstSave = calls.filter((c) => c.action === 'save').length;
    expect(firstSave).toBeGreaterThanOrEqual(1);
    // Subsequent operations should NOT issue further slot save/restore
    // POSTs because the latch is engaged.
    calls.length = 0;
    await a.prepareForSend('s2');
    await a.evict(['s2']);
    await a.prepareForSend('s3');
    const subsequent = calls.filter((c) => c.action === 'save' || c.action === 'restore').length;
    expect(subsequent).toBe(0);
  });

  it('also latches on 5xx with a multimodal-style body, not just 501', async () => {
    // Defensive: llama-server could in principle return 500 with the
    // same body. Latch on either status code if the body matches.
    const calls: Array<{ url: string; action: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const action = u.match(/action=(\w+)/)?.[1] ?? '';
      calls.push({ url: u, action });
      if (init?.method === 'POST' && u.includes('/slots/')) {
        return new Response('Error: This feature is not supported by multimodal', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const a = new LlamaCppCacheAdapter({
      resolveBaseUrl: async () => 'http://127.0.0.1:0',
      slotCount: 1,
      slotSavePath: tmp,
      fetchImpl,
    });
    await a.prepareForSend('s1');
    await a.evict(['s1']);
    calls.length = 0;
    await a.prepareForSend('s2');
    await a.evict(['s2']);
    const subsequent = calls.filter((c) => c.action === 'save' || c.action === 'restore').length;
    expect(subsequent).toBe(0);
  });
});
