import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProjectConnectorBinding } from '@bendyline/gezel';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RemoteImageProvider } from '../providers/image/remote-image.js';
import {
  CAMERA_PIXELS_CLOUD_ENGINE,
  CAMERA_PIXELS_PAIRED_ENGINE,
  CAMERA_PIXELS_WITHHELD,
} from './caller-location.js';
import type { ServiceContext } from './context.js';
import { imageGenRoutes } from './routes/image-gen.js';
import { renderRoutes } from './routes/render.js';
import { videoGenRoutes } from './routes/video-gen.js';

// The 1.26300.100 audit: the camera check guarded direct reads, but the
// image tools opened keyframes on their own, so a cloud gezel could get a
// camera's pixels back as a render, an edit or a video's first frame.

const KEYFRAME = 'data/mud-room/events/2026-10-27/15/attachments/001/keyframe-1.jpg';
const CHART = 'reports/chart.png';

let artifacts: string;

beforeAll(async () => {
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-camera-routes-'));
  for (const rel of [KEYFRAME, CHART]) {
    await mkdir(join(artifacts, rel, '..'), { recursive: true });
    await writeFile(join(artifacts, rel), 'pixels');
  }
});

afterAll(async () => {
  await rm(artifacts, { recursive: true, force: true });
});

function camera(allowCloudModels: boolean): ProjectConnectorBinding {
  return {
    id: 'cam1',
    type: 'camera-local',
    driver: 'device',
    corpusDir: 'data/mud-room',
    config: { device: 'x', allowCloudModels },
  };
}

function harness(opts: {
  session: string;
  engine: string;
  allowCloud?: boolean;
  provider?: unknown;
}) {
  const reached = new Error('reached the engine');
  const generate = vi.fn(async () => {
    throw reached;
  });
  const provider = opts.provider ?? {
    name: opts.engine,
    generate,
    listInstalledModels: async () => [],
  };
  const ctx = {
    store: {
      getProject: async (id: string) => ({ id, connectors: [camera(opts.allowCloud ?? false)] }),
      projectArtifactsDir: () => artifacts,
      resolveProjectArtifactReadPath: async (_id: string, p: string) => resolve(artifacts, p),
      resolveProjectArtifact: async (_id: string, p: string) => ({
        kind: 'found',
        path: p,
        content: '',
        fuzzy: false,
      }),
      readProjectArtifactBinary: async () => ({
        data: Buffer.from('pixels'),
        mimeType: 'image/jpeg',
      }),
      writeProjectArtifactBinary: async (_id: string, p: string) => p,
      readConfig: async () => ({}),
    },
    chat: { getSessionRecord: async () => ({ providerName: opts.session }) },
    renderer: {
      render: async (
        req: { layers: { artifactPath?: string }[] },
        o: { resolveImage: (p: string) => Promise<string | null> },
      ) => {
        for (const layer of req.layers)
          if (layer.artifactPath) await o.resolveImage(layer.artifactPath);
        return {
          buffer: Buffer.from('png'),
          mimeType: 'image/png',
          width: 8,
          height: 8,
          engine: 'test',
        };
      },
    },
    history: { log: async () => {} },
    catalog: { get: async () => null },
    chatEvents: { publish: () => {} },
    imageProvider: { providerForModel: async () => provider },
    videoProvider: { providerForModel: async () => provider },
  } as unknown as ServiceContext;

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { appId: 'session:s1', scopes: ['session'] } as never);
    await next();
  });
  app.route('/api/render', renderRoutes(ctx));
  app.route('/api/image-gen', imageGenRoutes(ctx));
  app.route('/api/video-gen', videoGenRoutes(ctx));

  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  };
  return {
    generate,
    render: (path: string) =>
      post('/api/render/image', {
        width: 8,
        height: 8,
        layers: [{ kind: 'image', artifactPath: path }],
      }),
    image: (path: string) =>
      post('/api/image-gen/generate', {
        prompt: 'make it yellow',
        inputImages: [{ artifactPath: path }],
      }),
    video: (path: string) =>
      post('/api/video-gen/generate', {
        prompt: 'the cat walks in',
        inputImage: { artifactPath: path },
      }),
  };
}

