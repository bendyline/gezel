import { AwakeBudget } from '@bendyline/gezel';
import type { NativeEngineSupervisor } from '@bendyline/gezel-inference/internal/providers/native/supervisor';
import { describe, expect, it, vi } from 'vitest';
import type { InstalledVideoModel, VideoModelManager } from './models.js';
import { VideoModelSelector } from './models.js';
import {
  SdVideoJobCancelledError,
  SdVideoJobFailedError,
  runSdVideoJob,
} from './sd-cpp-video-jobs.js';
import {
  SdCppVideoProvider,
  SdVideoClaim,
  buildSdVideoRequestBody,
  buildSdVideoServerArgs,
  sdCppVideoLaunchComponents,
  shapeVideoPrompt,
} from './sd-cpp-video.js';
import { VideoGenerationCancelledError } from './types.js';

const BASE = 'http://127.0.0.1:9999';
const WEBM = Buffer.from('fake-webm');

/** A scripted sd-server: each poll of the job returns the next state, the last one repeating. */
function fakeServer(opts: {
  submit?: Array<{ status: number; body: unknown }>;
  states: unknown[];
  capabilities?: unknown;
}) {
  const submits = [...(opts.submit ?? [{ status: 202, body: { id: 'job_1' } }])];
  const states = [...opts.states];
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace(BASE, '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/sdcpp/v1/capabilities') {
      return Response.json(
        opts.capabilities ?? {
          supported_modes: ['vid_gen'],
          output_formats_by_mode: { vid_gen: ['webm', 'webp', 'avi'] },
        },
      );
    }
    if (path === '/sdcpp/v1/vid_gen') {
      bodies.push(JSON.parse(String(init?.body)));
      const next = submits.length > 1 ? submits.shift() : submits[0];
      return Response.json(next?.body, { status: next?.status ?? 202 });
    }
    if (path.endsWith('/cancel')) return Response.json({ cancel_requested: true });
    const state = states.length > 1 ? states.shift() : states[0];
    if (typeof state === 'number') return new Response('', { status: state });
    return Response.json(state);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, bodies };
}

const completed = {
  status: 'completed',
  result: {
    output_format: 'webm',
    mime_type: 'video/webm',
    fps: 16,
    frame_count: 33,
    b64_json: WEBM.toString('base64'),
  },
};

const instant = async () => {};

