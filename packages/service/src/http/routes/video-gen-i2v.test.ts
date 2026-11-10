import type { VideoModelManifest } from '@bendyline/gezel';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type {
  InstalledVideoModelInfo,
  VideoGenerationInput,
  VideoProvider,
} from '../../providers/video/types.js';
import type { ServiceContext } from '../context.js';
import { videoGenRoutes } from './video-gen.js';

/** A 2x4 (portrait) PNG: width 2, height 4. */
const PORTRAIT_PNG = (() => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  png.writeUInt32BE(1080, 16);
  png.writeUInt32BE(1920, 20);
  return png;
})();

const WORDS: InstalledVideoModelInfo = {
  id: 'wan2.1-t2v-1.3b',
  name: 'Wan 2.1 1.3B',
  approxSizeBytes: 1,
  installedAt: '2026-11-09T00:00:00.000Z',
  supportsImageToVideo: false,
};
const ANIMATES: InstalledVideoModelInfo = {
  id: 'wan2.2-ti2v-5b-q4',
  name: 'Wan 2.2 5B',
  approxSizeBytes: 1,
  installedAt: '2026-11-09T00:00:00.000Z',
  supportsImageToVideo: true,
};

const CATALOG: Record<string, Partial<VideoModelManifest>> = {
  [WORDS.id]: {
    kind: 'video-model',
    family: 'wan',
    architecture: 'wan2.1-1.3b',
    defaultWidth: 832,
    defaultHeight: 480,
    defaultNumFrames: 81,
    defaultFps: 16,
  },
  [ANIMATES.id]: {
    kind: 'video-model',
    family: 'wan',
    architecture: 'wan2.2-ti2v-5b',
    defaultWidth: 1280,
    defaultHeight: 704,
    defaultNumFrames: 121,
    defaultFps: 24,
    widthRange: { min: 512, max: 1280 },
    heightRange: { min: 512, max: 1280 },
  },
};

function harness(installed: InstalledVideoModelInfo[], defaultVideoModel?: string) {
  const calls: VideoGenerationInput[] = [];
  const provider: VideoProvider = {
    name: 'local',
    generate: vi.fn(async (input: VideoGenerationInput) => {
      calls.push(input);
      return {
        video: Buffer.from('mp4'),
        meta: {
          model: input.model ?? '',
          seed: 1,
          steps: 1,
          widthPx: input.width ?? 1,
          heightPx: input.height ?? 1,
          numFrames: input.numFrames ?? 1,
          fps: input.fps ?? 1,
          durationMs: 1,
          mimeType: 'video/mp4',
        },
      };
    }),
    listInstalledModels: async () => installed,
    pullModel: () => (async function* () {})(),
    deleteModel: async () => {},
    health: async () => ({ status: 'ok', baseUrl: '' }),
  };
  const ctx = {
    store: {
      getProject: async (id: string) => ({ id, connectors: [] }),
      resolveProjectArtifactReadPath: async () => null,
      readProjectArtifactBinary: async () => ({ data: PORTRAIT_PNG, mimeType: 'image/png' }),
      writeProjectArtifactBinary: async (_id: string, p: string) => p,
      writeProjectWorkspaceBinary: async () => {},
      readConfig: async () => ({ defaultVideoModel }),
    },
    catalog: {
      get: async (_kind: string, id: string) =>
        CATALOG[id] ? { manifest: { id, ...CATALOG[id] } } : null,
    },
    chatEvents: { publish: () => {} },
    videoProvider: { providerForModel: async () => provider },
  } as unknown as ServiceContext;
  const app = new Hono();
  app.route('/api/video-gen', videoGenRoutes(ctx));
  const post = async (body: unknown) => {
    const res = await app.request('/api/video-gen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { post, calls };
}

const picture = { artifactPath: 'artifacts/generated/cat.png' };

describe('image-to-video through the generate route', () => {
  it('refuses to animate when there is no picture', async () => {
    const h = harness([ANIMATES]);
    const res = await h.post({ prompt: 'move', requireImageToVideo: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('video_source_required');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a required animation when no installed model animates', async () => {
    const h = harness([WORDS]);
    const res = await h.post({ prompt: 'move', inputImage: picture, requireImageToVideo: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('video_i2v_unavailable');
  });

  it('says it left the picture out when the model makes clips from words only', async () => {
    const h = harness([WORDS]);
    const res = await h.post({ prompt: 'move', inputImage: picture });
    expect(res.status).toBe(200);
    expect((res.body.meta as { i2vSkippedReason?: string }).i2vSkippedReason).toMatch(
      /makes clips from words only/,
    );
    expect(h.calls[0]?.inputImage).toBeUndefined();
  });

  it('picks a model that animates over a default that cannot', async () => {
    const h = harness([WORDS, ANIMATES], WORDS.id);
    await h.post({ prompt: 'move', inputImage: picture });
    expect(h.calls[0]?.model).toBe(ANIMATES.id);
    expect(h.calls[0]?.inputImage?.data.equals(PORTRAIT_PNG)).toBe(true);
  });

  it("renders in the picture's shape on the model's grid", async () => {
    const h = harness([ANIMATES]);
    await h.post({ prompt: 'move', inputImage: picture });
    const { width, height, numFrames } = h.calls[0] ?? {};
    expect(height).toBeGreaterThan(width as number);
    expect((width as number) % 32).toBe(0);
    expect((height as number) % 32).toBe(0);
    expect(numFrames).toBe(121);
  });

  it('snaps a requested length onto the frame grid and says so', async () => {
    const h = harness([WORDS]);
    const res = await h.post({ prompt: 'waves', numFrames: 80 });
    expect(h.calls[0]?.numFrames).toBe(77);
    expect((res.body.meta as { settingsNotes?: string[] }).settingsNotes?.[0]).toMatch(
      /77 frames/,
    );
  });
});