describe('camera keyframes in the image tools', () => {
  it('keeps a keyframe out of every image tool for a cloud session', async () => {
    const h = harness({ session: 'copilot', engine: 'sd-local' });
    expect(await h.render(KEYFRAME)).toEqual({ status: 403, error: CAMERA_PIXELS_WITHHELD });
    expect(await h.image(KEYFRAME)).toEqual({ status: 403, error: CAMERA_PIXELS_WITHHELD });
    expect(await h.video(KEYFRAME)).toEqual({ status: 403, error: CAMERA_PIXELS_WITHHELD });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('catches a keyframe spelled another way', async () => {
    const h = harness({ session: 'copilot', engine: 'sd-local' });
    const spelling =
      'reports/../data/./mud-room//events/2026-10-27/15/attachments/001/keyframe-1.jpg';
    expect((await h.render(spelling)).status).toBe(403);
    expect((await h.image(`artifacts/${spelling}`)).status).toBe(403);
  });

  it('never sends a keyframe to a cloud image engine, even from an on-device session', async () => {
    const h = harness({ session: 'llama-cpp', engine: 'google-ai' });
    expect(await h.image(KEYFRAME)).toEqual({ status: 403, error: CAMERA_PIXELS_CLOUD_ENGINE });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('lets an on-device session use a keyframe on an on-device engine', async () => {
    const h = harness({ session: 'llama-cpp', engine: 'sd-local' });
    expect((await h.render(KEYFRAME)).status).toBe(200);
    expect(await h.image(KEYFRAME)).toEqual({ status: 500, error: 'reached the engine' });
    expect(await h.video(KEYFRAME)).toEqual({ status: 500, error: 'reached the engine' });
  });

  it('lets cloud sessions and engines use a camera that allows cloud AI', async () => {
    const h = harness({ session: 'copilot', engine: 'google-ai', allowCloud: true });
    expect((await h.render(KEYFRAME)).status).toBe(200);
    expect(await h.image(KEYFRAME)).toEqual({ status: 500, error: 'reached the engine' });
  });

  // A paired server names itself local but renders with whatever engine it
  // has picked, which can be a cloud one this computer cannot see.
  function pairedServer(onThisComputer: boolean) {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error('reached the engine');
    });
    const provider = new RemoteImageProvider({
      remoteId: onThisComputer ? 'machine' : 'office-pc',
      label: onThisComputer ? 'This computer' : 'Office PC',
      baseUrl: 'https://192.168.1.20:6229',
      token: 't',
      fetch: fetch as unknown as typeof globalThis.fetch,
      onThisComputer,
    });
    return { provider, fetch };
  }

  it("never sends a keyframe to a paired server's engine", async () => {
    const paired = pairedServer(false);
    const h = harness({ session: 'llama-cpp', engine: 'unused', provider: paired.provider });
    expect(await h.image(KEYFRAME)).toEqual({ status: 403, error: CAMERA_PIXELS_PAIRED_ENGINE });
    expect(paired.fetch).not.toHaveBeenCalled();
  });

  it("uses this computer's machine engine for a keyframe", async () => {
    const broker = pairedServer(true);
    const h = harness({ session: 'llama-cpp', engine: 'unused', provider: broker.provider });
    expect(await h.image(KEYFRAME)).toEqual({ status: 500, error: 'reached the engine' });
    expect(broker.fetch.mock.calls.map(([url]) => String(url))).toContain(
      'https://192.168.1.20:6229/v1/remote/image/generate',
    );
  });

  it('lets a paired server use a camera that allows cloud AI, and other images', async () => {
    const allowed = pairedServer(false);
    const h = harness({
      session: 'llama-cpp',
      engine: 'unused',
      provider: allowed.provider,
      allowCloud: true,
    });
    expect(await h.image(KEYFRAME)).toEqual({ status: 500, error: 'reached the engine' });
    const other = pairedServer(false);
    const h2 = harness({ session: 'llama-cpp', engine: 'unused', provider: other.provider });
    expect(await h2.image(CHART)).toEqual({ status: 500, error: 'reached the engine' });
  });

  it('leaves images outside the camera alone', async () => {
    const h = harness({ session: 'copilot', engine: 'google-ai' });
    expect((await h.render(CHART)).status).toBe(200);
    expect(await h.image(CHART)).toEqual({ status: 500, error: 'reached the engine' });
    expect(await h.video(CHART)).toEqual({ status: 500, error: 'reached the engine' });
  });
});
