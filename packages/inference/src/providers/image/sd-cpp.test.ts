import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageModelAuxiliaryFileSchema } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StableDiffusionCppProvider, parseSamplingProgress } from './sd-cpp.js';
import type { ImageGenerationProgress } from './types.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Exercise the provider against an injected fetch rather than a real sd-server. */

let modelsRoot: string;

beforeEach(async () => {
  modelsRoot = await mkdtemp(join(tmpdir(), 'sd-cpp-test-'));
});

afterEach(async () => {
  await rm(modelsRoot, { recursive: true, force: true });
});

describe('StableDiffusionCppProvider.generate', () => {
  it('sends an A1111 txt2img payload and decodes images[0]', async () => {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const out = await provider.generate({
      prompt: 'a compass',
      width: 256,
      height: 128,
      steps: 14,
      seed: 7,
      negativePrompt: 'ugly',
      model: 'test-model',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://fake:9081/sdapi/v1/txt2img');
    expect(calls[0]!.body).toMatchObject({
      prompt: 'a compass',
      width: 256,
      height: 128,
      steps: 14,
      seed: 7,
      negative_prompt: 'ugly',
    });
    // `test-model` isn't a known distilled/flux model → no cfg override.
    expect(calls[0]!.body.cfg_scale).toBeUndefined();
    expect(calls[0]!.body.sampler_name).toBeUndefined();
    expect(out.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(out.meta.seed).toBe(7);
    expect(out.meta.steps).toBe(14);
    expect(out.meta.widthPx).toBe(256);
    expect(out.meta.heightPx).toBe(128);
  });

  it.each([
    { model: 'ming-image-0.1-design-bf16', steps: 12, cfg: 1 },
    { model: 'moss-image-sft-q4', steps: 50, cfg: 3 },
    { model: 'iris-3b-f32', steps: 50, cfg: 3 },
  ])('uses $model sampling defaults and preserves PNG bytes', async ({ model, steps, cfg }) => {
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.from('rgba-payload')]);
    const requests: Record<string, unknown>[] = [];
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ images: [png.toString('base64')] });
      },
    });
    const input = { prompt: 'An illustrated cat sticker', model };
    const out = await provider.generate(input);
    expect(requests[0]).toMatchObject({
      steps,
      cfg_scale: cfg,
      sampler_name: 'Euler',
      width: 1024,
      height: 1024,
    });
    expect(out.png).toEqual(png);
    await provider.generate({ ...input, steps: 6, width: 768, height: 1024 });
    expect(requests[1]).toMatchObject({
      steps: 6,
      cfg_scale: cfg,
      sampler_name: 'Euler',
      width: 768,
      height: 1024,
    });
  });

  it.each([
    { model: 'sdxl-base-1.0', side: 1024 },
    { model: 'sdxl-lightning-4step', side: 1024 },
    { model: 'flux-2-klein-4b-q4', side: 1024 },
    { model: 'krea-2-turbo-q4', side: 1024 },
    { model: 'animagine-xl-4', side: 1024 },
    { model: 'sdxl-turbo', side: 512 },
    { model: 'sd-turbo', side: 512 },
    { model: 'sd-1.5', side: 512 },
  ])(
    'renders $model at its training size, $side px, when no size is asked',
    async ({ model, side }) => {
      const requests: Record<string, unknown>[] = [];
      const provider = new StableDiffusionCppProvider({
        baseUrl: 'http://fake:9081',
        modelsRoot,
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return Response.json({ images: [PNG_SIGNATURE.toString('base64')] });
        },
      });
      await provider.generate({ prompt: 'a lighthouse', model });
      expect(requests[0]).toMatchObject({ width: side, height: side });
    },
  );

  it('renders Animagine at its model-card guidance, CFG 5', async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ images: [PNG_SIGNATURE.toString('base64')] });
      },
    });
    await provider.generate({ prompt: '1girl, silver hair', model: 'animagine-xl-4' });
    expect(requests[0]).toMatchObject({ cfg_scale: 5, width: 1024, height: 1024 });
  });

  it('routes input images to img2img for a model that supports it', async () => {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const out = await provider.generate({
      prompt: 'same craftsman, no lettering',
      model: 'sd-1.5',
      seed: 7,
      inputImages: [{ data: Buffer.from('fake-png'), mimeType: 'image/png' }],
      strength: 0.6,
    });

    expect(calls[0]!.url).toBe('http://fake:9081/sdapi/v1/img2img');
    expect(calls[0]!.body.init_images).toEqual([Buffer.from('fake-png').toString('base64')]);
    expect(calls[0]!.body.denoising_strength).toBe(0.6);
    expect(out.meta.img2imgSkippedReason).toBeUndefined();
  });

  it('drops input images for a model assessed as txt2img-only and reports the skip', async () => {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const out = await provider.generate({
      prompt: 'same craftsman, no lettering',
      model: 'flux-2-klein-4b-q4',
      inputImages: [{ data: Buffer.from('fake-png'), mimeType: 'image/png' }],
      strength: 0.6,
    });

    expect(calls[0]!.url).toBe('http://fake:9081/sdapi/v1/txt2img');
    expect(calls[0]!.body.init_images).toBeUndefined();
    expect(out.meta.img2imgSkippedReason).toMatch(/flux-2-klein-4b-q4/);
  });

  it('lets an explicit installed-manifest capability override the assessment map', async () => {
    await mkdir(join(modelsRoot, 'flux-2-klein-4b-q4'), { recursive: true });
    await writeFile(
      join(modelsRoot, 'flux-2-klein-4b-q4', 'manifest.json'),
      JSON.stringify({
        id: 'flux-2-klein-4b-q4',
        name: 'FLUX.2 Klein',
        approxSizeBytes: 1,
        installedAt: new Date().toISOString(),
        weightsKind: 'diffusion-model',
        supportsImg2Img: true,
      }),
      'utf8',
    );
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const calls: Array<{ url: string }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url) });
      void init;
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const out = await provider.generate({
      prompt: 'edit it',
      model: 'flux-2-klein-4b-q4',
      inputImages: [{ data: Buffer.from('fake-png'), mimeType: 'image/png' }],
    });

    expect(calls[0]!.url).toBe('http://fake:9081/sdapi/v1/img2img');
    expect(out.meta.img2imgSkippedReason).toBeUndefined();
  });

  it('surfaces unreachable-server errors with a helpful message', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://nothing-here:9081',
      modelsRoot,
      fetchImpl: fakeFetch,
    });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/sd-server unreachable/);
  });

  it('surfaces non-2xx responses with the status line', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('model not loaded', { status: 500, statusText: 'Internal Server Error' });
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: fakeFetch,
    });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/500.*model not loaded/);
  });

  it('uses distilled model defaults when callers omit steps', async () => {
    await mkdir(join(modelsRoot, 'sdxl-lightning-4step'), { recursive: true });
    await writeFile(
      join(modelsRoot, 'sdxl-lightning-4step', 'manifest.json'),
      JSON.stringify({
        id: 'sdxl-lightning-4step',
        name: 'SDXL Lightning',
        approxSizeBytes: 1,
        installedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const calls: Array<{ body: unknown }> = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const out = await provider.generate({ prompt: 'a pet shop logo', seed: 42 });

    // sdxl-lightning-4step → 4 distilled steps + CFG 1 (known distilled model).
    expect(calls[0]!.body).toMatchObject({ steps: 4, cfg_scale: 1 });
    expect(out.meta.model).toBe('sdxl-lightning-4step');
    expect(out.meta.steps).toBe(4);
  });

  it('forwards sd-server load, sampling and decode progress as distinct phases', async () => {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    let logListener: ((line: string) => void) | undefined;
    const fakeSupervisor = {
      withRequest: <T>(run: () => Promise<T>) => run(),
      currentBaseUrl: () => undefined,
      ensureRunning: async () => ({
        command: 'sd-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9090',
      }),
      markUsed: () => {},
      stop: async () => {},
      subscribeLogLines: (fn: (line: string) => void) => {
        logListener = fn;
        return () => {
          logListener = undefined;
        };
      },
    };
    const fakeFetch: typeof fetch = async () => {
      // Simulate two sd-server progress lines arriving while the
      // diffusion loop is running, then resolve with the final image.
      // Weights load lazily inside the first request after a launch.
      logListener?.('[sd-server]   |#########          | 49/298 - 435.57MB/s');
      logListener?.('[sd-server]   |==>                | 1/20 - 18.20s/it');
      logListener?.('[sd-server]   |======>            | 7/20 - 18.04s/it');
      logListener?.('[sd-server]   |==================>| 20/20 - 18.01s/it');
      // The VAE's weights load just before decoding; that is not a step back.
      logListener?.('[sd-server]   |##################| 251/251 - 812.81MB/s');
      // The tiled VAE decode prints a bar of its own after sampling.
      logListener?.('[sd-server]   |=>                 | 1/49 - 4.16s/it');
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: fakeFetch,
      supervisor: fakeSupervisor as never,
    });
    const events: ImageGenerationProgress[] = [];
    await provider.generate({
      prompt: 'a compass',
      onProgress: (p) => events.push(p),
    });
    expect(events).toEqual([
      { phase: 'loading_model', step: 0, totalSteps: 0 },
      { phase: 'loading_model', step: 49, totalSteps: 298 },
      { phase: 'sampling', step: 1, totalSteps: 20, secondsPerStep: 18.2 },
      { phase: 'sampling', step: 7, totalSteps: 20, secondsPerStep: 18.04 },
      { phase: 'sampling', step: 20, totalSteps: 20, secondsPerStep: 18.01 },
      { phase: 'decoding', step: 1, totalSteps: 49, secondsPerStep: 4.16 },
    ]);
    // Listener must be released once generate resolves so a future
    // generate's listener doesn't pile up alongside this one.
    expect(logListener).toBeUndefined();
  });

  it('holds the GPU lease until supervised generation finishes', async () => {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const release = vi.fn();
    const fakeArbiter = {
      registerEvictor: vi.fn(),
      acquireLease: vi.fn(async () => release),
    };
    const fakeSupervisor = {
      withRequest: <T>(run: () => Promise<T>) => run(),
      currentBaseUrl: () => undefined,
      ensureRunning: async () => ({
        command: 'sd-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9090',
      }),
      markUsed: vi.fn(),
      stop: async () => {},
      subscribeLogLines: () => () => {},
    };
    const fakeFetch: typeof fetch = async () => {
      expect(release).not.toHaveBeenCalled();
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: fakeFetch,
      supervisor: fakeSupervisor as never,
      arbiter: fakeArbiter as never,
    });

    await provider.generate({ prompt: 'a compass' });

    expect(fakeArbiter.registerEvictor).toHaveBeenCalledWith('image', expect.any(Function));
    expect(fakeArbiter.acquireLease).toHaveBeenCalledWith('image');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('switches launch model + restarts the server when a request targets a different model', async () => {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const launchState = { modelId: 'flux-2-klein-4b-q4' as string | undefined };
    const stop = vi.fn(async () => {});
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const fakeSupervisor = {
      withRequest: <T>(run: () => Promise<T>) => run(),
      currentBaseUrl: () => undefined,
      ensureRunning: async () => ({
        command: 'sd-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9090',
      }),
      markUsed: () => {},
      stop,
      subscribeLogLines: () => () => {},
    };
    const fakeFetch: typeof fetch = async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: fakeFetch,
      supervisor: fakeSupervisor as never,
      launchState,
    });

    await provider.generate({ prompt: 'a fox', model: 'krea-2-turbo-q4' });

    // The shared holder now points at the requested model, and the
    // running server was stopped so the next ensureRunning relaunches it.
    expect(launchState.modelId).toBe('krea-2-turbo-q4');
    expect(stop).toHaveBeenCalledTimes(1);
    // krea-2-turbo-q4 is a known distilled/flux model → CFG forced to 1.
    expect(calls[0]!.body.cfg_scale).toBe(1);
  });

  it('does not restart the server when the request model matches the loaded model', async () => {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    const launchState = { modelId: 'krea-2-turbo-q4' as string | undefined };
    const stop = vi.fn(async () => {});
    const fakeSupervisor = {
      withRequest: <T>(run: () => Promise<T>) => run(),
      currentBaseUrl: () => undefined,
      ensureRunning: async () => ({
        command: 'sd-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9090',
      }),
      markUsed: () => {},
      stop,
      subscribeLogLines: () => () => {},
    };
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: fakeFetch,
      supervisor: fakeSupervisor as never,
      launchState,
    });

    await provider.generate({ prompt: 'a fox', model: 'krea-2-turbo-q4' });

    expect(stop).not.toHaveBeenCalled();
    expect(launchState.modelId).toBe('krea-2-turbo-q4');
  });
});

