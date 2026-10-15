import { GezelClient } from '@bendyline/gezel-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SharedRead,
  installSharedApiReads,
  invalidateApiReads,
  withReadInvalidation,
} from './shared-api-reads.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  invalidateApiReads();
});

describe('shared renderer reads', () => {
  it('refreshes roster metadata on actual product change events', async () => {
    let name = 'Before';
    const network = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            gezels: [{ id: 'fixture', name }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', network);
    const { api } = await import('./api.js');
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

  it('invalidates real client reads after writes, while perf reports preserve them', async () => {
    let config = { provider: 'openai' };
    const network = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PUT' && url.endsWith('/api/config')) config = { provider: 'anthropic' };
      return new Response(JSON.stringify(config), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new GezelClient({
      baseUrl: 'http://localhost',
      token: 'fixture-token',
      fetch: withReadInvalidation(network),
    });
    installSharedApiReads(client);
    await Promise.all([client.getConfig(), client.getConfig()]);
    expect(network).toHaveBeenCalledTimes(1);
    await client.updateConfig({ provider: 'anthropic' });
    expect((await client.getConfig()).provider).toBe('anthropic');
    expect(network).toHaveBeenCalledTimes(3);
    const transport = withReadInvalidation(network);
    await transport('http://localhost/api/system/perf/client', { method: 'POST' });
    await client.getConfig();
    expect(network).toHaveBeenCalledTimes(4);
  });

  it('coalesces 100 message mounts and isolates callers that mutate their response', async () => {
    const load = vi.fn(async (_project: string) => ({ attachments: ['one.png'] }));
    const read = new SharedRead(load, 5_000);
    const results = await Promise.all(Array.from({ length: 100 }, () => read.read('project')));
    expect(load).toHaveBeenCalledTimes(1);
    results[0]!.attachments.push('changed');
    expect(results[1]!.attachments).toEqual(['one.png']);
    expect((await read.read('project')).attachments).toEqual(['one.png']);
    await read.read('another-project');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('expires snapshots so changes made outside this renderer become visible', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => 'old');
    const read = new SharedRead(load, 5_000);
    await read.read();
    expect(read.peek()).toBe('old');
    load.mockResolvedValue('external edit');
    vi.advanceTimersByTime(5_000);
    expect(read.peek()).toBeUndefined();
    expect(read.snapshot()).toBe('old');
    expect(await read.read()).toBe('external edit');
  });

  it('does not let a read started before a mutation overwrite its replacement', async () => {
    const old = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('new');
    const read = new SharedRead(load, 5_000);
    const pending = read.read();
    read.invalidate();
    expect(await read.read()).toBe('new');
    old.resolve('old');
    await pending;
    expect(read.peek()).toBe('new');
  });

  it('retries failures and bounds retained scopes', async () => {
    const load = vi.fn(async (_id: string) => 'ok').mockRejectedValueOnce(new Error('offline'));
    const read = new SharedRead(load, 5_000, 2);
    await expect(read.read('one')).rejects.toThrow('offline');
    await expect(read.read('one')).resolves.toBe('ok');
    await read.read('two');
    await read.read('three');
    expect(read.peek('one')).toBeUndefined();
  });
});
