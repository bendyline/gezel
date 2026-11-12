import { describe, expect, it } from 'vitest';
import { LocalVideoProvider } from './local-video.js';
import type { InstalledVideoModel, VideoModelManager } from './models.js';
import type { VideoGenerationInput, VideoProvider } from './types.js';

function installed(id: string, engine: 'diffusers' | 'sd-cpp'): InstalledVideoModel {
  return {
    id,
    name: id,
    approxSizeBytes: 1,
    installedAt: '2026-11-09T00:00:00.000Z',
    modelDir: `/m/${id}`,
    engine,
    family: 'wan',
    supportsImageToVideo: false,
    imageToVideoOnly: false,
    hasAudio: false,
    readOnly: false,
  };
}

function engine(name: string) {
  const calls: VideoGenerationInput[] = [];
  let stops = 0;
  const provider: VideoProvider = {
    name,
    generate: async (input) => {
      calls.push(input);
      return {
        video: Buffer.from(name),
        meta: {
          model: input.model ?? '',
          seed: 1,
          steps: 1,
          widthPx: 1,
          heightPx: 1,
          numFrames: 1,
          fps: 1,
          durationMs: 1,
          mimeType: 'video/webm',
        },
      };
    },
    listInstalledModels: async () => [],
    pullModel: () => (async function* () {})(),
    deleteModel: async () => {},
    health: async () => ({ status: 'ok', baseUrl: '' }),
    shutdown: async () => {
      stops += 1;
    },
  };
  return { provider, calls, stops: () => stops };
}

function setup(defaultModelId?: string) {
  const all = [installed('ltx-2.3-22b', 'diffusers'), installed('wan2.2-ti2v-5b-q4', 'sd-cpp')];
  const models = {
    resolveModel: async (id: string) => all.find((m) => m.id === id) ?? null,
    resolveDefaultModel: async () => all[0] ?? null,
    listInstalled: async () => all,
  } as unknown as VideoModelManager;
  const diffusers = engine('diffusers');
  const sdCpp = engine('sd-cpp');
  const local = new LocalVideoProvider({
    models,
    engines: { diffusers: diffusers.provider, 'sd-cpp': sdCpp.provider },
    defaultModelId: () => defaultModelId,
  });
  return { local, diffusers, sdCpp };
}

describe('LocalVideoProvider', () => {
  it("sends a render to its model's engine and stops the other one", async () => {
    const { local, diffusers, sdCpp } = setup();
    const out = await local.generate({ prompt: 'x', model: 'wan2.2-ti2v-5b-q4' });
    expect(out.video.toString()).toBe('sd-cpp');
    expect(sdCpp.calls[0]?.model).toBe('wan2.2-ti2v-5b-q4');
    expect(diffusers.calls).toHaveLength(0);
    expect(diffusers.stops()).toBe(1);
    expect(sdCpp.stops()).toBe(0);
  });

  it('uses the configured default, then the first installed model', async () => {
    const configured = setup('wan2.2-ti2v-5b-q4');
    await configured.local.generate({ prompt: 'x' });
    expect(configured.sdCpp.calls[0]?.model).toBe('wan2.2-ti2v-5b-q4');

    const unset = setup();
    await unset.local.generate({ prompt: 'x' });
    expect(unset.diffusers.calls[0]?.model).toBe('ltx-2.3-22b');
  });

  it('names a requested model that is not installed', async () => {
    const { local } = setup();
    await expect(local.generate({ prompt: 'x', model: 'nope' })).rejects.toThrow(
      /'nope' is not available locally/,
    );
  });

  it('never stops an engine while its render is running', async () => {
    const { local, diffusers, sdCpp } = setup();
    let finishDiffusers!: () => void;
    const diffusersRender = diffusers.provider.generate;
    diffusers.provider.generate = async (input) => {
      await new Promise<void>((resolve) => {
        finishDiffusers = resolve;
      });
      return diffusersRender(input);
    };
    const long = local.generate({ prompt: 'long', model: 'ltx-2.3-22b' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const statuses: string[] = [];
    const animate = local.generate({
      prompt: 'animate',
      model: 'wan2.2-ti2v-5b-q4',
      onStatus: (message) => statuses.push(message),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(diffusers.stops()).toBe(0);
    expect(sdCpp.calls).toHaveLength(0);
    expect(statuses).toEqual(['Waiting for another video to finish…']);

    finishDiffusers();
    await long;
    await animate;
    expect(diffusers.stops()).toBe(1);
    expect(sdCpp.calls[0]?.prompt).toBe('animate');
  });

  it('leaves the queue when canceled and keeps later renders in order', async () => {
    const { local, diffusers, sdCpp } = setup();
    let finishFirst!: () => void;
    const diffusersRender = diffusers.provider.generate;
    diffusers.provider.generate = async (input) => {
      if (input.prompt === 'first') {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      return diffusersRender(input);
    };
    const first = local.generate({ prompt: 'first', model: 'ltx-2.3-22b' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    const canceled = local.generate({
      prompt: 'canceled',
      model: 'wan2.2-ti2v-5b-q4',
      signal: controller.signal,
    });
    const third = local.generate({ prompt: 'third', model: 'wan2.2-ti2v-5b-q4' });
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ code: 'video_generation_cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sdCpp.calls).toHaveLength(0);
    expect(diffusers.stops()).toBe(0);

    finishFirst();
    await first;
    await third;
    expect(sdCpp.calls.map((c) => c.prompt)).toEqual(['third']);
  });
});
