import type { MobileProvider } from '@bendyline/gezel/schemas';
import { describe, expect, it, vi } from 'vitest';
import { type GezelMobilePlugin, createNativeHost } from './native.js';

const local: MobileProvider = {
  id: 'llama-cpp',
  name: 'Imported model',
  locality: 'on-device',
  availability: 'available',
  contextTokens: 2048,
  maxOutputTokens: 256,
  capabilities: {
    text: true,
    tools: false,
    structuredOutput: false,
    images: false,
    foregroundOnly: true,
  },
};

function fixture() {
  let callback: (event: { requestId: string; delta: string }) => void = () => {};
  const remove = vi.fn(async () => {});
  const unavailable = async (): Promise<never> => {
    throw new Error('Unused test download method');
  };
  const plugin: GezelMobilePlugin = {
    resolveModelSource: unavailable,
    cancelModelSourceResolution: vi.fn(async () => {}),
    listModelDownloads: async () => ({ downloads: [] }),
    startModelDownload: unavailable,
    resumeModelDownload: unavailable,
    cancelModelDownload: async () => {},
    removeModelDownload: async () => {},
    beginExport: vi.fn(async () => ({ token: 'export' })),
    appendExport: vi.fn(async () => {}),
    saveExport: vi.fn(async () => {}),
    cancelExport: vi.fn(async () => {}),
    readProductFile: vi.fn(async () => ({ data: null })),
    writeProductFile: vi.fn(async () => {}),
    listProductFiles: vi.fn(async () => ({ entries: [] })),
    mkdirProductDirectory: vi.fn(async () => {}),
    removeProductPath: vi.fn(async () => {}),
    renameProductPath: vi.fn(async () => {}),
    readState: vi.fn(async () => ({ data: null })),
    writeState: vi.fn(async () => {}),
    listModels: vi.fn(async () => ({ models: [] })),
    importModel: vi.fn(async () => ({ model: null })),
    selectModel: vi.fn(async () => ({ model: { id: 'one', name: 'model', sizeBytes: 16 } })),
    removeModel: vi.fn(async () => {}),
    providers: vi.fn(async () => ({ providers: [local] })),
    prepareProvider: vi.fn(async () => {}),
    cancelProviderPreparation: vi.fn(async () => {}),
    generate: vi.fn(async () => ({ text: 'Final answer', stopReason: 'stop' as const })),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(async (_name, listener) => {
      callback = listener;
      return { remove };
    }),
  };
  return { plugin, remove, emit: (event: { requestId: string; delta: string }) => callback(event) };
}
const request = {
  requestId: 'one',
  providerId: 'llama-cpp' as const,
  modelId: 'pinned-model',
  messages: [{ role: 'user' as const, content: 'Hello' }],
};

