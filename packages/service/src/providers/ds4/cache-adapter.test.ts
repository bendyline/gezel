import { describe, expect, it, vi } from 'vitest';
import { Ds4CacheAdapter } from './cache-adapter.js';

function makeAdapter(over: Partial<ConstructorParameters<typeof Ds4CacheAdapter>[0]> = {}) {
  const prefillSession = vi.fn(async () => true);
  const adapter = new Ds4CacheAdapter({
    resolveBaseUrl: () => 'http://127.0.0.1:9999',
    isBusy: () => false,
    prefillSession,
    ...over,
  });
  return { adapter, prefillSession };
}

const MSGS = [
  { role: 'user' as const, content: '[Checkers page]: Your opponent played c3-d4.' },
  { role: 'assistant' as const, content: 'A quiet start — my move lands on e5.' },
];

describe('Ds4CacheAdapter', () => {
  it('attaches no per-request extras (engine keys KV by token text)', () => {
    const { adapter } = makeAdapter();
    expect(adapter.buildRequestExtras('sess-1')).toEqual({});
  });

  it('evict and reportUsage are contractual no-ops', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.evict(['sess-1'])).resolves.toBeUndefined();
    await expect(adapter.reportUsage()).resolves.toEqual([]);
  });

  it('declares warmsFromSessionState so empty-transcript sessions still warm', () => {
    const { adapter } = makeAdapter();
    expect(adapter.warmsFromSessionState).toBe(true);
  });

  it('warm delegates to prefillSession — never builds its own request', async () => {
    const { adapter, prefillSession } = makeAdapter();
    await adapter.warm('sess-1', MSGS);
    expect(prefillSession).toHaveBeenCalledTimes(1);
    expect(prefillSession).toHaveBeenCalledWith('sess-1');
  });

  it('warms an empty transcript (the [system][tools] block dominates the prefix)', async () => {
    const { adapter, prefillSession } = makeAdapter();
    await adapter.warm('sess-1', []);
    expect(prefillSession).toHaveBeenCalledTimes(1);
  });

  it('skips when the engine is busy — warms never contend the single ds4 lane', async () => {
    const { adapter, prefillSession } = makeAdapter({ isBusy: () => true });
    await adapter.warm('sess-1', MSGS);
    expect(prefillSession).not.toHaveBeenCalled();
  });

  it('skips when the engine is not running — focusing a session must not spawn a 284B load', async () => {
    const { adapter, prefillSession } = makeAdapter({ resolveBaseUrl: () => null });
    await adapter.warm('sess-1', MSGS);
    expect(prefillSession).not.toHaveBeenCalled();
  });

  it('tolerates a session that cannot prefill (prefillSession → false)', async () => {
    const { adapter, prefillSession } = makeAdapter({ prefillSession: vi.fn(async () => false) });
    await expect(adapter.warm('sess-1', MSGS)).resolves.toBeUndefined();
    expect(prefillSession).not.toHaveBeenCalled(); // the override was used, not the default
  });

  it('allows only one warm in flight at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prefillSession = vi.fn(async () => {
      await gate;
      return true;
    });
    const { adapter } = makeAdapter({ prefillSession });
    const first = adapter.warm('sess-1', MSGS);
    await adapter.warm('sess-2', MSGS); // in-flight → skipped, resolves immediately
    expect(prefillSession).toHaveBeenCalledTimes(1);
    release();
    await first;
    // After the first completes, a new warm may run again.
    await adapter.warm('sess-3', MSGS);
    expect(prefillSession).toHaveBeenCalledTimes(2);
  });

  it('swallows engine errors — warming is best-effort', async () => {
    const prefillSession = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const { adapter } = makeAdapter({ prefillSession });
    await expect(adapter.warm('sess-1', MSGS)).resolves.toBeUndefined();
    // And the in-flight guard was released by the finally.
    await adapter.warm('sess-1', MSGS);
    expect(prefillSession).toHaveBeenCalledTimes(2);
  });
});
