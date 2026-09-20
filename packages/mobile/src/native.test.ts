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
  const plugin: GezelMobilePlugin = {
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
      host.inference.generate({ ...request, providerId: 'apple-foundation-models' }, vi.fn()),
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
