import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppEnsureEventSchema,
  AppImageGenerationEventSchema,
  AppImageModelListSchema,
} from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningInferenceService, startService } from '../../inference-service.js';
import { MockImageProvider } from '../../providers/image/mock.js';
import {
  ImageGenerationCancelledError,
  type ImageModelPullEvent,
  type ImageProvider,
} from '../../providers/image/types.js';

vi.mock('../../memory/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/embeddings.js')>()),
  embedBatch: async (texts: string[]) => texts.map((text) => [text.length, 1]),
}));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let running: RunningInferenceService | undefined;
let home: string | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (home) await rm(home, { recursive: true, force: true });
});

async function start(imageProvider: ImageProvider) {
  home = await mkdtemp(join(tmpdir(), 'gezel-images-'));
  running = await startService({ home, imageProvider });
  return (path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) =>
    running!.fetch(`http://gezel.local${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${running!.clientToken}`,
        'Content-Type': 'application/json',
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
}

/** Every `data:` payload of an SSE response, parsed, skipping keep-alive pings. */
async function sseEvents(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data));
}

describe('/v1/images on hosted inference', () => {
  it('lists catalog image models apart from chat models and advertises images in health', async () => {
    const request = await start(new MockImageProvider());
    const health = (await (await running!.fetch('http://gezel.local/api/health')).json()) as {
      images?: { available: boolean };
    };
    expect(health.images).toEqual({ available: true });

    const list = AppImageModelListSchema.parse(await (await request('/v1/images/models')).json());
    const ming = list.data.find((m) => m.id === 'sd-cpp:ming-image-0.1-design-bf16');
    expect(ming).toMatchObject({
      availability: 'download-required',
      renders_text: true,
      prompt_style: 'sentences',
      hardware_tier: 'workstation',
      commercial_use: true,
    });
    expect(ming?.download_bytes).toBeGreaterThan(40e9);
    const chat = (await (await request('/v1/models')).json()) as { data: { id: string }[] };
    expect(chat.data.some((m) => m.id.startsWith('sd-cpp:'))).toBe(false);
  });

  it('installs a model through ensure, then renders it as a PNG', async () => {
    const request = await start(new MockImageProvider());
    const before = await request('/v1/images/generations', { body: { prompt: 'a lighthouse' } });
    expect(before.status).toBe(409);
    expect(await before.json()).toMatchObject({ error: { code: 'no_local_image_model' } });

    const ensure = await request('/v1/images/models/ensure', { body: { model: 'sd-cpp:sd-1.5' } });
    expect(ensure.status).toBe(202);
    const { job_id: jobId } = (await ensure.json()) as { job_id: string };
    const events = (await sseEvents(await request(`/v1/images/models/ensure/${jobId}/events`))).map(
      (e) => AppEnsureEventSchema.parse(e),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', modelId: 'sd-cpp:sd-1.5' });
    expect(events.some((e) => e.type === 'progress')).toBe(true);

    const again = await request('/v1/images/models/ensure', { body: { model: 'sd-cpp:sd-1.5' } });
    expect(await again.json()).toEqual({ status: 'ready', model_id: 'sd-cpp:sd-1.5' });
    const list = AppImageModelListSchema.parse(await (await request('/v1/images/models')).json());
    expect(list.data.find((m) => m.id === 'sd-cpp:sd-1.5')?.availability).toBe('available');

    const render = await request('/v1/images/generations', {
      body: { prompt: 'a lighthouse', model: 'sd-cpp:sd-1.5', aspect_ratio: '1:1', seed: 7 },
    });
    expect(render.headers.get('content-type')).toContain('text/event-stream');
    const done = (await sseEvents(render))
      .map((e) => AppImageGenerationEventSchema.parse(e))
      .at(-1);
    expect(done).toMatchObject({ type: 'done', model: 'sd-cpp:sd-1.5', seed: 7 });
    if (done?.type !== 'done') throw new Error('expected a done event');
    expect(Buffer.from(done.b64_png, 'base64').subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it('cancels the render when the client closes the stream', async () => {
    let sawAbort = false;
    const provider: ImageProvider = {
      name: 'sd-cpp',
      listInstalledModels: async () => [
        { id: 'sd-1.5', name: 'SD 1.5', approxSizeBytes: 1, installedAt: '2026-10-25T00:00:00Z' },
      ],
      resolveDefaultModelId: async () => 'sd-1.5',
      generate: (input) =>
        new Promise((_resolve, reject) => {
          input.onProgress?.({ phase: 'sampling', step: 1, totalSteps: 20 });
          input.signal?.addEventListener('abort', () => {
            sawAbort = true;
            reject(new ImageGenerationCancelledError());
          });
        }),
      pullModel: async function* () {},
      deleteModel: async () => {},
      health: async () => ({ status: 'ok', baseUrl: 'test://' }),
    };
    const request = await start(provider);
    const response = await request('/v1/images/generations', { body: { prompt: 'a chart' } });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"phase":"sampling"');
    await reader.cancel();
    await vi.waitFor(() => expect(sawAbort).toBe(true));
  });

  it('cancels a download on request and refuses ids from other engines', async () => {
    let pullSignal: AbortSignal | undefined;
    const provider: ImageProvider = {
      name: 'sd-cpp',
      listInstalledModels: async () => [],
      generate: async () => {
        throw new Error('not used');
      },
      async *pullModel(_id, _spec, signal): AsyncIterable<ImageModelPullEvent> {
        pullSignal = signal;
        yield { type: 'progress', bytesWritten: 1, totalBytes: 10 };
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
        yield { type: 'error', error: 'download aborted' };
        yield { type: 'done', id: 'sd-1.5' };
      },
      deleteModel: async () => {},
      health: async () => ({ status: 'ok', baseUrl: 'test://' }),
    };
    const request = await start(provider);
    expect(
      (await request('/v1/images/models/ensure', { body: { model: 'llama-cpp:gemma' } })).status,
    ).toBe(400);
    expect(
      (await request('/v1/images/models/ensure', { body: { model: 'sd-cpp:no-such-model' } }))
        .status,
    ).toBe(404);
    const ensure = await request('/v1/images/models/ensure', { body: { model: 'sd-1.5' } });
    expect(ensure.status).toBe(202);
    await vi.waitFor(() => expect(pullSignal).toBeDefined());
    const cancel = await request('/v1/images/models/ensure/sd-1.5', { method: 'DELETE' });
    expect(cancel.status).toBe(200);
    expect(pullSignal?.aborted).toBe(true);
    await vi.waitFor(async () => {
      const job = (await (await request('/v1/images/models/ensure/sd-1.5')).json()) as {
        status: string;
      };
      expect(job.status).toBe('error');
    });
  });
});
