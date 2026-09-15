import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import type { GezelApp } from './client.js';
import { ensureModel, resolveEngine } from './ensure-model.js';
import type { EnsureProgressEvent } from './host-types.js';

describe('resolveEngine', () => {
  it('respects an explicit engine', () => {
    expect(resolveEngine('ds4', 'darwin', 'arm64')).toBe('ds4');
  });

  it('defaults to MLX only on Apple Silicon', () => {
    expect(resolveEngine('auto', 'darwin', 'arm64')).toBe('mlx');
    expect(resolveEngine(undefined, 'darwin', 'x64')).toBe('llama-cpp');
    expect(resolveEngine(undefined, 'linux', 'arm64')).toBe('llama-cpp');
  });
});

describe('ensureModel', () => {
  it('reuses an installed model without changing a user-owned daemon', async () => {
    const updateConfig = vi.fn();
    const client = {
      getNativeEngineStatus: vi.fn().mockRejectedValue(new Error('old daemon')),
      listLlamaCppModels: vi.fn().mockResolvedValue({ models: [{ id: 'ready-model' }] }),
      updateConfig,
    } as unknown as GezelClient;
    const app = { ensureModel: vi.fn() } as unknown as GezelApp;
    const events: EnsureProgressEvent[] = [];

    await expect(
      ensureModel(
        { client, app, owned: false, platform: 'linux', arch: 'x64' },
        { model: 'ready-model', onEvent: (event) => events.push(event) },
      ),
    ).resolves.toEqual({
      model: 'ready-model',
      engine: 'llama-cpp',
      source: 'present',
      pinned: false,
    });
    expect(app.ensureModel).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        phase: 'ready',
        model: 'ready-model',
        engine: 'llama-cpp',
        source: 'present',
      },
    ]);
  });

  it('downloads missing engine and model bytes, then pins a hosted default', async () => {
    const ensureNativeEngine = vi.fn(async (_name, onEvent) => {
      onEvent({ type: 'progress', bytesWritten: 40, totalBytes: 100 });
    });
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    const client = {
      getNativeEngineStatus: vi.fn().mockResolvedValue({
        pinned: true,
        llamaBackend: 'cuda',
        engines: [],
      }),
      ensureNativeEngine,
      listLlamaCppModels: vi.fn().mockResolvedValue({ models: [] }),
      getConfig: vi.fn().mockResolvedValue({ defaultModel: { mlx: 'existing-mlx' } }),
      updateConfig,
    } as unknown as GezelClient;
    const app = {
      ensureModel: vi.fn().mockResolvedValue({
        status: 'downloading',
        model_id: 'llama-cpp:new-model',
        job_id: 'job-1',
      }),
      streamEnsureEvents: vi.fn(async function* () {
        yield {
          type: 'progress',
          jobId: 'job-1',
          modelId: 'llama-cpp:new-model',
          bytesWritten: 25,
          totalBytes: 200,
        };
        yield { type: 'done', jobId: 'job-1', modelId: 'llama-cpp:new-model' };
      }),
    } as unknown as GezelApp;
    const events: EnsureProgressEvent[] = [];

    await expect(
      ensureModel(
        { client, app, owned: true, platform: 'linux', arch: 'x64' },
        { model: 'new-model', onEvent: (event) => events.push(event) },
      ),
    ).resolves.toEqual({
      model: 'new-model',
      engine: 'llama-cpp',
      source: 'download',
      pinned: true,
    });
    expect(ensureNativeEngine).toHaveBeenCalledWith('llama-server', expect.any(Function), 'cuda');
    expect(app.ensureModel).toHaveBeenCalledWith({ model: 'llama-cpp:new-model' });
    expect(updateConfig).toHaveBeenCalledWith({
      provider: 'llama-cpp',
      defaultModel: { mlx: 'existing-mlx', 'llama-cpp': 'new-model' },
      firstRunCompleted: true,
    });
    expect(events).toContainEqual({
      phase: 'engine',
      engine: 'llama-server',
      message: 'downloading the llama-server engine',
      percent: 40,
    });
    expect(events).toContainEqual({
      phase: 'weights',
      message: 'downloading new-model',
      bytesWritten: 25,
      totalBytes: 200,
    });
    expect(events.at(-1)).toEqual({
      phase: 'ready',
      model: 'new-model',
      engine: 'llama-cpp',
      source: 'download',
    });
  });
});
