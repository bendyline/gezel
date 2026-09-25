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
      addListener: (async (_event: string, callback: (event: never) => void) => {
        emit = callback as typeof emit;
        return { remove };
      }) as NativeInferencePlugin['addListener'],
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

  it('relays native tool calls to the handler and completes them with its reply or error', async () => {
    const listeners = new Map<string, (event: never) => void>();
    const completed: unknown[] = [];
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const plugin: NativeInferencePlugin = {
      providers: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
      generate: vi.fn(async (request) => {
        const call = listeners.get('toolCall')!;
        call({ requestId: 'other', callId: 'x', name: 'read_file', arguments: '{}' } as never);
        call({
          requestId: request.requestId,
          callId: 'c1',
          name: 'read_file',
          arguments: '{"path":"a.md"}',
        } as never);
        call({
          requestId: request.requestId,
          callId: 'c2',
          name: 'write_file',
          arguments: '{}',
        } as never);
        await settled;
        return { text: 'Done.', stopReason: 'stop' as const };
      }),
      cancel: vi.fn(async () => {}),
      completeToolCall: vi.fn(async (options) => {
        completed.push(options);
        if (completed.length === 2) settle();
      }),
      addListener: (async (event: string, callback: (event: never) => void) => {
        listeners.set(event, callback);
        return { remove: async () => {} };
      }) as NativeInferencePlugin['addListener'],
    };
    const onToolCall = vi.fn(async (call: { name: string }) => {
      if (call.name === 'write_file')
        throw new Error('Tool write_file is unavailable to this gezel');
      return { output: 'Tool result for read_file (reference data):\n"# A"', endTurn: false };
    });
    const tools = [
      {
        name: 'read_file',
        description: 'Read a file.',
        parameters: { kind: 'object' as const, properties: [] },
      },
    ];
    const result = await createNativeInference(plugin).generate(
      {
        requestId: 'r',
        providerId: 'apple-foundation-models',
        messages: [{ role: 'user', content: 'Go' }],
        tools,
      },
      () => {},
      onToolCall,
    );
    expect(result).toEqual({ text: 'Done.', stopReason: 'stop' });
    expect(vi.mocked(plugin.generate).mock.calls[0]![0].tools).toEqual(tools);
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(completed).toEqual([
      {
        requestId: 'r',
        callId: 'c1',
        output: 'Tool result for read_file (reference data):\n"# A"',
        endTurn: false,
      },
      { requestId: 'r', callId: 'c2', error: 'Tool write_file is unavailable to this gezel' },
    ]);
  });

  it('refuses native tools without a handler or a host that completes them', async () => {
    const plugin = {
      providers: async () => ({ providers: [] }),
      listModels: async () => ({ models: [] }),
      generate: vi.fn(),
      cancel: vi.fn(),
      addListener: vi.fn(),
    } as unknown as NativeInferencePlugin;
    const tools = [
      {
        name: 'read_file',
        description: '',
        parameters: { kind: 'object' as const, properties: [] },
      },
    ];
    await expect(
      createNativeInference(plugin).generate(
        {
          requestId: 'r',
          providerId: 'apple-foundation-models',
          messages: [{ role: 'user', content: 'Go' }],
          tools,
        },
        () => {},
        async () => ({ output: '' }),
      ),
    ).rejects.toThrow('Native tool calls need a handler');
    expect(plugin.generate).not.toHaveBeenCalled();
  });
});