describe('StableDiffusionCppProvider default model', () => {
  async function installModel(id: string, name: string) {
    await mkdir(join(modelsRoot, id), { recursive: true });
    await writeFile(
      join(modelsRoot, id, 'manifest.json'),
      JSON.stringify({
        id,
        name,
        approxSizeBytes: 1,
        installedAt: new Date().toISOString(),
      }),
      'utf8',
    );
  }

  function okFetch(): typeof fetch {
    const pngB64 = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');
    return async () =>
      new Response(JSON.stringify({ images: [pngB64] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  it('falls back to the first installed model when nothing is configured', async () => {
    await installModel('bbb-model', 'Bbb');
    await installModel('zzz-model', 'Zzz');
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: okFetch(),
    });

    const out = await provider.generate({ prompt: 'x' });
    expect(out.meta.model).toBe('bbb-model');
  });

  it('uses the configured default for a request that names no model', async () => {
    await installModel('bbb-model', 'Bbb');
    await installModel('zzz-model', 'Zzz');
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: okFetch(),
      defaultModelId: 'zzz-model',
    });

    const out = await provider.generate({ prompt: 'x' });
    expect(out.meta.model).toBe('zzz-model');
  });

  it('still lets a per-request model win over the configured default', async () => {
    await installModel('bbb-model', 'Bbb');
    await installModel('zzz-model', 'Zzz');
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: okFetch(),
      defaultModelId: 'zzz-model',
    });

    const out = await provider.generate({ prompt: 'x', model: 'bbb-model' });
    expect(out.meta.model).toBe('bbb-model');
  });

  it('falls back when the configured default is no longer installed', async () => {
    await installModel('bbb-model', 'Bbb');
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake:9081',
      modelsRoot,
      fetchImpl: okFetch(),
      defaultModelId: 'deleted-model',
    });

    const out = await provider.generate({ prompt: 'x' });
    expect(out.meta.model).toBe('bbb-model');
  });
});

