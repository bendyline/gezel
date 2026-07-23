import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import { DiffusersVideoProvider } from './diffusers-video.js';
import { VideoModelManager, VideoModelSelector } from './models.js';

/**
 * The single-model video engine binds one model at launch. These tests
 * pin the two behaviors that make a per-call `model` argument real:
 * `VideoModelSelector` resolves the right weights (override → default →
 * first-installed), and `DiffusersVideoProvider` relaunches the engine
 * only when the requested model differs from the bound one.
 */

const LTX = 'ltx-2.3-22b-fp8';
const WAN = 'wan2.2-ti2v-5b';

async function writeModel(home: string, id: string, name: string, family = 'ltx'): Promise<void> {
  const dir = join(home, 'engines', 'video', 'models', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      name,
      approxSizeBytes: 1_000,
      installedAt: '2026-07-20T00:00:00.000Z',
      catalogId: id,
      catalogVersion: '1.0.0',
      family,
      huggingfaceRepo: 'org/repo',
      files: ['model_index.json'],
    }),
  );
}

function jsonFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ video: Buffer.from('clip').toString('base64') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/**
 * Minimal supervisor stand-in. `ensureRunning` mimics the factory's real
 * `resolveLaunch` by binding the selector to whichever model it currently
 * picks, so `launchedId` tracks the running weights the way production does.
 */
function fakeSupervisor(selector: VideoModelSelector): {
  supervisor: NativeEngineSupervisor;
  calls: { stop: number; ensureRunning: number };
} {
  const calls = { stop: 0, ensureRunning: 0 };
  const supervisor = {
    async ensureRunning() {
      calls.ensureRunning += 1;
      selector.launchedId = (await selector.pick())?.id;
      return { command: 'python', args: [], baseUrl: 'http://127.0.0.1:9999' };
    },
    async stop() {
      calls.stop += 1;
    },
    subscribeLogLines() {
      return () => {};
    },
    markUsed() {},
  } as unknown as NativeEngineSupervisor;
  return { supervisor, calls };
}

describe('VideoModelSelector.pick', () => {
  let home: string;
  let models: VideoModelManager;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-video-sel-'));
    await writeModel(home, LTX, 'LTX-2.3 (22B, fp8, video + audio)', 'ltx2');
    await writeModel(home, WAN, 'Wan 2.2 TI2V-5B', 'wan');
    models = new VideoModelManager({ home, catalog: {} as unknown as CatalogService });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prefers the per-request override', async () => {
    const sel = new VideoModelSelector(models, () => LTX);
    sel.requestedId = WAN;
    expect((await sel.pick())?.id).toBe(WAN);
  });

  it('falls back to the configured default when no override is set', async () => {
    const sel = new VideoModelSelector(models, () => WAN);
    expect((await sel.pick())?.id).toBe(WAN);
  });

  it('falls back to the first installed (by name) when nothing is configured', async () => {
    const sel = new VideoModelSelector(models, () => undefined);
    // "LTX-2.3…" sorts before "Wan 2.2…" — this is the alphabetical default.
    expect((await sel.pick())?.id).toBe(LTX);
  });

  it('ignores a configured default that is not installed', async () => {
    const sel = new VideoModelSelector(models, () => 'ghost-model');
    expect((await sel.pick())?.id).toBe(LTX);
  });
});

describe('DiffusersVideoProvider per-call model', () => {
  let home: string;
  let models: VideoModelManager;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-video-gen-'));
    await writeModel(home, LTX, 'LTX-2.3 (22B, fp8, video + audio)', 'ltx2');
    await writeModel(home, WAN, 'Wan 2.2 TI2V-5B', 'wan');
    models = new VideoModelManager({ home, catalog: {} as unknown as CatalogService });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function build(selector: VideoModelSelector) {
    const { supervisor, calls } = fakeSupervisor(selector);
    const provider = new DiffusersVideoProvider({
      baseUrl: 'http://127.0.0.1:9091',
      models,
      accelerator: 'cpu',
      supervisor,
      selector,
      fetchImpl: jsonFetch(),
    });
    return { provider, calls };
  }

  it('relaunches the engine when the requested model differs from the bound one', async () => {
    const selector = new VideoModelSelector(models, () => LTX);
    selector.launchedId = LTX; // engine already running LTX
    const { provider, calls } = build(selector);

    const out = await provider.generate({ prompt: 'a wave', model: WAN });

    expect(calls.stop).toBe(1);
    expect(calls.ensureRunning).toBe(1);
    expect(out.meta.model).toBe(WAN);
  });

  it('does not relaunch when the requested model is already bound', async () => {
    const selector = new VideoModelSelector(models, () => LTX);
    selector.launchedId = WAN;
    const { provider, calls } = build(selector);

    const out = await provider.generate({ prompt: 'a wave', model: WAN });

    expect(calls.stop).toBe(0);
    expect(calls.ensureRunning).toBe(1);
    expect(out.meta.model).toBe(WAN);
  });

  it('uses the configured default and reports it when no model is requested', async () => {
    const selector = new VideoModelSelector(models, () => WAN);
    const { provider, calls } = build(selector);

    const out = await provider.generate({ prompt: 'a wave' });

    expect(calls.stop).toBe(0);
    expect(out.meta.model).toBe(WAN);
  });

  it('rejects a requested model that is not installed', async () => {
    const selector = new VideoModelSelector(models, () => LTX);
    selector.launchedId = LTX;
    const { provider, calls } = build(selector);

    await expect(provider.generate({ prompt: 'a wave', model: 'ghost-model' })).rejects.toThrow(
      /not available locally/i,
    );
    // No relaunch attempted for an invalid request.
    expect(calls.stop).toBe(0);
    expect(calls.ensureRunning).toBe(0);
  });
});
