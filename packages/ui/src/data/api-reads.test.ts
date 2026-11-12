import { GezelClient } from '@bendyline/gezel-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApiReads, markReadsStale, peekRead, resetReads } from './api-reads.js';
import { dataChanged, withReadInvalidation } from './invalidation.js';
import { queryClient } from './query-client.js';
import { useApiRead } from './use-api-read.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

function clientWith(network: typeof fetch): GezelClient {
  const client = new GezelClient({
    baseUrl: 'http://localhost',
    token: 'fixture-token',
    fetch: withReadInvalidation(network),
  });
  installApiReads(client);
  return client;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetReads();
});

describe('renderer reads', () => {
  it('refreshes roster metadata on actual product change events', async () => {
    let name = 'Before';
    const network = vi.fn<typeof fetch>(async () => json({ gezels: [{ id: 'fixture', name }] }));
    vi.stubGlobal('fetch', network);
    const { api } = await import('../api.js');
    expect((await api.listGezels()).gezels[0]!.name).toBe('Before');
    for (const event of [
      'gezel:config-updated',
      'gezel:gezel-updated',
      'gezel:gezel-deleted',
      'gezel:project-created',
      'gezel:project-updated',
      'gezel:project-deleted',
    ]) {
      name = event;
      window.dispatchEvent(new CustomEvent(event));
      expect((await api.listGezels()).gezels[0]!.name).toBe(event);
    }
    expect(network).toHaveBeenCalledTimes(7);
  });

  it('marks reads stale after writes, while perf reports preserve them', async () => {
    let config = { provider: 'openai' };
    const network = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'PUT' && String(input).endsWith('/api/config')) {
        config = { provider: 'anthropic' };
      }
      return json(config);
    });
    const client = clientWith(network);
    await Promise.all([client.getConfig(), client.getConfig()]);
    expect(network).toHaveBeenCalledTimes(1);
    await client.updateConfig({ provider: 'anthropic' });
    expect((await client.getConfig()).provider).toBe('anthropic');
    expect(network).toHaveBeenCalledTimes(3);
    await withReadInvalidation(network)('http://localhost/api/system/perf/client', {
      method: 'POST',
    });
    await client.getConfig();
    expect(network).toHaveBeenCalledTimes(4);
  });

  it('coalesces 100 mounts and gives older callers their own copy', async () => {
    const network = vi.fn<typeof fetch>(async () => json({ attachments: ['one.png'] }));
    const client = clientWith(network);
    const results = await Promise.all(
      Array.from({ length: 100 }, () => client.listProjectAttachments('project')),
    );
    expect(network).toHaveBeenCalledTimes(1);
    (results[0]!.attachments as unknown[]).push('changed');
    expect(results[1]!.attachments).toEqual(['one.png']);
    expect((await client.listProjectAttachments('project')).attachments).toEqual(['one.png']);
    await client.listProjectAttachments('another-project');
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('paints a stale answer for a while, then lets go of it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const network = vi.fn<typeof fetch>(async () => json({ provider: 'old' }));
    const client = clientWith(network);
    await client.getConfig();
    vi.setSystemTime(Date.now() + 10_000);
    expect(peekRead('getConfig')?.provider).toBe('old');
    vi.setSystemTime(Date.now() + 60_000);
    expect(peekRead('getConfig')).toBeUndefined();
  });

  it('does not let a read started before a write stand as the answer after it', async () => {
    const old = deferred<Response>();
    const network = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old.promise)
      .mockImplementation(async () => json({ provider: 'new' }));
    const client = clientWith(network);
    const pending = client.getConfig();
    markReadsStale('all', { refetch: false });
    expect((await client.getConfig()).provider).toBe('new');
    old.resolve(json({ provider: 'old' }));
    // The caller of the cancelled read is answered by the read that replaced it.
    expect((await pending).provider).toBe('new');
    expect(peekRead('getConfig')?.provider).toBe('new');
  });

  it('keeps painting the last answer after a write while it is read again', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => json({ provider: 'before write' }))
      .mockImplementation(async () => json({ provider: 'after write' }));
    const client = clientWith(network);
    await client.getConfig();
    dataChanged('config');
    expect(peekRead('getConfig')?.provider).toBe('before write');
    expect((await client.getConfig()).provider).toBe('after write');
    resetReads();
    expect(peekRead('getConfig')).toBeUndefined();
  });

  it('leaves reads alone for writes that change none of them', async () => {
    const network = vi.fn<typeof fetch>(async () => json({ provider: 'openai' }));
    const client = clientWith(network);
    await client.getConfig();
    await client.warmSessionCache('s1');
    await client.writePromptDraftContent('p1', '2026-11-11-0001', 'typing…');
    await client.getConfig();
    // One config read, one warm, one draft save: the second read was served from memory.
    expect(network).toHaveBeenCalledTimes(3);
  });

  it('reads again after a failure', async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('nope', { status: 500 }))
      .mockImplementation(async () => json({ provider: 'ok' }));
    const client = clientWith(network);
    await expect(client.getConfig()).rejects.toThrow();
    expect((await client.getConfig()).provider).toBe('ok');
  });

  it('scopes a change to the reads it names', async () => {
    const network = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/api/config') ? json({ provider: 'x' }) : json({ gezels: [] }),
    );
    const client = clientWith(network);
    await client.getConfig();
    await client.listGezels();
    dataChanged('roster');
    await client.getConfig();
    await client.listGezels();
    expect(network).toHaveBeenCalledTimes(3);
  });
});

describe('useApiRead', () => {
  it('paints a kept answer in the first render and keeps its identity across refreshes', async () => {
    const network = vi.fn<typeof fetch>(async () => json({ provider: 'kept', nested: { a: 1 } }));
    vi.stubGlobal('fetch', network);
    const { api } = await import('../api.js');
    await api.getConfig();
    const { result } = renderHook(() => useApiRead('getConfig', []));
    expect((result.current.data as { provider?: string } | undefined)?.provider).toBe('kept');
    const first = result.current.data;
    await act(async () => {
      dataChanged('config');
      await queryClient.getQueryCache().find({ queryKey: ['api', 'getConfig'] })?.promise;
    });
    await waitFor(() => expect(network).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBe(first);
  });

  it('applies a saved config from the change event without reading again', async () => {
    const network = vi.fn<typeof fetch>(async () => json({ debugMode: false }));
    vi.stubGlobal('fetch', network);
    await import('../api.js');
    const { result } = renderHook(() =>
      useApiRead('getConfig', [], { select: (config) => config.debugMode }),
    );
    await waitFor(() => expect(result.current.data).toBe(false));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('gezel:config-updated', { detail: { debugMode: true } }),
      );
    });
    expect(result.current.data).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('waits while its arguments are unknown', async () => {
    const network = vi.fn<typeof fetch>(async () => json({ id: 'p1' }));
    vi.stubGlobal('fetch', network);
    await import('../api.js');
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useApiRead('getProject', id ? [id] : null),
      { initialProps: { id: null as string | null } },
    );
    expect(result.current.data).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
    rerender({ id: 'p1' });
    await waitFor(() => expect(result.current.data).toEqual({ id: 'p1' }));
  });
});