describe('StableDiffusionCppProvider.pullModel', () => {
  it('downloads, verifies sha256, persists the manifest', async () => {
    const weights = Buffer.from('fake-weights-data');
    const sha = createHash('sha256').update(weights).digest('hex');
    const fakeFetch: typeof fetch = async () =>
      new Response(weights, {
        status: 200,
        headers: { 'Content-Length': String(weights.length) },
      });
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const events: Array<{ type: string }> = [];
    for await (const e of provider.pullModel('tiny', {
      downloadUrl: 'https://example.invalid/path/weights.gguf',
      sha256: sha,
      approxSizeBytes: weights.length,
      name: 'Tiny Model',
      weightsKind: 'checkpoint',
      auxiliaryFiles: [],
    })) {
      events.push(e);
    }
    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(events.every((e) => e.type !== 'error')).toBe(true);

    const installed = await provider.listInstalledModels();
    expect(installed).toHaveLength(1);
    expect(installed[0]!.id).toBe('tiny');
    expect(installed[0]!.name).toBe('Tiny Model');

    // Weights landed at the expected path with the correct bytes.
    const saved = await readFile(join(modelsRoot, 'tiny', 'weights.gguf'));
    expect(saved.equals(weights)).toBe(true);

    const manifest = JSON.parse(await readFile(join(modelsRoot, 'tiny', 'manifest.json'), 'utf8'));
    expect(manifest.weightsKind).toBe('checkpoint');
    expect(manifest.auxiliaryFiles).toEqual([]);
  });

  it('rejects when sha256 does not match', async () => {
    const weights = Buffer.from('real-bytes');
    const fakeFetch: typeof fetch = async () => new Response(weights, { status: 200 });
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const events: Array<{ type: string; error?: string }> = [];
    for await (const e of provider.pullModel('bad', {
      downloadUrl: 'https://example.invalid/w.gguf',
      sha256: 'a'.repeat(64),
      approxSizeBytes: weights.length,
      name: 'Bad',
      weightsKind: 'checkpoint',
      auxiliaryFiles: [],
    })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'error' && /sha256 mismatch/.test(e.error ?? ''))).toBe(
      true,
    );
    expect(await provider.listInstalledModels()).toHaveLength(0);
  });

  it('downloads diffusion-model + auxiliary files and aggregates progress', async () => {
    const unet = Buffer.from('fake-flux-unet');
    const vae = Buffer.from('fake-vae-bytes');
    const clipL = Buffer.from('fake-clip-l');
    const t5xxl = Buffer.from('fake-t5xxl');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

    const responseFor: Record<string, Buffer> = {
      'https://hf.invalid/flux/unet.gguf': unet,
      'https://hf.invalid/flux/ae.safetensors': vae,
      'https://hf.invalid/flux/clip_l.safetensors': clipL,
      'https://hf.invalid/flux/t5xxl.safetensors': t5xxl,
    };
    const fetched: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      fetched.push(u);
      const body = responseFor[u];
      if (!body) return new Response('not found', { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Length': String(body.length) },
      });
    };

    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const totalBytes = unet.length + vae.length + clipL.length + t5xxl.length;
    const events: Array<{ type: string; bytesWritten?: number; totalBytes?: number }> = [];
    for await (const e of provider.pullModel('flux', {
      downloadUrl: 'https://hf.invalid/flux/unet.gguf',
      sha256: sha(unet),
      approxSizeBytes: unet.length,
      name: 'FLUX',
      weightsKind: 'diffusion-model',
      auxiliaryFiles: [
        {
          role: 'vae',
          downloadUrl: 'https://hf.invalid/flux/ae.safetensors',
          sha256: sha(vae),
          approxSizeBytes: vae.length,
        },
        {
          role: 'clip_l',
          downloadUrl: 'https://hf.invalid/flux/clip_l.safetensors',
          sha256: sha(clipL),
          approxSizeBytes: clipL.length,
        },
        {
          role: 't5xxl',
          downloadUrl: 'https://hf.invalid/flux/t5xxl.safetensors',
          sha256: sha(t5xxl),
          approxSizeBytes: t5xxl.length,
        },
      ],
    })) {
      events.push(e);
    }

    expect(events.at(-1)?.type).toBe('done');
    expect(events.every((e) => e.type !== 'error')).toBe(true);
    expect(fetched).toHaveLength(4);

    // Aux files all use deterministic role-based filenames.
    expect((await readFile(join(modelsRoot, 'flux', 'unet.gguf'))).equals(unet)).toBe(true);
    expect((await readFile(join(modelsRoot, 'flux', 'vae.safetensors'))).equals(vae)).toBe(true);
    expect((await readFile(join(modelsRoot, 'flux', 'clip_l.safetensors'))).equals(clipL)).toBe(
      true,
    );
    expect((await readFile(join(modelsRoot, 'flux', 't5xxl.safetensors'))).equals(t5xxl)).toBe(
      true,
    );

    const manifest = JSON.parse(await readFile(join(modelsRoot, 'flux', 'manifest.json'), 'utf8'));
    expect(manifest.weightsKind).toBe('diffusion-model');
    expect(manifest.weightsFilename).toBe('unet.gguf');
    expect(manifest.auxiliaryFiles).toEqual([
      { role: 'vae', filename: 'vae.safetensors' },
      { role: 'clip_l', filename: 'clip_l.safetensors' },
      { role: 't5xxl', filename: 't5xxl.safetensors' },
    ]);
    expect(manifest.approxSizeBytes).toBe(totalBytes);

    // The terminal progress event covers the entire pull.
    const finalProgress = [...events].reverse().find((e) => e.type === 'progress');
    expect(finalProgress?.bytesWritten).toBe(totalBytes);
    expect(finalProgress?.totalBytes).toBe(totalBytes);
  });

  it('handles FLUX.2-style `llm` auxiliary role (Qwen3 / Mistral encoder)', async () => {
    // FLUX.2 Klein 4B drops the FLUX.1 T5+CLIP pair for a single LLM
    // text encoder (Qwen3-4B). The aux role `llm` flows through the
    // same pull pipeline as vae/clip_l/t5xxl; this test locks in that
    // the install writes a deterministic `llm.gguf`-ish filename and
    // the local manifest records `role: 'llm'` for the launcher to
    // re-emit as `--llm`.
    const unet = Buffer.from('fake-flux2-unet');
    const vae = Buffer.from('fake-flux2-vae');
    const llm = Buffer.from('fake-qwen3-encoder');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

    const responseFor: Record<string, Buffer> = {
      'https://hf.invalid/flux2/unet.gguf': unet,
      'https://hf.invalid/flux2/vae.safetensors': vae,
      'https://hf.invalid/flux2/qwen3-4b.gguf': llm,
    };
    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      const body = responseFor[u];
      if (!body) return new Response('not found', { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Length': String(body.length) },
      });
    };

    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const events: Array<{ type: string }> = [];
    for await (const e of provider.pullModel('flux-2-klein', {
      downloadUrl: 'https://hf.invalid/flux2/unet.gguf',
      sha256: sha(unet),
      approxSizeBytes: unet.length,
      name: 'FLUX.2 Klein 4B',
      weightsKind: 'diffusion-model',
      auxiliaryFiles: [
        {
          role: 'vae',
          downloadUrl: 'https://hf.invalid/flux2/vae.safetensors',
          sha256: sha(vae),
          approxSizeBytes: vae.length,
        },
        {
          role: 'llm',
          downloadUrl: 'https://hf.invalid/flux2/qwen3-4b.gguf',
          sha256: sha(llm),
          approxSizeBytes: llm.length,
        },
      ],
    })) {
      events.push(e);
    }

    expect(events.at(-1)?.type).toBe('done');
    expect(events.every((e) => e.type !== 'error')).toBe(true);

    // The local manifest preserves the `llm` role so the launcher
    // re-emits `--llm <path>` when sd-server is next spawned.
    const manifest = JSON.parse(
      await readFile(join(modelsRoot, 'flux-2-klein', 'manifest.json'), 'utf8'),
    );
    expect(manifest.auxiliaryFiles).toEqual([
      { role: 'vae', filename: 'vae.safetensors' },
      { role: 'llm', filename: 'llm.gguf' },
    ]);
  });

  it('downloads and persists an external JSON tokenizer alongside model weights', async () => {
    const weights = Buffer.from('ming-image-weights');
    const tokenizer = Buffer.from('{"version":"1.0","model":{"type":"BPE"}}');
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake',
      modelsRoot,
      fetchImpl: async (url) => {
        const bytes = String(url).endsWith('.json') ? tokenizer : weights;
        return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
      },
    });
    const auxiliary = ImageModelAuxiliaryFileSchema.parse({
      role: 'tokenizer',
      downloadUrl: 'https://hf.invalid/ming/mllm/tokenizer.json',
      sha256: sha(tokenizer),
      approxSizeBytes: tokenizer.length,
    });
    const events = [];
    for await (const event of provider.pullModel('ming-test', {
      name: 'Ming test',
      weightsKind: 'diffusion-model',
      downloadUrl: 'https://hf.invalid/ming/weights.safetensors',
      sha256: sha(weights),
      approxSizeBytes: weights.length,
      auxiliaryFiles: [auxiliary],
    }))
      events.push(event);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const installed = JSON.parse(
      await readFile(join(modelsRoot, 'ming-test/manifest.json'), 'utf8'),
    );
    expect(installed.auxiliaryFiles).toEqual([{ role: 'tokenizer', filename: 'tokenizer.json' }]);
    expect(installed.fileSha256['tokenizer.json']).toBe(sha(tokenizer));
    expect(await readFile(join(modelsRoot, 'ming-test/tokenizer.json'))).toEqual(tokenizer);
  });

  it('aborts the pull if an auxiliary file fails sha256 and leaves no .partial', async () => {
    const unet = Buffer.from('good-unet');
    const vae = Buffer.from('vae-bytes');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      const body = u.endsWith('unet.gguf') ? unet : vae;
      return new Response(body, {
        status: 200,
        headers: { 'Content-Length': String(body.length) },
      });
    };

    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://fake',
      modelsRoot,
      fetchImpl: fakeFetch,
    });

    const events: Array<{ type: string; error?: string }> = [];
    for await (const e of provider.pullModel('flux-bad', {
      downloadUrl: 'https://hf.invalid/flux/unet.gguf',
      sha256: sha(unet),
      approxSizeBytes: unet.length,
      name: 'FLUX (bad aux)',
      weightsKind: 'diffusion-model',
      auxiliaryFiles: [
        {
          role: 'vae',
          downloadUrl: 'https://hf.invalid/flux/ae.safetensors',
          sha256: 'b'.repeat(64),
          approxSizeBytes: vae.length,
        },
      ],
    })) {
      events.push(e);
    }
    expect(
      events.some((e) => e.type === 'error' && /vae:.*sha256 mismatch/.test(e.error ?? '')),
    ).toBe(true);

    // No manifest should have landed — listInstalledModels skips dirs without one.
    expect(await provider.listInstalledModels()).toHaveLength(0);
    // The bad aux file's .partial must be cleaned up.
    const { readdir } = await import('node:fs/promises');
    const dirEntries = await readdir(join(modelsRoot, 'flux-bad')).catch(() => []);
    expect(dirEntries.every((f) => !f.endsWith('.partial'))).toBe(true);
  });
});

