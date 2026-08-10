import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import type { MlxModelManager } from '../providers/mlx/index.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('ChatManager.listModelsForProvider — installed local models', () => {
  it('returns an empty list without starting a local engine when no models are installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-model-list-'));
    const store = new Store({ home });
    await store.ensureLayout();
    const provider = new MockProvider({ name: 'llama-cpp' });
    const providerList = vi
      .spyOn(provider, 'listModels')
      .mockRejectedValue(new Error('llama-server should not be booted by the model picker'));
    const listInstalled = vi.fn(async () => []);
    const manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['llama-cpp', provider]],
      llamaCppModels: { listInstalled } as unknown as LlamaCppModelManager,
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    cleanups.push(async () => {
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    });

    const models = await manager.listModelsForProvider('llama-cpp');

    expect(listInstalled).toHaveBeenCalledOnce();
    expect(providerList).not.toHaveBeenCalled();
    expect(models).toEqual([]);
  });

  it('lists installed MLX models without initializing the Python-backed provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-model-list-'));
    const store = new Store({ home });
    await store.ensureLayout();
    const provider = new MockProvider({ name: 'mlx' });
    const providerList = vi
      .spyOn(provider, 'listModels')
      .mockRejectedValue(
        new Error('MLX Python environment should not be initialized by the model picker'),
      );
    const listInstalled = vi.fn(async () => [
      {
        id: 'gemma4-12b-q4',
        name: 'Gemma 4 (12B, Q4)',
        approxSizeBytes: 11 * 1024 ** 3,
        installedAt: '2026-07-16T00:00:00.000Z',
        modelDir: join(home, 'engines', 'mlx', 'models', 'gemma4-12b-q4'),
        contextWindow: 256_000,
        quantization: '4bit',
        chatTemplatePresent: true,
      },
    ]);
    const manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['mlx', provider]],
      mlxModels: { listInstalled } as unknown as MlxModelManager,
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    cleanups.push(async () => {
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    });

    const models = await manager.listModelsForProvider('mlx');

    expect(listInstalled).toHaveBeenCalledOnce();
    expect(providerList).not.toHaveBeenCalled();
    expect(models).toEqual([
      {
        id: 'gemma4-12b-q4',
        name: 'Gemma 4 (12B, Q4) · 11.0 GB · 250k ctx',
        supportsTools: true,
        contextWindow: 256_000,
      },
    ]);
  });

  it('lists installed ds4 models from disk rather than routing to the ds4 provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-model-list-'));
    const store = new Store({ home });
    await store.ensureLayout();
    const provider = new MockProvider({ name: 'ds4' });
    const providerList = vi
      .spyOn(provider, 'listModels')
      .mockRejectedValue(new Error('ds4 server should not be booted by the model picker'));
    const listInstalled = vi.fn(async () => [
      {
        id: 'deepseek-v4-flash-284b-q4',
        name: 'DeepSeek V4 Flash (FP4)',
        approxSizeBytes: 153 * 1024 ** 3,
        installedAt: '2026-07-18T00:00:00.000Z',
        modelDir: join(home, 'engines', 'ds4', 'models', 'deepseek-v4-flash-284b-q4'),
        contextWindow: 1_048_576,
        quantization: 'Q4_K',
        chatTemplatePresent: true,
      },
    ]);
    const manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['ds4', provider]],
      ds4Models: { listInstalled } as unknown as LlamaCppModelManager,
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    cleanups.push(async () => {
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    });

    const models = await manager.listModelsForProvider('ds4');

    expect(listInstalled).toHaveBeenCalledOnce();
    expect(providerList).not.toHaveBeenCalled();
    expect(models).toEqual([
      {
        id: 'deepseek-v4-flash-284b-q4',
        name: 'DeepSeek V4 Flash (FP4) · 153.0 GB · 1024k ctx',
        supportsTools: true,
        contextWindow: 1_048_576,
      },
    ]);
  });

  it('reports the configured Ollama context cap instead of the size heuristic', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-model-list-'));
    const store = new Store({ home });
    await store.ensureLayout();
    await store.writeConfig({ ollamaNumCtx: 49_152 });
    const provider = new MockProvider({ name: 'ollama' });
    const providerList = vi.spyOn(provider, 'listModels').mockResolvedValue([
      {
        id: 'qwen:14b',
        name: 'qwen:14b',
        supportsTools: true,
        contextWindow: 32_768,
      },
    ]);
    const manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['ollama', provider]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    cleanups.push(async () => {
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    });

    const controller = new AbortController();
    const models = await manager.listModelsForProvider('ollama', controller.signal);

    expect(providerList).toHaveBeenCalledWith(controller.signal);
    expect(models).toEqual([
      {
        id: 'qwen:14b',
        name: 'qwen:14b',
        supportsTools: true,
        contextWindow: 49_152,
      },
    ]);
  });
});
