import { describe, expect, it, vi } from 'vitest';
import { type NativeInferencePlugin, createNativeInference } from './inference.js';

type GenerationResult = Awaited<ReturnType<NativeInferencePlugin['generate']>>;

describe('shared native inference adapter', () => {
  it('shares admission and waits for native release across clients of the same plugin', async () => {
    let finish!: (result: GenerationResult) => void;
    let emit!: (event: { requestId: string; delta: string }) => void;
    const remove = vi.fn(async () => {});
    const plugin: NativeInferencePlugin = {
      providers: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
      generate: vi.fn(
        () =>
          new Promise<GenerationResult>((resolve) => {
            finish = resolve;
          }),
      ),
      cancel: vi.fn(async () => {}),
      addListener: async (_event, callback) => {
        emit = callback;
        return { remove };
      },
    };
    const first = createNativeInference(plugin);
    const second = createNativeInference(plugin);
    const request = {
      requestId: 'first',
      providerId: 'llama-cpp' as const,
      modelId: 'local',
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    const delta = vi.fn();
    const running = first.generate(request, delta);
    await vi.waitFor(() => expect(plugin.generate).toHaveBeenCalledOnce());
    await expect(second.generate({ ...request, requestId: 'second' }, delta)).rejects.toThrow(
      'already running',
    );
    const cancelled = vi.fn();
    const stopping = second.cancel('first').then(cancelled);
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
    emit({ requestId: 'first', delta: 'late' });
    expect(delta).not.toHaveBeenCalled();
    await expect(first.generate({ ...request, requestId: 'third' }, delta)).rejects.toThrow(
      'already running',
    );
    finish({ text: '', stopReason: 'cancelled' });
    await Promise.all([running, stopping]);
    expect(remove).toHaveBeenCalledOnce();
    expect(plugin.cancel).toHaveBeenCalledExactlyOnceWith({ requestId: 'first' });
    vi.mocked(plugin.generate).mockResolvedValue({ text: 'Next answer', stopReason: 'stop' });
    await expect(second.generate({ ...request, requestId: 'next' }, delta)).resolves.toEqual({
      text: 'Next answer',
      stopReason: 'stop',
    });
  });
});
