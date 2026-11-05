import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppEnsureEventSchema,
  AppImageGenerationEventSchema,
  AppImageModelListSchema,
  AppImageStyleListSchema,
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

  it('leaves out models that only change a picture, and refuses them by name', async () => {
    const provider = new MockImageProvider({
      preinstalled: [
        // Listed without the flag, as an engine older than it would: the
        // catalog and the assessment map still know it only edits.
        {
          id: 'qwen-image-edit-2511-q4',
          name: 'Qwen Image Edit',
          approxSizeBytes: 1,
          installedAt: '2026-11-01T00:00:00Z',
        },
        // Not in the catalog, so only its own listing says so.
        {
          id: 'private-edit-model',
          name: 'Private edit model',
          approxSizeBytes: 1,
          installedAt: '2026-11-01T00:00:00Z',
          editOnly: true,
        },
        { id: 'sd-1.5', name: 'SD 1.5', approxSizeBytes: 1, installedAt: '2026-11-01T00:00:00Z' },
      ],
    });
    const generated = vi.spyOn(provider, 'generate');
    const request = await start(provider);

    const ids = AppImageModelListSchema.parse(
      await (await request('/v1/images/models')).json(),
    ).data.map((m) => m.id);
    expect(ids).toContain('sd-cpp:sd-1.5');
    expect(ids).not.toContain('sd-cpp:qwen-image-edit-2511-q4');
    expect(ids).not.toContain('sd-cpp:private-edit-model');

    const render = await request('/v1/images/generations', {
      body: { prompt: 'a lighthouse', model: 'sd-cpp:qwen-image-edit-2511-q4' },
    });
    expect(render.status).toBe(409);
    expect(await render.json()).toMatchObject({
      error: {
        code: 'edit_only_model',
        message: expect.stringContaining('Qwen Image Edit only changes a picture'),
      },
    });
    expect(generated).not.toHaveBeenCalled();

    // Not installed: the catalog's declaration keeps an app from fetching
    // gigabytes no generation here can use.
    await provider.deleteModel('qwen-image-edit-2511-q4');
    const ensure = await request('/v1/images/models/ensure', {
      body: { model: 'sd-cpp:qwen-image-edit-2511-q4' },
    });
    expect(ensure.status).toBe(409);
    expect(await ensure.json()).toMatchObject({ error: { code: 'edit_only_model' } });
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

  it('downloads a compatible style and applies it to the render', async () => {
    const provider = new MockImageProvider();
    const generated = vi.spyOn(provider, 'generate');
    const request = await start(provider);
    const styles = AppImageStyleListSchema.parse(
      await (await request('/v1/images/styles')).json(),
    ).data;
    expect(styles.length).toBeGreaterThan(0);
    const style = styles[0]!;
    expect(style.license_url).toMatch(/^https:\/\//);
    expect(style.base_models[0]).toMatch(/^sd-cpp:/);
    expect(
      await (await request('/v1/images/styles/ensure', { body: { style: style.id } })).json(),
    ).toMatchObject({ error: { code: 'style_model_required' } });
    const model = style.base_models[0]!.replace('sd-cpp:', '');
    for await (const _event of provider.pullModel(model, {
      name: model,
      downloadUrl: 'https://example.test/weights',
      sha256: 'a'.repeat(64),
      approxSizeBytes: 10,
      weightsKind: 'checkpoint',
      auxiliaryFiles: [],
    })) {
      /* synthetic weights only */
    }
    const download = (await (
      await request('/v1/images/styles/ensure', { body: { style: style.id } })
    ).json()) as { status: string; job_id: string };
    expect(download.status).toBe('downloading');
    if (download.status !== 'downloading') throw new Error('Expected a new style download');
    const events = await sseEvents(
      await request(`/v1/images/styles/ensure/${download.job_id}/events`),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', modelId: style.id });
    expect(
      await (await request('/v1/images/styles/ensure', { body: { style: style.id } })).json(),
    ).toMatchObject({ status: 'ready' });
    expect(
      AppImageStyleListSchema.parse(await (await request('/v1/images/styles')).json()).data.find(
        (s) => s.id === style.id,
      )?.availability,
    ).toBe('available');
    const rendered = await request('/v1/images/generations', {
      body: {
        prompt: 'a lighthouse',
        model: style.base_models[0],
        style: style.id,
        quality: 'draft',
      },
    });
    expect((await sseEvents(rendered)).at(-1)).toMatchObject({ type: 'done' });
    expect(generated.mock.calls.at(-1)?.[0].loras).toEqual([{ id: style.id }]);
    expect((await request(`/v1/images/styles/${style.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await provider.listLoras()).length).toBe(0);
    expect(
      await (
        await request('/v1/images/generations', {
          body: { prompt: 'a lighthouse', model: style.base_models[0], style: style.id },
        })
      ).json(),
    ).toMatchObject({ error: { code: 'style_not_available' } });
    expect(generated).toHaveBeenCalledTimes(1);
    expect(
      (await request('/v1/images/styles/ensure', { body: { style: '../outside' } })).status,
    ).toBe(400);
    expect(
      (
        await request('/v1/images/styles/ensure', {
          body: { style: style.id, downloadUrl: 'https://example.test/untrusted' },
        })
      ).status,
    ).toBe(400);
    expect((await request('/v1/images/styles/missing', { method: 'DELETE' })).status).toBe(404);
  });

  it('cancels a style download and keeps it separate from model downloads', async () => {
    const provider = new MockImageProvider();
    let signal: AbortSignal | undefined;
    (provider as ImageProvider).pullLora = async function* (_id, _spec, abort) {
      signal = abort;
      yield { type: 'progress', bytesWritten: 1, totalBytes: 10 };
      await new Promise<void>((resolve) => abort?.addEventListener('abort', () => resolve()));
      yield { type: 'error', error: 'cancelled' };
    };
    const request = await start(provider);
    const styles = AppImageStyleListSchema.parse(await (await request('/v1/images/styles')).json());
    const style = styles.data[0]!;
    for await (const _event of provider.pullModel(style.base_models[0]!.replace('sd-cpp:', ''), {
      name: 'Base',
      downloadUrl: 'https://example.test/weights',
      sha256: 'a'.repeat(64),
      approxSizeBytes: 10,
      weightsKind: 'checkpoint',
      auxiliaryFiles: [],
    })) {
      /* synthetic weights only */
    }
    expect((await request('/v1/images/styles/ensure', { body: { style: style.id } })).status).toBe(
      202,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect((await request(`/v1/images/styles/${style.id}`, { method: 'DELETE' })).status).toBe(409);
    expect(
      (await request(`/v1/images/models/ensure/${style.id}`, { method: 'DELETE' })).status,
    ).toBe(404);
    expect(
      (await request(`/v1/images/styles/ensure/${style.id}`, { method: 'DELETE' })).status,
    ).toBe(200);
    expect(signal?.aborted).toBe(true);
    const events = await sseEvents(await request(`/v1/images/styles/ensure/${style.id}/events`));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
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