describe('parseSamplingProgress', () => {
  it('extracts step, total, and seconds-per-step from sd-server progress lines', () => {
    expect(parseSamplingProgress('  |==>                       | 1/20 - 18.20s/it')).toEqual({
      step: 1,
      totalSteps: 20,
      secondsPerStep: 18.2,
    });
    expect(parseSamplingProgress('[sd-server]   |======> | 7/20 - 18.04s/it')).toEqual({
      step: 7,
      totalSteps: 20,
      secondsPerStep: 18.04,
    });
  });

  it('reads the iterations-per-second form fast steps print', () => {
    expect(parseSamplingProgress('[sd-server]   |====>        | 2/25 - 8.00it/s\x1b[K')).toEqual({
      step: 2,
      totalSteps: 25,
      secondsPerStep: 0.125,
    });
  });

  it('ignores the weight-loading bar', () => {
    expect(parseSamplingProgress('  |#######        | 195/298 - 4.32GB/s')).toBeNull();
    expect(parseSamplingProgress('  |##             | 8/196 - 2.93MB/s')).toBeNull();
  });

  it('returns null for unrelated log noise', () => {
    expect(
      parseSamplingProgress('[INFO ] stable-diffusion.cpp:2842 - sampling using Euler A'),
    ).toBeNull();
    expect(
      parseSamplingProgress('denoiser.hpp:499 - get_sigmas with discrete scheduler'),
    ).toBeNull();
    expect(parseSamplingProgress('')).toBeNull();
  });
});

