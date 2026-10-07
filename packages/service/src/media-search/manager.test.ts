import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelConfig } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageEmbedAvailability, setMediaSearchGate } from '../memory/image-embeddings.js';
import { HF_CACHE_DIR_ENV } from '../transformers-cache.js';
import { MediaSearchManager, backgroundDownloadsAllowed } from './manager.js';

let home: string;
let savedCacheDir: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-media-search-'));
  // The suite's shared model cache must never receive a test download.
  savedCacheDir = process.env[HF_CACHE_DIR_ENV];
  process.env[HF_CACHE_DIR_ENV] = join(home, 'hf-cache');
});
afterEach(async () => {
  if (savedCacheDir === undefined) delete process.env[HF_CACHE_DIR_ENV];
  else process.env[HF_CACHE_DIR_ENV] = savedCacheDir;
  setMediaSearchGate(null);
  await rm(home, { recursive: true, force: true });
});

function manager(opts: { config?: GezelConfig; backgroundDownloads: boolean }) {
  const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
  const m = new MediaSearchManager({
    home,
    readConfig: async () => opts.config ?? ({} as GezelConfig),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    backgroundDownloads: opts.backgroundDownloads,
  });
  return { m, fetchImpl };
}

async function settled(m: MediaSearchManager) {
  for (let i = 0; i < 100; i++) {
    const status = await m.status();
    if (status.status !== 'downloading') return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('download never settled');
}

describe('media search downloads', () => {
  it('lets boot download only where first-boot background downloads run', () => {
    expect(backgroundDownloadsAllowed({})).toBe(true);
    expect(backgroundDownloadsAllowed({ GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1' })).toBe(false);
    expect(backgroundDownloadsAllowed({ GEZEL_MOCK_PROVIDER: '1' })).toBe(false);
    expect(backgroundDownloadsAllowed({ VITEST: 'true' })).toBe(false);
  });

  it('boots without fetching when background downloads are off, and keeps the lane closed', async () => {
    const { m, fetchImpl } = manager({ backgroundDownloads: false });
    await m.bootWarm();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await m.status()).status).toBe('not-installed');
    expect(imageEmbedAvailability()).toMatchObject({ ok: false });
    expect(await m.ensureAudio()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still installs when the person turns media search on', async () => {
    const { m, fetchImpl } = manager({ backgroundDownloads: false });
    await m.reconcile();
    const status = await settled(m);
    expect(fetchImpl).toHaveBeenCalled();
    expect(status.status).toBe('error');
    expect(status.error).toMatch(/config\.json|tokenizer|onnx/);
  });

  it('downloads at boot where allowed, but never with app network off', async () => {
    const allowed = manager({ backgroundDownloads: true });
    await allowed.m.bootWarm();
    await settled(allowed.m);
    expect(allowed.fetchImpl).toHaveBeenCalled();

    const sealed = manager({
      backgroundDownloads: true,
      config: { securityPolicy: { level: 'super-lockdown' } } as GezelConfig,
    });
    await sealed.m.bootWarm();
    expect(sealed.fetchImpl).not.toHaveBeenCalled();
    expect((await sealed.m.status()).status).toBe('blocked-network');
  });

  it('closes the lane while media search is off in Settings', async () => {
    const { m } = manager({
      backgroundDownloads: false,
      config: { mediaSearch: { enabled: false } } as GezelConfig,
    });
    await m.applyGate();
    expect(imageEmbedAvailability()).toEqual({
      ok: false,
      reason: 'media search is off in Settings',
    });
    expect((await m.status()).status).toBe('off');
  });
});
