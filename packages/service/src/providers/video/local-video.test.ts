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
});
