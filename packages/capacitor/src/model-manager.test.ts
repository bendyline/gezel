import type {
  MobileModel,
  MobileModelDownload,
  MobileProvider,
} from '@bendyline/gezel/mobile-providers';
import { describe, expect, it, vi } from 'vitest';
import type { GezelRuntimePlugin } from './definitions.js';
import { createRuntimeEmbedding } from './embedding.js';
import { createMobileModelManager } from './model-manager.js';
import { connectRuntime } from './transport.js';

const source = {
  catalogId: 'fixture',
  catalogVersion: '1.0.0',
  sourceId: 'bundled',
  huggingfaceRepo: 'test/fixture',
  revision: 'a'.repeat(40),
  filename: 'fixture.gguf',
  sha256: 'b'.repeat(64),
};
const catalog = [
  { name: 'Fixture', license: 'MIT', approxSizeBytes: 64, contextWindow: 4096, source },
];
const jobId = '11111111-1111-4111-8111-111111111111';
const modelId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const state = {
    models: [] as MobileModel[],
    downloads: [] as MobileModelDownload[],
    availability: 'available' as MobileProvider['availability'],
  };
  const plugin: GezelRuntimePlugin = {
    providers: vi.fn<GezelRuntimePlugin['providers']>(async () => ({
      providers: [
        {
          id: 'llama-cpp',
          name: 'Local',
          locality: 'on-device',
          availability: 'available',
          contextTokens: 8192,
          maxOutputTokens: 4096,
          capabilities: {
            text: true,
            tools: true,
            structuredOutput: false,
            images: false,
            foregroundOnly: true,
          },
        },
        {
          id: 'android-mlkit',
          name: 'ML Kit',
          locality: 'on-device',
          availability: state.availability,
          contextTokens: 4096,
          maxOutputTokens: 1024,
          capabilities: {
            text: true,
            tools: false,
            structuredOutput: false,
            images: false,
            foregroundOnly: true,
          },
        },
      ],
    })),
    listModels: vi.fn(async () => ({ models: state.models })),
    listModelDownloads: vi.fn(async () => ({ downloads: state.downloads })),
    resolveModelSource: vi.fn(async () => ({ source: { ...source, sizeBytes: 64 } })),
    startModelDownload: vi.fn(async () => {
      const download: MobileModelDownload = {
        id: jobId,
        name: 'Fixture',
        source: { ...source, sizeBytes: 64 },
        state: 'downloading',
        downloadedBytes: 0,
      };
      state.downloads = [download];
      return { download };
    }),
    resumeModelDownload: vi.fn(async () => ({ download: state.downloads[0]! })),
    cancelModelDownload: vi.fn(async () => {}),
    cancelModelSourceResolution: vi.fn(async () => {}),
    prepareProvider: vi.fn(async () => {
      state.availability = 'available';
    }),
    cancelProviderPreparation: vi.fn(async () => {}),
    releaseModel: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    generate: vi.fn<GezelRuntimePlugin['generate']>(async () => ({
      text: 'Hello',
      stopReason: 'stop',
    })),
    importModel: vi.fn(async () => ({ model: null })),
    selectModel: vi.fn(async () => ({ model: state.models[0]! })),
    removeModel: vi.fn(async () => {}),
    removeModelDownload: vi.fn(async () => {}),
  };
  const complete = () => {
    state.downloads[0]!.state = 'complete';
    state.downloads[0]!.modelId = modelId;
    state.models.push({
      id: modelId,
      name: 'Fixture',
      sizeBytes: 64,
      source: { ...source, sizeBytes: 64 },
    });
  };
  return { plugin, state, complete };
}
describe('mobile model manager', () => {
  it('reports transport capabilities and effective budgets, retaining native capabilities separately', async () => {
    const { plugin, state } = fixture();
    state.models.push({ id: modelId, name: 'Fixture', sizeBytes: 64 });
    const app = connectRuntime(plugin);
    expect((await app.models()).data[0]).toMatchObject({
      context_window: 4096,
      max_output_tokens: 3967,
      default_output_tokens: 2048,
      capabilities: { tools: false },
      native_capabilities: { tools: true },
      supported_options: ['model', 'messages', 'stream', 'max_tokens'],
    });
    await app.close();
  });
  it('lists system readiness and downloadable catalog without preparation', async () => {
    const { plugin, state } = fixture();
    state.availability = 'download-required';
    const manager = createMobileModelManager(plugin, { catalog });
    expect((await manager.list()).map((model) => model.availability)).toEqual([
      'download-required',
      'download-required',
    ]);
    expect(plugin.prepareProvider).not.toHaveBeenCalled();
    expect(plugin.resolveModelSource).not.toHaveBeenCalled();
    await expect(
      manager.prepare('android-mlkit:android-mlkit', { allowDownload: true }),
    ).resolves.toMatchObject({ availability: 'available', name: 'Gemini Nano (Android ML Kit)' });
    await manager.close();
  });
  it('validates installed identity after completion and emits progress', async () => {
    const { plugin, complete } = fixture();
    const manager = createMobileModelManager(plugin, { catalog, pollIntervalMs: 10 });
    const onProgress = vi.fn((event) => {
      if (event.phase === 'downloading') complete();
    });
    await expect(
      manager.prepare('catalog:fixture', { allowDownload: true, onProgress }),
    ).resolves.toMatchObject({ id: `llama-cpp:${modelId}`, availability: 'available' });
    expect(onProgress).toHaveBeenCalled();
    await expect(manager.prepare('catalog:fixture')).resolves.toMatchObject({
      id: `llama-cpp:${modelId}`,
    });
    expect(plugin.startModelDownload).toHaveBeenCalledOnce();
    await manager.close();
  });
  it('rejects source substitutions before starting a download', async () => {
    const { plugin } = fixture();
    vi.mocked(plugin.resolveModelSource).mockResolvedValue({
      source: { ...source, sha256: 'c'.repeat(64), sizeBytes: 64 },
    });
    const manager = createMobileModelManager(plugin, { catalog });
    await expect(manager.prepare('catalog:fixture', { allowDownload: true })).rejects.toMatchObject(
      { code: 'invalid_response' },
    );
    expect(plugin.startModelDownload).not.toHaveBeenCalled();
    await manager.close();
  });
  it('cancels a queued native start whose download ID arrives after abort', async () => {
    const { plugin } = fixture();
    let finish!: () => void;
    vi.mocked(plugin.startModelDownload).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        download: {
          id: jobId,
          name: 'Fixture',
          source: { ...source, sizeBytes: 64 },
          state: 'downloading',
          downloadedBytes: 0,
        },
      };
    });
    const manager = createMobileModelManager(plugin, { catalog });
    const controller = new AbortController();
    const operation = manager.prepare('catalog:fixture', {
      allowDownload: true,
      signal: controller.signal,
    });
    const rejected = expect(operation).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(plugin.startModelDownload).toHaveBeenCalled());
    controller.abort();
    finish();
    await rejected;
    expect(plugin.cancelModelDownload).toHaveBeenCalledWith({ id: jobId });
    await manager.close();
  });
  it('does not report system readiness when native preparation returns too early', async () => {
    const { plugin, state } = fixture();
    state.availability = 'download-required';
    vi.mocked(plugin.prepareProvider).mockImplementation(async () => {});
    const manager = createMobileModelManager(plugin, { catalog });
    await expect(
      manager.prepare('android-mlkit:android-mlkit', { allowDownload: true }),
    ).rejects.toMatchObject({ code: 'model_not_ready' });
    await manager.close();
  });
  it('constructs lazily and releases native memory after opt-out', async () => {
    const { plugin } = fixture();
    const host = createRuntimeEmbedding(plugin, { catalog });
    await host.setEnabled(true);
    expect(plugin.providers).not.toHaveBeenCalled();
    await host.models.list();
    await host.setEnabled(false);
    expect(plugin.releaseModel).toHaveBeenCalledOnce();
    await host.close();
    expect(plugin.releaseModel).toHaveBeenCalledOnce();
  });
});

