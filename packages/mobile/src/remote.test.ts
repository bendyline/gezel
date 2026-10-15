import { REMOTE_CERTIFICATE_REFUSED } from '@bendyline/gezel/runtime';
import { describe, expect, it, vi } from 'vitest';
import { type GezelRemotePlugin, createNativeRemoteHost } from './remote.js';

type Listener = (event: Record<string, unknown>) => void;

/** A plugin whose responses the test scripts: chunks may arrive before `request` settles. */
function fakePlugin(
  respond: (
    options: Parameters<GezelRemotePlugin['request']>[0],
    send: (event: 'remoteChunk' | 'remoteEnd', data: Record<string, unknown>) => void,
  ) => Promise<{ status: number; headers: Record<string, string> }>,
) {
  const listeners = new Map<string, Listener>();
  const cancelled: string[] = [];
  const plugin = {
    addListener: vi.fn(async (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return { remove: async () => {} };
    }),
    request: vi.fn((options: Parameters<GezelRemotePlugin['request']>[0]) =>
      respond(options, (event, data) => listeners.get(event)?.({ id: options.id, ...data })),
    ),
    cancel: vi.fn(async ({ id }: { id: string }) => {
      cancelled.push(id);
    }),
    browse: vi.fn(async () => ({
      servers: [{ name: 'Werkbank', host: '192.168.1.20', port: 6229, fingerprint: 'ab' }],
    })),
    deviceName: vi.fn(async () => ({ name: "Ada's iPhone" })),
  } as unknown as GezelRemotePlugin;
  return { plugin, cancelled };
}

const encode = (text: string) => btoa(text);

describe('createNativeRemoteHost', () => {
  it('streams a body whose first chunk arrives before the request settles', async () => {
    const { plugin } = fakePlugin(async (_options, send) => {
      send('remoteChunk', { data: encode('{"ok":') });
      setTimeout(() => {
        send('remoteChunk', { data: encode('true}') });
        send('remoteEnd', {});
      }, 5);
      return { status: 200, headers: { 'content-type': 'application/json' } };
    });
    const host = createNativeRemoteHost(plugin);
    const response = await host.http.pinned('PEM')('https://192.168.1.20:6229/v1/identity');
    expect(await response.json()).toEqual({ ok: true });
    expect(vi.mocked(plugin.request).mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      pinnedCertPem: 'PEM',
      connectTimeoutMs: 5_000,
    });
  });

  it('trusts any certificate only on the bootstrap channel', async () => {
    const { plugin } = fakePlugin(async (_options, send) => {
      send('remoteEnd', {});
      return { status: 200, headers: {} };
    });
    const host = createNativeRemoteHost(plugin);
    await host.http.bootstrap()('https://192.168.1.20:6229/v1/identity');
    expect(vi.mocked(plugin.request).mock.calls[0]?.[0]).not.toHaveProperty('pinnedCertPem');
  });

  it('reports a refused certificate so a restarted server can be re-verified', async () => {
    const { plugin } = fakePlugin(async () => {
      throw Object.assign(new Error('certificate mismatch'), {
        code: 'REMOTE_CERTIFICATE_REFUSED',
      });
    });
    const host = createNativeRemoteHost(plugin);
    await expect(
      host.http.pinned('PEM')('https://192.168.1.20:6229/v1/identity'),
    ).rejects.toMatchObject({ code: REMOTE_CERTIFICATE_REFUSED });
  });

  it('reads an unreachable server as a network failure', async () => {
    const { plugin } = fakePlugin(async () => {
      throw Object.assign(new Error('timed out'), { code: 'REMOTE_UNREACHABLE' });
    });
    const host = createNativeRemoteHost(plugin);
    await expect(host.http.pinned('PEM')('https://192.168.1.20:6229/v1/identity')).rejects.toThrow(
      TypeError,
    );
  });

  it('cancels the native request when the caller stops', async () => {
    const { plugin, cancelled } = fakePlugin(async (_options, send) => {
      send('remoteChunk', { data: encode('data: {}\n\n') });
      return { status: 200, headers: { 'content-type': 'text/event-stream' } };
    });
    const host = createNativeRemoteHost(plugin);
    const stop = new AbortController();
    const response = await host.http.pinned('PEM')('https://192.168.1.20:6229/v1/remote/infer', {
      method: 'POST',
      body: '{}',
      signal: stop.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    stop.abort();
    await expect(reader.read()).rejects.toBeTruthy();
    expect(cancelled).toHaveLength(1);
  });

  it('names this device and finds servers nearby', async () => {
    const { plugin } = fakePlugin(async () => ({ status: 204, headers: {} }));
    const host = createNativeRemoteHost(plugin);
    await vi.waitFor(() => expect(host.deviceName()).toBe("Ada's iPhone"));
    expect(await host.browse?.(1_000)).toEqual([
      { name: 'Werkbank', host: '192.168.1.20', port: 6229, fingerprint: 'ab' },
    ]);
  });
});
