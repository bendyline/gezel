import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owned = vi.hoisted(() => ({
  fetch: vi.fn(),
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}));
vi.mock('@bendyline/gezel-client/node', async (original) => ({
  ...(await original<object>()),
  createPatientFetch: () =>
    Object.assign(owned.fetch, { close: owned.close, destroy: owned.destroy }),
  createTrustingFetch: () =>
    Object.assign(owned.fetch, { close: owned.close, destroy: owned.destroy }),
}));
import { connect } from './connect.js';
import { detectGezel } from './detect.js';
import { authorizeLocal } from './local.js';

let home: string;
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), 'gezel-sdk-transport-'));
  await mkdir(join(home, 'runtime'));
  await writeFile(join(home, 'runtime', 'port'), '6228');
  vi.stubEnv('GEZEL_HOME', home);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const json = (body: unknown) => new Response(JSON.stringify(body));

describe('SDK transport ownership', () => {
  it('closes temporary detection transport after success or failure', async () => {
    owned.fetch.mockResolvedValueOnce(json({ version: 'test' }));
    expect((await detectGezel()).running).toBe(true);
    owned.fetch.mockRejectedValueOnce(new Error('offline'));
    expect((await detectGezel()).running).toBe(false);
    expect(owned.close).toHaveBeenCalledTimes(1);
    expect(owned.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(['http', 'https'])(
    'destroys the SDK-owned %s transport when discovery times out',
    async (scheme) => {
      if (scheme === 'https')
        await writeFile(join(home, 'runtime', 'cert.pem'), 'test certificate');
      vi.useFakeTimers();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      owned.fetch.mockImplementationOnce((_url: unknown, init: RequestInit) => {
        started();
        return new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
        );
      });
      const result = detectGezel({ timeoutMs: 100 });
      await ready;
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ installed: true, running: false });
      expect(owned.destroy).toHaveBeenCalledTimes(1);
      expect(owned.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('bounds the native discovery probe and destroys its owned transport on timeout', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    owned.fetch.mockImplementationOnce((_url: unknown, init: RequestInit) => {
      started();
      return new Promise((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
      );
    });
    const result = authorizeLocal({
      appId: 'test',
      appName: 'Test',
      scopes: ['openai'],
      daemon: { home },
    });
    const failed = expect(result).rejects.toMatchObject({ code: 'daemon_not_running' });
    await ready;
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(owned.fetch).toHaveBeenCalledTimes(1);
    expect(owned.destroy).toHaveBeenCalledTimes(1);
    expect(owned.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('transfers a discovered connection to the app and closes it once', async () => {
    owned.fetch.mockResolvedValueOnce(json({ status: 'approved', token: 'scoped' }));
    const app = await connect({ appId: 'test', appName: 'Test', scopes: ['openai'] });
    expect(owned.close).not.toHaveBeenCalled();
    await Promise.all([app.close(), app.close()]);
    expect(owned.close).toHaveBeenCalledTimes(1);
  });
  it('closes after authorization failure', async () => {
    owned.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(connect({ appId: 'test', appName: 'Test', scopes: ['openai'] })).rejects.toThrow(
      'offline',
    );
    expect(owned.close).toHaveBeenCalledTimes(1);
  });
  it('transfers native discovery ownership and cleans up failed probes', async () => {
    owned.fetch
      .mockResolvedValueOnce(json({ version: 'test' }))
      .mockResolvedValueOnce(json({ status: 'approved', token: 'scoped' }));
    const authorization = await authorizeLocal({
      appId: 'test',
      appName: 'Test',
      scopes: ['openai'],
      daemon: { home },
    });
    expect(owned.close).not.toHaveBeenCalled();
    await authorization.close?.();
    expect(owned.close).toHaveBeenCalledTimes(1);
    owned.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(
      authorizeLocal({ appId: 'test', appName: 'Test', scopes: ['openai'], daemon: { home } }),
    ).rejects.toMatchObject({ code: 'daemon_not_running' });
    expect(owned.close).toHaveBeenCalledTimes(1);
    expect(owned.destroy).toHaveBeenCalledTimes(1);
  });
  it('never takes ownership of an injected transport, including runtime discovery', async () => {
    const close = vi.fn(async () => {});
    const borrowed = Object.assign(
      vi.fn(async () => json({ status: 'approved', token: 'scoped' })),
      { close },
    );
    const app = await connect({
      appId: 'test',
      appName: 'Test',
      scopes: ['openai'],
      fetch: borrowed,
    });
    await app.close();
    expect(close).not.toHaveBeenCalled();
    expect(owned.fetch).not.toHaveBeenCalled();
    expect(owned.close).not.toHaveBeenCalled();
  });
});
