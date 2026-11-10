import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../../http/context.js';
import { v1RemoteRoutes } from '../../http/routes/v1-remote.js';
import { RemoteVideoProvider } from './remote-video.js';
import {
  VideoCapacityError,
  VideoGenerationCancelledError,
  type VideoGenerationInput,
  type VideoGenerationOutput,
  type VideoGenerationProgress,
  type VideoProvider,
} from './types.js';

const meta = {
  model: 'wan2.2-ti2v-5b-q4',
  seed: 7,
  steps: 4,
  widthPx: 64,
  heightPx: 64,
  numFrames: 5,
  fps: 8,
  durationMs: 10,
  mimeType: 'video/webm',
  engine: 'sd-cpp',
};

/** B's real `/v1/remote` routes over a fake engine, and A's provider talking to them in process. */
function pair(
  generate: (input: VideoGenerationInput) => Promise<VideoGenerationOutput>,
  opts: { streamRoute?: boolean } = {},
): { provider: RemoteVideoProvider; paths: string[] } {
  const engine = { generate } as unknown as VideoProvider;
  const app = new Hono();
  app.route(
    '/v1/remote',
    v1RemoteRoutes({
      videoProvider: { current: async () => engine },
    } as unknown as ServiceContext),
  );
  const paths: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    // A server from before the stream answers it like any unknown route.
    if (opts.streamRoute === false && path.endsWith('/generate-stream')) {
      return new Response('Not Found', { status: 404 });
    }
    return app.request(String(url), init);
  }) as typeof globalThis.fetch;
  return {
    provider: new RemoteVideoProvider({
      remoteId: 'studio',
      label: 'Studio',
      baseUrl: 'http://studio.local',
      token: 'token',
      fetch,
    }),
    paths,
  };
}

describe('RemoteVideoProvider', () => {
  it('relays the engine status and steps as they happen, then the clip', async () => {
    const { provider, paths } = pair(async (input) => {
      input.onStatus?.('Loading the model…');
      input.onProgress?.({ step: 1, totalSteps: 2 });
      input.onProgress?.({ step: 2, totalSteps: 2, secondsPerStep: 3.5 });
      return { video: Buffer.from('webm'), poster: Buffer.from('poster'), meta };
    });
    const statuses: string[] = [];
    const steps: VideoGenerationProgress[] = [];
    const out = await provider.generate({
      prompt: 'waves',
      onStatus: (message) => statuses.push(message),
      onProgress: (progress) => steps.push(progress),
    });

    expect(paths).toEqual(['/v1/remote/video/generate-stream']);
    expect(statuses).toEqual(['Loading the model…']);
    expect(steps).toEqual([
      { step: 1, totalSteps: 2 },
      { step: 2, totalSteps: 2, secondsPerStep: 3.5 },
    ]);
    expect(out.video.toString()).toBe('webm');
    expect(out.poster?.toString()).toBe('poster');
    expect(out.meta).toEqual(meta);
  });

  it('keeps a capacity refusal a capacity refusal across the wire', async () => {
    const { provider } = pair(async () => {
      throw new VideoCapacityError('A clip this long needs 30 GB; try 3 seconds.');
    });
    const err = await provider.generate({ prompt: 'waves' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VideoCapacityError);
    expect((err as Error).message).toBe('A clip this long needs 30 GB; try 3 seconds.');
  });

  it('falls back to the one-shot route on a server from before the stream', async () => {
    const { provider, paths } = pair(
      async (input) => {
        input.onProgress?.({ step: 1, totalSteps: 1 });
        return { video: Buffer.from('webm'), meta };
      },
      { streamRoute: false },
    );
    const out = await provider.generate({ prompt: 'waves', onProgress: () => {} });
    expect(paths).toEqual(['/v1/remote/video/generate-stream', '/v1/remote/video/generate']);
    expect(out.video.toString()).toBe('webm');

    const refusing = pair(
      async () => {
        throw new VideoCapacityError('Too long for this computer.');
      },
      { streamRoute: false },
    );
    await expect(refusing.provider.generate({ prompt: 'waves' })).rejects.toBeInstanceOf(
      VideoCapacityError,
    );
  });

  it('stops the server render when the caller hangs up', async () => {
    let engineStopped = false;
    const { provider } = pair(
      (input) =>
        new Promise((_, reject) => {
          input.onStatus?.('Sampling…');
          input.signal?.addEventListener('abort', () => {
            engineStopped = true;
            reject(new VideoGenerationCancelledError('stopped'));
          });
        }),
    );
    const controller = new AbortController();
    const err = await provider
      .generate({
        prompt: 'waves',
        signal: controller.signal,
        onStatus: () => controller.abort(),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VideoGenerationCancelledError);
    expect(engineStopped).toBe(true);
  });
});