describe('native inference adapter', () => {
  it('subscribes before generation, isolates request IDs, and removes its listener', async () => {
    const f = fixture();
    const onDelta = vi.fn();
    vi.mocked(f.plugin.generate).mockImplementation(async () => {
      f.emit({ requestId: 'old', delta: 'wrong' });
      f.emit({ requestId: 'one', delta: 'Final' });
      return { text: 'Final answer', stopReason: 'stop' };
    });
    expect(await createNativeHost(f.plugin).inference.generate(request, onDelta)).toEqual({
      text: 'Final answer',
      stopReason: 'stop',
    });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith({ requestId: 'one', delta: 'Final' });
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it('cancels before asynchronous listener setup without starting native inference', async () => {
    const f = fixture();
    let ready!: (value: { remove: typeof f.remove }) => void;
    vi.mocked(f.plugin.addListener).mockImplementation(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const host = createNativeHost(f.plugin);
    const running = host.inference.generate(request, vi.fn());
    const stopped = host.inference.cancel('one');
    ready({ remove: f.remove });
    await stopped;
    expect(await running).toEqual({ text: '', stopReason: 'cancelled' });
    expect(f.plugin.generate).not.toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalledOnce();
    vi.mocked(f.plugin.addListener).mockResolvedValue({ remove: f.remove });
    await expect(
      host.inference.generate({ ...request, requestId: 'two' }, vi.fn()),
    ).resolves.toMatchObject({ stopReason: 'stop' });
  });

  it('cleans up failures and allows a later request', async () => {
    const f = fixture();
    vi.mocked(f.plugin.generate).mockRejectedValueOnce(new Error('Model unavailable'));
    const host = createNativeHost(f.plugin);
    await expect(host.inference.generate(request, vi.fn())).rejects.toThrow('Model unavailable');
    expect(f.remove).toHaveBeenCalledOnce();
    await expect(
      host.inference.generate({ ...request, requestId: 'two' }, vi.fn()),
    ).resolves.toMatchObject({ stopReason: 'stop' });
    await host.inference.cancel('one');
    expect(f.plugin.cancel).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)(
    'preserves the model outcome after listener teardown fails: %s',
    async (outcome) => {
      const f = fixture();
      f.remove.mockRejectedValueOnce(new Error('Listener cleanup failed'));
      if (outcome === 'failure')
        vi.mocked(f.plugin.generate).mockRejectedValueOnce(new Error('Model unavailable'));
      const host = createNativeHost(f.plugin);
      const onDelta = vi.fn();
      const response = host.inference.generate(request, onDelta);
      if (outcome === 'failure') await expect(response).rejects.toThrow('Model unavailable');
      else await expect(response).resolves.toEqual({ text: 'Final answer', stopReason: 'stop' });
      f.emit({ requestId: 'one', delta: 'stale' });
      expect(onDelta).not.toHaveBeenCalled();
      await expect(
        host.inference.generate({ ...request, requestId: 'two' }, vi.fn()),
      ).resolves.toMatchObject({ stopReason: 'stop' });
    },
  );

  it('passes the chosen provider without retrying a different engine', async () => {
    const f = fixture();
    vi.mocked(f.plugin.generate).mockRejectedValueOnce(
      new Error('Apple Intelligence is unavailable'),
    );
    const host = createNativeHost(f.plugin);
    await expect(
      host.inference.generate(
        { ...request, providerId: 'apple-foundation-models', modelId: 'apple-foundation-models' },
        vi.fn(),
      ),
    ).rejects.toThrow('Apple Intelligence');
    expect(f.plugin.generate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerId: 'apple-foundation-models' }),
    );
  });

  it('does not release native ownership when cancellation fails', async () => {
    const f = fixture();
    let finish!: (result: { text: string; stopReason: 'cancelled' }) => void;
    vi.mocked(f.plugin.generate).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(f.plugin.cancel).mockRejectedValueOnce(new Error('Still running'));
    const host = createNativeHost(f.plugin);
    const delta = vi.fn();
    const running = host.inference.generate(request, delta);
    await vi.waitFor(() => expect(f.plugin.generate).toHaveBeenCalledOnce());
    await expect(host.inference.cancel('one')).rejects.toThrow('Still running');
    await expect(host.inference.generate({ ...request, requestId: 'two' }, delta)).rejects.toThrow(
      'already running',
    );
    f.emit({ requestId: 'one', delta: 'late' });
    expect(delta).not.toHaveBeenCalled();
    finish({ text: '', stopReason: 'cancelled' });
    await running;
    vi.mocked(f.plugin.generate).mockResolvedValue({ text: 'Next answer', stopReason: 'stop' });
    await expect(
      host.inference.generate({ ...request, requestId: 'two' }, delta),
    ).resolves.toMatchObject({ text: 'Next answer' });
  });

  it('rejects malformed provider and model inventories at the native boundary', async () => {
    const f = fixture();
    const host = createNativeHost(f.plugin);
    vi.mocked(f.plugin.providers).mockResolvedValue({ providers: [local, local] });
    await expect(host.inference.providers()).rejects.toThrow('Duplicate mobile provider');
    vi.mocked(f.plugin.providers).mockResolvedValue({
      providers: [{ ...local, locality: 'cloud' } as unknown as MobileProvider],
    });
    await expect(host.inference.providers()).rejects.toThrow();
    vi.mocked(f.plugin.listModels).mockResolvedValue({ models: [], selectedModelId: 'missing' });
    await expect(host.listModels()).rejects.toThrow('selected mobile model is missing');
  });

  it('downloads only after an explicit prepare call and forwards only the requested provider', async () => {
    const f = fixture();
    const host = createNativeHost(f.plugin);
    await host.inference.providers();
    expect(f.plugin.prepareProvider).not.toHaveBeenCalled();
    await host.prepareProvider('android-mlkit');
    expect(f.plugin.prepareProvider).toHaveBeenCalledExactlyOnceWith({
      providerId: 'android-mlkit',
    });
    await host.cancelProviderPreparation('android-mlkit');
    expect(f.plugin.cancelProviderPreparation).toHaveBeenCalledExactlyOnceWith({
      providerId: 'android-mlkit',
    });
  });
});

describe('native model identity and budgets', () => {
  it.each(['apple-foundation-models', 'android-mlkit'] as const)(
    'rejects a mismatched pinned model before invoking %s',
    async (providerId) => {
      const f = fixture();
      const host = createNativeHost(f.plugin);
      for (const modelId of ['pinned-model', '']) {
        await expect(
          host.inference.generate({ ...request, providerId, modelId }, vi.fn()),
        ).rejects.toThrow('requested model is not available');
      }
      expect(f.plugin.generate).not.toHaveBeenCalled();
      expect(f.remove).toHaveBeenCalledTimes(2);
      for (const modelId of [providerId, undefined]) {
        await expect(
          host.inference.generate({ ...request, providerId, modelId }, vi.fn()),
        ).resolves.toMatchObject({ stopReason: 'stop' });
      }
      expect(f.plugin.generate).toHaveBeenCalledTimes(2);
    },
  );
  it('passes the pinned model and explicit budgets instead of global defaults', async () => {
    const f = fixture();
    await createNativeHost(f.plugin).inference.generate(
      { ...request, contextSize: 8192, maxTokens: 2048 },
      vi.fn(),
    );
    expect(f.plugin.generate).toHaveBeenCalledExactlyOnceWith({
      ...request,
      contextSize: 8192,
      maxTokens: 2048,
    });
    expect(f.plugin.selectModel).not.toHaveBeenCalled();
  });
  it('does not start inference with a missing model identity or invalid budget', async () => {
    const f = fixture();
    const host = createNativeHost(f.plugin);
    await expect(
      host.inference.generate({ ...request, modelId: undefined }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      host.inference.generate({ ...request, contextSize: 2048, maxTokens: 2048 }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      host.inference.generate({ ...request, contextSize: 16384 }, vi.fn()),
    ).rejects.toThrow();
    expect(f.plugin.generate).not.toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalledTimes(3);
  });
});

describe('verified native model acquisition', () => {
  it('preserves source identity across inspection, acquisition and inventory without selecting it', async () => {
    const { plugin } = fixture();
    const source = {
      catalogId: 'model',
      catalogVersion: '1.0.0',
      sourceId: 'q4',
      huggingfaceRepo: 'owner/repository',
      revision: 'a'.repeat(40),
      filename: 'model.gguf',
      sha256: 'b'.repeat(64),
      sizeBytes: 1024,
    };
    const { sizeBytes: _size, ...identity } = source;
    const download = {
      id: '9f322034-741e-4d71-9f7f-960b505dcbdf',
      name: 'Model',
      source,
      state: 'paused' as const,
      downloadedBytes: 512,
    };
    plugin.resolveModelSource = vi.fn(async () => ({ source }));
    plugin.startModelDownload = vi.fn(async () => ({ download }));
    plugin.resumeModelDownload = vi.fn(async () => ({ download }));
    plugin.listModelDownloads = vi.fn(async () => ({ downloads: [download] }));
    plugin.removeModelDownload = vi.fn(async () => {});
    const host = createNativeHost(plugin);
    expect(await host.resolveModelSource(identity)).toEqual(source);
    expect(await host.startModelDownload(source, 'Model')).toEqual(download);
    expect(await host.listModelDownloads()).toEqual([download]);
    await host.resumeModelDownload(download.id);
    await host.removeModelDownload(download.id);
    await host.cancelModelSourceResolution();
    expect(plugin.resolveModelSource).toHaveBeenCalledExactlyOnceWith({ source: identity });
    expect(plugin.startModelDownload).toHaveBeenCalledExactlyOnceWith({ source, name: 'Model' });
    expect(plugin.selectModel).not.toHaveBeenCalled();
    expect(plugin.removeModel).not.toHaveBeenCalled();
    expect(plugin.cancelModelSourceResolution).toHaveBeenCalledOnce();
  });
  it('rejects unverified inputs and invalid native progress at the boundary', async () => {
    const { plugin } = fixture();
    const host = createNativeHost(plugin);
    plugin.startModelDownload = vi.fn();
    await expect(host.startModelDownload({} as never, 'Model')).rejects.toThrow();
    expect(plugin.startModelDownload).not.toHaveBeenCalled();
    plugin.listModelDownloads = async () => ({ downloads: [{ id: 'unsafe' } as never] });
    await expect(host.listModelDownloads()).rejects.toThrow();
  });
});

describe('native preview publication', () => {
  it('keeps the capability unavailable when the native boundary is absent', async () => {
    const { plugin } = fixture();
    const host = createNativeHost(plugin);
    expect(await host.previewAvailability?.()).toBe(false);
    await expect(host.publishHtmlPreview?.('<p>Page</p>')).rejects.toThrow('unavailable');
  });
  it('returns only a reserved snapshot address and disposes its native cache entry', async () => {
    const { plugin } = fixture();
    const id = '22222222-2222-4222-8222-222222222222';
    const url = `capacitor://localhost/__gezel_preview/${id}/index.html`;
    plugin.previewAvailability = async () => ({ available: true });
    plugin.publishHtmlPreview = vi.fn(async () => ({ id, url }));
    plugin.removeHtmlPreview = vi.fn(async () => {});
    const host = createNativeHost(plugin);
    expect(await host.previewAvailability?.()).toBe(true);
    const snapshot = await host.publishHtmlPreview!('<p>Page</p>');
    expect(snapshot.url).toBe(url);
    snapshot.dispose();
    expect(plugin.removeHtmlPreview).toHaveBeenCalledExactlyOnceWith({ id });
    expect(plugin.publishHtmlPreview).toHaveBeenCalledExactlyOnceWith({ html: '<p>Page</p>' });
  });
  it('rejects a native response pointing outside the reserved document route', async () => {
    const { plugin } = fixture();
    plugin.publishHtmlPreview = async () => ({
      id: '22222222-2222-4222-8222-222222222222',
      url: 'https://outside.invalid/index.html',
    });
    plugin.removeHtmlPreview = async () => {};
    await expect(createNativeHost(plugin).publishHtmlPreview!('Page')).rejects.toThrow(
      'invalid address',
    );
  });
});
