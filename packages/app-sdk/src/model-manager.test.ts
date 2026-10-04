import { describe, expect, it, vi } from 'vitest';
import { GezelApp } from './client.js';
import {
  createHttpModelManager,
  createModelManager,
  describeModel,
  selectModel,
} from './model-manager.js';
import type { ModelListEntry } from './types.js';
const model: ModelListEntry = {
  id: 'llama-cpp:fixture',
  object: 'model',
  created: 0,
  owned_by: 'llama-cpp',
};

describe('embedding model management', () => {
  it('keeps inspection read-only and requires explicit download permission', async () => {
    const prepare = vi.fn(async () => model.id);
    const manager = createModelManager({
      cancellation: 'download',
      list: async () => [{ ...model, availability: 'download-required' }],
      prepare,
    });
    await manager.list();
    await manager.inspect(model.id);
    await expect(manager.prepare(model.id)).rejects.toMatchObject({
      code: 'model_download_required',
    });
    expect(prepare).not.toHaveBeenCalled();
    await manager.close();
  });
  it('rechecks readiness and tolerates throwing progress observers', async () => {
    let ready = false;
    const manager = createModelManager({
      cancellation: 'download',
      list: async () => [{ ...model, availability: ready ? 'available' : 'download-required' }],
      prepare: async (_id, options) => {
        options.onProgress?.({ phase: 'preparing', message: 'working' });
        ready = true;
        return model.id;
      },
    });
    await expect(
      manager.prepare(model.id, {
        allowDownload: true,
        onProgress() {
          throw new Error('observer');
        },
      }),
    ).resolves.toMatchObject({ availability: 'available' });
    await manager.close();
  });
  it('does not accept a lying preparation result', async () => {
    const manager = createModelManager({
      cancellation: 'download',
      list: async () => [],
      prepare: async () => model.id,
    });
    await expect(manager.prepare(model.id, { allowDownload: true })).rejects.toMatchObject({
      code: 'model_not_ready',
    });
    await manager.close();
  });
  it('requires explicit fallback when a stored selection disappears', () => {
    const models = [describeModel(model)];
    expect(selectModel(models, { preferredId: 'deleted' })).toBeNull();
    expect(selectModel(models, { preferredId: 'deleted', fallback: 'first-ready' })?.id).toBe(
      model.id,
    );
    expect(models[0]?.locality).toBe('unknown');
  });
  it('provides a watch readiness barrier and awaited disposal', async () => {
    const list = vi.fn(async () => [model]);
    const manager = createModelManager({
      cancellation: 'download',
      list,
      prepare: async () => model.id,
    });
    const listener = vi.fn();
    const watch = manager.watch(listener, { intervalMs: 100 });
    await watch.ready;
    await watch.dispose();
    expect(listener).toHaveBeenCalledOnce();
    await manager.close();
    await expect(manager.list()).rejects.toMatchObject({ code: 'closed' });
  });
  it.each([
    '',
    'data: {bad}\n\n',
    'data: {"type":"done","jobId":"other","modelId":"llama-cpp:fixture"}\n\n',
  ])('rejects malformed/truncated or cross-job ensure streams: %s', async (data) => {
    const app = new GezelApp({
      baseUrl: 'http://fixture',
      token: 'fixture',
      fetch: async () => new Response(data),
    });
    await expect(
      (async () => {
        for await (const _ of app.streamEnsureEvents('job')) {
        }
      })(),
    ).rejects.toMatchObject({ code: data ? 'invalid_response' : 'incomplete_stream' });
  });
  it('validates HTTP model and preparation boundaries', async () => {
    const app = new GezelApp({
      baseUrl: 'http://fixture',
      token: 'fixture',
      fetch: async () => Response.json({ status: 'downloading', model_id: model.id }),
    });
    await expect(app.ensureModel({ model: model.id })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(app.models()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('never interprets an HTTP stream EOF as preparation success', async () => {
    const manager = createHttpModelManager({
      models: async () => ({ object: 'list', data: [] }),
      ensureModel: async () => ({ status: 'downloading', model_id: model.id, job_id: 'job' }),
      streamEnsureEvents: async function* () {},
    });
    await expect(manager.prepare(model.id, { allowDownload: true })).rejects.toMatchObject({
      code: 'incomplete_stream',
    });
    expect(manager.cancellation).toBe('observation');
    await manager.close();
  });
});