describe('StableDiffusionCppProvider — cancel, queue and capacity', () => {
  const pngB64 = () => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4, 0)]).toString('base64');

  function fakeEngine() {
    let logListener: ((line: string) => void) | undefined;
    const supervisor = {
      withRequest: <T>(run: () => Promise<T>, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return run();
      },
      currentBaseUrl: () => 'http://127.0.0.1:9090',
      ensureRunning: async () => ({
        command: 'sd-server',
        args: [],
        baseUrl: 'http://127.0.0.1:9090',
      }),
      markUsed: () => {},
      stop: vi.fn(async () => {}),
      subscribeLogLines: (fn: (line: string) => void) => {
        logListener = fn;
        return () => {
          logListener = undefined;
        };
      },
    };
    return { supervisor, log: (line: string) => logListener?.(line) };
  }

  /** A fetch whose renders finish only when the test says so, honoring the request signal. */
  function gatedFetch() {
    const pending: Array<{ resolve: () => void; prompt: string }> = [];
    const started: string[] = [];
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const prompt = String(JSON.parse(String(init?.body)).prompt);
        started.push(prompt);
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        pending.push({
          prompt,
          resolve: () =>
            resolve(
              new Response(JSON.stringify({ images: [pngB64()] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
        });
      });
    return { fetchImpl, pending, started };
  }

  it('stops the engine when a running render is cancelled', async () => {
    const engine = fakeEngine();
    const gate = gatedFetch();
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: gate.fetchImpl,
      supervisor: engine.supervisor as never,
    });
    const controller = new AbortController();
    const render = provider.generate({ prompt: 'a lighthouse', signal: controller.signal });
    await vi.waitFor(() => expect(gate.started).toEqual(['a lighthouse']));
    controller.abort();
    await expect(render).rejects.toMatchObject({ code: 'image_generation_cancelled' });
    expect(engine.supervisor.stop).toHaveBeenCalled();
  });

  it('renders one image at a time and lets a queued caller leave without touching the engine', async () => {
    const engine = fakeEngine();
    const gate = gatedFetch();
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: gate.fetchImpl,
      supervisor: engine.supervisor as never,
    });
    const first = provider.generate({ prompt: 'first' });
    await vi.waitFor(() => expect(gate.started).toEqual(['first']));

    const leaving = new AbortController();
    const secondEvents: ImageGenerationProgress[] = [];
    const second = provider.generate({
      prompt: 'second',
      signal: leaving.signal,
      onProgress: (p) => secondEvents.push(p),
    });
    const third = provider.generate({ prompt: 'third' });
    await vi.waitFor(() => expect(secondEvents[0]).toMatchObject({ phase: 'queued' }));

    leaving.abort();
    await expect(second).rejects.toMatchObject({ code: 'image_generation_cancelled' });
    // The third caller still waits for the first render, not for the one that left.
    expect(gate.started).toEqual(['first']);
    expect(engine.supervisor.stop).not.toHaveBeenCalled();

    gate.pending[0]!.resolve();
    await first;
    await vi.waitFor(() => expect(gate.started).toEqual(['first', 'third']));
    gate.pending[1]!.resolve();
    await expect(third).resolves.toMatchObject({ meta: { durationMs: expect.any(Number) } });
  });

  it('reports a graphics-memory shortfall as a capacity error and stops the engine', async () => {
    const engine = fakeEngine();
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: async () => {
        engine.log(
          '[sd-server] [W] model manager cannot make enough memory available on Vulkan1: need 4847.50 MB device / 4335.50 MB budget, available 2951.48 MB device',
        );
        return new Response(JSON.stringify({ error: 'generate_image returned no results' }), {
          status: 500,
        });
      },
      supervisor: engine.supervisor as never,
    });
    await expect(provider.generate({ prompt: 'a chart' })).rejects.toMatchObject({
      code: 'image_capacity',
      message: expect.stringContaining('cannot make enough memory available'),
    });
    expect(engine.supervisor.stop).toHaveBeenCalled();
  });

  it('keeps an unexplained engine failure as a plain error', async () => {
    const engine = fakeEngine();
    const provider = new StableDiffusionCppProvider({
      baseUrl: 'http://127.0.0.1:9090',
      modelsRoot,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'generate_image returned no results' }), {
          status: 500,
        }),
      supervisor: engine.supervisor as never,
    });
    await expect(provider.generate({ prompt: 'a chart' })).rejects.toThrow(
      /sd-server returned 500/,
    );
    expect(engine.supervisor.stop).not.toHaveBeenCalled();
  });
});