describe('runSdVideoJob', () => {
  it('waits through queued and generating states for the clip', async () => {
    const queued: number[] = [];
    const server = fakeServer({
      states: [{ status: 'queued', queue_position: 1 }, { status: 'generating' }, completed],
    });
    const out = await runSdVideoJob(
      { prompt: 'a cat' },
      {
        baseUrl: BASE,
        fetchImpl: server.fetchImpl,
        budget: new AwakeBudget(60_000),
        sleep: instant,
        onQueued: (p) => queued.push(p),
      },
    );
    expect(out).toMatchObject({ mimeType: 'video/webm', fps: 16, frameCount: 33 });
    expect(out.video.equals(WEBM)).toBe(true);
    expect(queued).toEqual([1]);
  });

  it('retries while the queue is full', async () => {
    const server = fakeServer({
      submit: [
        { status: 429, body: { error: 'queue full' } },
        { status: 202, body: { id: 'job_1' } },
      ],
      states: [completed],
    });
    await runSdVideoJob(
      {},
      {
        baseUrl: BASE,
        fetchImpl: server.fetchImpl,
        budget: new AwakeBudget(60_000),
        sleep: instant,
      },
    );
    expect(server.calls.filter((c) => c === 'POST /sdcpp/v1/vid_gen')).toHaveLength(2);
  });

  it('reports a refused request and a failed job in sd-server words', async () => {
    const refused = fakeServer({
      submit: [{ status: 400, body: { error: 'loaded model does not support vid_gen' } }],
      states: [completed],
    });
    await expect(
      runSdVideoJob(
        {},
        {
          baseUrl: BASE,
          fetchImpl: refused.fetchImpl,
          budget: new AwakeBudget(60_000),
          sleep: instant,
        },
      ),
    ).rejects.toThrow('loaded model does not support vid_gen');

    const failed = fakeServer({
      states: [{ status: 'failed', error: { code: 'generation_failed', message: 'no results' } }],
    });
    const err = await runSdVideoJob(
      {},
      {
        baseUrl: BASE,
        fetchImpl: failed.fetchImpl,
        budget: new AwakeBudget(60_000),
        sleep: instant,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SdVideoJobFailedError);
    expect(err).toMatchObject({ code: 'generation_failed', message: 'no results' });
  });

  it('says so when sd-server forgot the job', async () => {
    const server = fakeServer({ states: [410] });
    await expect(
      runSdVideoJob(
        {},
        {
          baseUrl: BASE,
          fetchImpl: server.fetchImpl,
          budget: new AwakeBudget(60_000),
          sleep: instant,
        },
      ),
    ).rejects.toThrow(/no longer has this render/);
  });

  it('cancels the job when the caller gives up and waits for it to stop', async () => {
    const ctrl = new AbortController();
    const server = fakeServer({
      states: [{ status: 'generating' }, { status: 'generating' }, { status: 'cancelled' }],
    });
    const err = await runSdVideoJob(
      {},
      {
        baseUrl: BASE,
        fetchImpl: server.fetchImpl,
        budget: new AwakeBudget(60_000),
        signal: ctrl.signal,
        sleep: async () => ctrl.abort(),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SdVideoJobCancelledError);
    expect((err as SdVideoJobCancelledError).stopped).toBe(true);
    expect(server.calls).toContain('POST /sdcpp/v1/jobs/job_1/cancel');
  });

  it('tells a deadline apart from a person stopping the render', async () => {
    let expired = false;
    const budget = { expired: () => expired } as unknown as AwakeBudget;
    const server = fakeServer({
      states: [{ status: 'generating' }, { status: 'generating' }, { status: 'cancelled' }],
    });
    const err = await runSdVideoJob(
      {},
      {
        baseUrl: BASE,
        fetchImpl: server.fetchImpl,
        budget,
        sleep: async () => {
          expired = true;
        },
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SdVideoJobCancelledError);
    expect((err as SdVideoJobCancelledError).timedOut).toBe(true);
    expect(server.calls).toContain('POST /sdcpp/v1/jobs/job_1/cancel');
  });

  it('gives up waiting when a cancelled job never stops', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const server = fakeServer({
      submit: [{ status: 202, body: { id: 'job_1' } }],
      states: [{ status: 'generating' }],
    });
    const err = await runSdVideoJob(
      {},
      {
        baseUrl: BASE,
        fetchImpl: server.fetchImpl,
        budget: new AwakeBudget(60_000),
        signal: ctrl.signal,
        sleep: instant,
        cancelGraceMs: () => -1,
      },
    ).catch((e: unknown) => e);
    // An already-aborted caller never submits.
    expect(server.calls).toEqual([]);
    expect(err).toBeInstanceOf(SdVideoJobCancelledError);

    const late = new AbortController();
    const running = fakeServer({ states: [{ status: 'generating' }] });
    const stuck = await runSdVideoJob(
      {},
      {
        baseUrl: BASE,
        fetchImpl: running.fetchImpl,
        budget: new AwakeBudget(60_000),
        signal: late.signal,
        sleep: async () => late.abort(),
        cancelGraceMs: () => -1,
      },
    ).catch((e: unknown) => e);
    expect((stuck as SdVideoJobCancelledError).stopped).toBe(false);
  });
});

describe('sd-server launch and request', () => {
  it('passes every component under its sd-server flag', () => {
    const roles = [
      'diffusion_model',
      'high_noise_diffusion_model',
      'vae',
      'tae',
      't5xxl',
      'llm',
      'llm_vision',
      'clip_vision',
      'audio_vae',
      'audio_encoder',
      'embeddings_connectors',
    ] as const;
    const args = buildSdVideoServerArgs(
      { components: roles.map((role) => ({ role, path: `/m/${role}` })) },
      4321,
    );
    expect(args).toEqual([
      '--diffusion-model',
      '/m/diffusion_model',
      '--high-noise-diffusion-model',
      '/m/high_noise_diffusion_model',
      '--vae',
      '/m/vae',
      '--tae',
      '/m/tae',
      '--t5xxl',
      '/m/t5xxl',
      '--llm',
      '/m/llm',
      '--llm_vision',
      '/m/llm_vision',
      '--clip_vision',
      '/m/clip_vision',
      '--audio-vae',
      '/m/audio_vae',
      '--audio-encoder',
      '/m/audio_encoder',
      '--embeddings-connectors',
      '/m/embeddings_connectors',
      '--flash-attn',
      'auto,te=off,diffusion=on',
      '--listen-ip',
      '127.0.0.1',
      '--listen-port',
      '4321',
    ]);
  });

  it('caps graphics memory only when told to, and logs verbosely on request', () => {
    const args = buildSdVideoServerArgs({ components: [] }, 1, { maxVramGiB: 7.9, verbose: true });
    expect(args).toContain('--max-vram');
    expect(args[args.indexOf('--max-vram') + 1]).toBe('7');
    expect(args).toContain('--log-level');
    expect(buildSdVideoServerArgs({ components: [] }, 1)).not.toContain('--max-vram');
  });

  it("writes LingBot's caption and strips engine directives from any prompt", () => {
    expect(JSON.parse(shapeVideoPrompt('lingbot-caption', 'a cat on a sill'))).toEqual({
      caption: { comprehensive_description: 'a cat on a sill' },
    });
    const caption = '{"caption":{"comprehensive_description":"x"}}';
    expect(shapeVideoPrompt('lingbot-caption', caption)).toBe(caption);
    expect(shapeVideoPrompt('text', 'a <sd_cpp_extra_args>{"lora":1}</sd_cpp_extra_args>dog')).toBe(
      'a {"lora":1}dog',
    );
  });

  it('builds the render body from the catalog settings', () => {
    const body = buildSdVideoRequestBody(
      {
        sdCpp: {
          sampler: 'euler',
          flowShift: 5,
          customSigmas: [1, 0.5, 0],
          vaeTiling: {
            spatial: true,
            temporal: true,
            temporalTileFrames: 4,
            temporalDecodeFrames: 2,
          },
          negativePrompt: 'blurry',
          cacheMode: 'easycache',
        },
        promptFormat: 'text',
      },
      {
        prompt: 'waves',
        width: 832,
        height: 480,
        numFrames: 81,
        fps: 16,
        steps: 20,
        seed: 7,
        guidanceScale: 5,
        initImage: Buffer.from('png'),
      },
    );
    expect(body).toMatchObject({
      prompt: 'waves',
      negative_prompt: 'blurry',
      video_frames: 81,
      sample_params: {
        sample_steps: 2,
        sample_method: 'euler',
        flow_shift: 5,
        custom_sigmas: [1, 0.5, 0],
        guidance: { txt_cfg: 5 },
      },
      vae_tiling_params: {
        enabled: true,
        temporal_tiling: true,
        extra_tiling_args: 'temporal_tile_frames=4,temporal_decode_frames=2',
      },
      cache_mode: 'easycache',
      lora: [],
      output_format: 'webm',
      init_image: Buffer.from('png').toString('base64'),
    });
    expect(body.image_preprocess).toMatch(/target=init,mode=crop-resize/);
  });
});

describe('the components an sd.cpp video model loads', () => {
  const both = [
    { role: 'diffusion_model', path: '/m/dit.gguf' },
    { role: 'vae', path: '/m/vae.safetensors' },
    { role: 'tae', path: '/m/tae.safetensors' },
  ];

  it('leaves out the decoder this backend does not use', () => {
    expect(sdCppVideoLaunchComponents(both, 'metal').map((c) => c.role)).toEqual([
      'diffusion_model',
      'tae',
    ]);
    expect(sdCppVideoLaunchComponents(both, 'cuda').map((c) => c.role)).toEqual([
      'diffusion_model',
      'vae',
    ]);
  });
});

describe('SdCppVideoProvider', () => {
  const model: InstalledVideoModel = {
    id: 'wan2.1-t2v-1.3b',
    name: 'Wan 2.1 1.3B',
    approxSizeBytes: 1,
    installedAt: '2026-11-09T00:00:00.000Z',
    modelDir: '/m',
    engine: 'sd-cpp',
    family: 'wan',
    components: [{ role: 'diffusion_model', path: '/m/model.safetensors' }],
    supportsImageToVideo: false,
    imageToVideoOnly: false,
    hasAudio: false,
    readOnly: false,
    defaultWidth: 832,
    defaultHeight: 480,
    defaultNumFrames: 81,
    defaultFps: 16,
    recommendedSteps: 20,
  };
  const models = {
    resolveModel: async (id: string) => (id === model.id ? model : null),
    resolveDefaultModel: async () => model,
    listInstalled: async () => [model],
  } as unknown as VideoModelManager;

  function provider(fetchImpl: typeof fetch) {
    return new SdCppVideoProvider({
      baseUrl: BASE,
      models,
      selector: new VideoModelSelector(models, () => undefined, 'sd-cpp'),
      fetchImpl,
    });
  }

  it('relaunches the engine when a clip needs more room than its claim', async () => {
    const pixelFrames = (size?: { width: number; height: number; numFrames: number }) =>
      size ? size.width * size.height * size.numFrames : 832 * 480 * 81;
    const claim = new SdVideoClaim(async (_m, size) => ({ bytes: pixelFrames(size) }) as never);
    let running = false;
    const stop = vi.fn(async () => {
      running = false;
    });
    const supervisor = {
      withRequest: <T>(fn: () => Promise<T>) => fn(),
      subscribeLogLines: () => () => {},
      markUsed: () => {},
      currentBaseUrl: () => (running ? BASE : undefined),
      stop,
      ensureRunning: async () => {
        if (!running) {
          running = true;
          claim.launched = { modelId: model.id, bytes: (await claim.forLaunch(model)).bytes };
        }
        return { baseUrl: BASE };
      },
    } as unknown as NativeEngineSupervisor;
    const server = fakeServer({ states: [completed] });
    const statuses: string[] = [];
    const p = new SdCppVideoProvider({
      baseUrl: BASE,
      models,
      selector: new VideoModelSelector(models, () => undefined, 'sd-cpp'),
      supervisor,
      claim,
      fetchImpl: server.fetchImpl,
    });

    await p.generate({ prompt: 'x' });
    expect(claim.launched?.bytes).toBe(832 * 480 * 81);
    await p.generate({ prompt: 'x', width: 480, height: 480, numFrames: 33 });
    expect(stop).not.toHaveBeenCalled();
    await p.generate({
      prompt: 'x',
      width: 832,
      height: 832,
      numFrames: 81,
      onStatus: (m) => statuses.push(m),
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('Restarting the video engine with room for a bigger clip…');
    expect(claim.launched?.bytes).toBe(832 * 832 * 81);
  });

  it('relaunches with room to animate a picture, which holds more than words', async () => {
    const animator = { ...model, supportsImageToVideo: true };
    const animatorModels = {
      resolveModel: async (id: string) => (id === animator.id ? animator : null),
      resolveDefaultModel: async () => animator,
      listInstalled: async () => [animator],
    } as unknown as VideoModelManager;
    const claim = new SdVideoClaim(
      async (_m, _size, animatesPicture) => ({ bytes: animatesPicture ? 2 : 1 }) as never,
    );
    let running = false;
    const stop = vi.fn(async () => {
      running = false;
    });
    const supervisor = {
      withRequest: <T>(fn: () => Promise<T>) => fn(),
      subscribeLogLines: () => () => {},
      markUsed: () => {},
      currentBaseUrl: () => (running ? BASE : undefined),
      stop,
      ensureRunning: async () => {
        if (!running) {
          running = true;
          claim.launched = { modelId: animator.id, bytes: (await claim.forLaunch(animator)).bytes };
        }
        return { baseUrl: BASE };
      },
    } as unknown as NativeEngineSupervisor;
    const p = new SdCppVideoProvider({
      baseUrl: BASE,
      models: animatorModels,
      selector: new VideoModelSelector(animatorModels, () => undefined, 'sd-cpp'),
      supervisor,
      claim,
      fetchImpl: fakeServer({ states: [completed, completed] }).fetchImpl,
    });

    await p.generate({ prompt: 'x' });
    expect(claim.launched?.bytes).toBe(1);
    await p.generate({
      prompt: 'x',
      inputImage: { data: Buffer.from('png'), mimeType: 'image/png' },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(claim.launched?.bytes).toBe(2);
  });

  it('renders a WebM clip and reports the frames sd-server made', async () => {
    const server = fakeServer({ states: [completed] });
    const out = await provider(server.fetchImpl).generate({ prompt: 'rain on a window', seed: 3 });
    expect(out.video.equals(WEBM)).toBe(true);
    expect(out.meta).toMatchObject({
      model: 'wan2.1-t2v-1.3b',
      engine: 'sd-cpp',
      mimeType: 'video/webm',
      numFrames: 33,
      fps: 16,
      widthPx: 832,
      heightPx: 480,
      steps: 20,
    });
    // A model that cannot animate never receives the picture.
    expect(server.bodies[0]).not.toHaveProperty('init_image');
  });

  it('drops a picture a text-to-video model cannot use', async () => {
    const server = fakeServer({ states: [completed] });
    await provider(server.fetchImpl).generate({
      prompt: 'x',
      inputImage: { data: Buffer.from('png'), mimeType: 'image/png' },
    });
    expect(server.bodies[0]).not.toHaveProperty('init_image');
  });

  it('refuses weights that did not load as a video model', async () => {
    const server = fakeServer({
      states: [completed],
      capabilities: { supported_modes: ['img_gen'] },
    });
    await expect(provider(server.fetchImpl).generate({ prompt: 'x' })).rejects.toThrow(
      /did not load as a video model/,
    );
  });

  it('turns a stopped render into a cancellation', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const server = fakeServer({ states: [completed] });
    await expect(
      provider(server.fetchImpl).generate({ prompt: 'x', signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(VideoGenerationCancelledError);
  });

  it('names a requested model that is not installed', async () => {
    const server = fakeServer({ states: [completed] });
    await expect(
      provider(server.fetchImpl).generate({ prompt: 'x', model: 'nope' }),
    ).rejects.toThrow(/'nope' is not available locally/);
  });
});