it('releases native model memory only after the final wrapper connection closes', async () => {
  const { plugin } = fixture();
  const first = createRuntimeEmbedding(plugin, { catalog });
  const second = createRuntimeEmbedding(plugin, { catalog });
  await first.setEnabled(true);
  await second.setEnabled(true);
  await first.models.list();
  await second.models.list();
  await first.close();
  expect(plugin.releaseModel).not.toHaveBeenCalled();
  await second.close();
  expect(plugin.releaseModel).toHaveBeenCalledOnce();
});
it('reports native cancellation failure instead of claiming disposal succeeded', async () => {
  const { plugin } = fixture();
  vi.mocked(plugin.cancelModelDownload).mockRejectedValue(new Error('native cleanup failed'));
  const manager = createMobileModelManager(plugin, { catalog, pollIntervalMs: 10 });
  const operation = manager.prepare('catalog:fixture', { allowDownload: true });
  const rejected = expect(operation).rejects.toMatchObject({ code: 'cleanup_failed' });
  await vi.waitFor(() => expect(plugin.startModelDownload).toHaveBeenCalled());
  await expect(manager.close()).rejects.toMatchObject({ code: 'cleanup_failed' });
  await rejected;
});

it('offers the first model download while native inference has no installed weights', async () => {
  const { plugin } = fixture();
  const snapshot = await plugin.providers();
  snapshot.providers[0]!.availability = 'unavailable';
  snapshot.providers[0]!.reason = 'No imported model is available.';
  vi.mocked(plugin.providers).mockResolvedValue(snapshot);
  const manager = createMobileModelManager(plugin, { catalog });
  try {
    expect(await manager.inspect('catalog:fixture')).toMatchObject({
      availability: 'download-required',
      recovery_actions: ['prepare'],
    });
    expect(plugin.startModelDownload).not.toHaveBeenCalled();
  } finally {
    await manager.close();
  }
});
