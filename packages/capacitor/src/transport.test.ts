import { describe, expect, it, vi } from 'vitest';
import type { GezelRuntimePlugin } from './definitions.js';
import { createRuntimeEmbedding } from './embedding.js';
import { connectRuntime } from './transport.js';

function fixture() {
  let emit = (_event: { requestId: string; delta: string }) => {};
  const unsupported = vi.fn(async (): Promise<never> => {
    throw new Error('Unexpected management call');
  });
  const plugin: GezelRuntimePlugin = {
    providers: vi.fn<GezelRuntimePlugin['providers']>(async () => ({
      providers: [
        {
          id: 'llama-cpp',
          name: 'Local model',
          locality: 'on-device',
          availability: 'available',
          contextTokens: 2048,
          maxOutputTokens: 512,
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
    listModels: vi.fn(async () => ({ models: [{ id: 'local', name: 'Fixture', sizeBytes: 4 }] })),
    generate: vi.fn<GezelRuntimePlugin['generate']>(async (request) => {
      emit({ requestId: 'stale', delta: 'wrong' });
      emit({ requestId: request.requestId, delta: 'Hello' });
      return { text: 'Hello!', stopReason: 'length' };
    }),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(async (_event, listener) => {
      emit = listener;
      return { remove: vi.fn(async () => {}) };
    }),
    releaseModel: vi.fn(async () => {}),
    prepareProvider: unsupported,
    cancelProviderPreparation: unsupported,
    importModel: unsupported,
    selectModel: unsupported,
    removeModel: unsupported,
    resolveModelSource: unsupported,
    cancelModelSourceResolution: unsupported,
    listModelDownloads: unsupported,
    startModelDownload: unsupported,
    resumeModelDownload: unsupported,
    cancelModelDownload: unsupported,
    removeModelDownload: unsupported,
  };
  return { plugin, emit: (requestId: string, delta: string) => emit({ requestId, delta }) };
}
const request = {
  model: 'llama-cpp:local',
  messages: [{ role: 'user' as const, content: 'Hello' }],
};

describe('GezelApp native transport', () => {
  it('uses ordinary models/ensure/chat while preserving capabilities, unknown usage and length stops', async () => {
    const { plugin } = fixture();
    const app = connectRuntime(plugin);
    const models = await app.models();
    expect(models.data[0]).toMatchObject({
      id: request.model,
      locality: 'on-device',
      capabilities: { tools: false },
      availability: 'available',
    });
    await expect(app.ensureModel({ model: request.model })).resolves.toEqual({
      status: 'ready',
      model_id: request.model,
    });
    const reply = await app.chat(request);
    expect(reply.choices[0]).toMatchObject({
      message: { content: 'Hello!' },
      finish_reason: 'length',
    });
    expect(reply).not.toHaveProperty('usage');
    expect(plugin.prepareProvider).not.toHaveBeenCalled();
    expect(plugin.startModelDownload).not.toHaveBeenCalled();
    await app.close();
    await expect(app.models()).rejects.toMatchObject({ code: 'closed' });
  });

  for (const providerId of ['apple-foundation-models', 'android-mlkit'] as const) {
    it.each(['available', 'unavailable', 'download-required', 'downloading'] as const)(
      `${providerId} remains discoverable when %s and only generates when ready`,
      async (availability) => {
        const { plugin } = fixture();
        const { providers } = await plugin.providers();
        const system = {
          ...providers[0]!,
          id: providerId,
          name: 'System model',
          availability,
          ...(availability === 'available' ? {} : { reason: 'System model is not ready.' }),
        };
        vi.mocked(plugin.providers).mockResolvedValue({ providers: [...providers, system] });
        const app = connectRuntime(plugin);
        try {
          const model = `${providerId}:${providerId}`;
          const listing = await app.models();
          expect(listing.data).toHaveLength(2);
          expect(listing.data.find((entry) => entry.id === model)).toMatchObject({
            owned_by: providerId,
            availability,
            locality: 'on-device',
            context_window: 2048,
          });
          if (availability === 'available') {
            await expect(app.ensureModel({ model })).resolves.toEqual({
              status: 'ready',
              model_id: model,
            });
            await app.chat({ ...request, model });
            expect(plugin.generate).toHaveBeenCalledWith(
              expect.objectContaining({ providerId, modelId: providerId }),
            );
          } else {
            expect(listing.data.find((entry) => entry.id === model)?.unavailable_reason).toBe(
              system.reason,
            );
            await expect(app.ensureModel({ model })).rejects.toMatchObject({ code: availability });
            await expect(app.chat({ ...request, model })).rejects.toMatchObject({
              code: availability,
            });
            expect(plugin.generate).not.toHaveBeenCalled();
          }
          expect(plugin.prepareProvider).not.toHaveBeenCalled();
          expect(plugin.importModel).not.toHaveBeenCalled();
          expect(plugin.startModelDownload).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      },
    );
  }

  it.each([undefined, 8192, 16384])(
    'uses the advertised reply ceiling and fitted context %s for generation',
    async (contextTokens) => {
      const { plugin } = fixture();
      const { providers } = await plugin.providers();
      vi.mocked(plugin.providers).mockResolvedValue({
        providers: [{ ...providers[0]!, contextTokens: 16384, maxOutputTokens: 4096 }],
      });
      vi.mocked(plugin.listModels).mockResolvedValue({
        models: [
          {
            id: 'local',
            name: 'Fixture',
            sizeBytes: 4,
            ...(contextTokens ? { contextTokens } : {}),
          },
        ],
      });
      const app = connectRuntime(plugin);
      try {
        const model = (await app.models()).data[0]!;
        expect(model.context_window).toBe(contextTokens ?? 4096);
        expect(model.max_output_tokens).toBe(contextTokens ? 4096 : 3967);
        await app.chat({ ...request, max_tokens: model.max_output_tokens });
        expect(plugin.generate).toHaveBeenCalledWith(
          expect.objectContaining({
            contextSize: model.context_window,
            maxTokens: model.max_output_tokens,
          }),
        );
        await expect(
          app.chat({ ...request, max_tokens: model.max_output_tokens! + 1 }),
        ).rejects.toMatchObject({ code: 'invalid_request' });
        expect(plugin.generate).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );

  it('streams only the current request and reconciles the final suffix without fabricating usage', async () => {
    const { plugin } = fixture();
    const app = connectRuntime(plugin);
    const chunks = [];
    for await (const chunk of await app.chat({ ...request, stream: true })) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('')).toBe('Hello!');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('length');
    expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true);
    await app.close();
  });

  it.each([
    { tools: [] },
    { temperature: 0.5 },
    { response_format: { type: 'json_object' } },
    {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] },
      ],
    },
  ])('rejects unsupported options before invoking a native provider: %j', async (extra) => {
    const { plugin } = fixture();
    const app = connectRuntime(plugin);
    await expect(app.chat({ ...request, ...extra } as typeof request)).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(plugin.generate).not.toHaveBeenCalled();
  });

  it('requires an explicit installed identity and never falls back', async () => {
    const { plugin } = fixture();
    const app = connectRuntime(plugin);
    await expect(app.chat({ ...request, model: 'llama-cpp:missing' })).rejects.toMatchObject({
      code: 'model_unavailable',
    });
    await expect(app.chat({ ...request, model: 'llama-cpp' })).rejects.toMatchObject({
      code: 'model_required',
    });
    await expect(app.chat({ ...request, model: 'apple-foundation-models' })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(plugin.generate).not.toHaveBeenCalled();
  });

  it.each(['break', 'abort', 'close'] as const)(
    'cancels native work and waits for release on %s',
    async (mode) => {
      const f = fixture();
      let complete!: (result: { text: string; stopReason: 'cancelled' }) => void;
      vi.mocked(f.plugin.generate).mockImplementation((input) => {
        f.emit(input.requestId, 'First');
        return new Promise((resolve) => {
          complete = resolve;
        });
      });
      vi.mocked(f.plugin.cancel).mockImplementation(async () => {
        complete({ text: 'First', stopReason: 'cancelled' });
      });
      const app = connectRuntime(f.plugin);
      const controller = new AbortController();
      const stream = await app.chat({ ...request, stream: true }, { signal: controller.signal });
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.choices[0]?.delta.content).toBe('First');
      if (mode === 'break') await iterator.return?.();
      if (mode === 'abort') {
        controller.abort();
        await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
      }
      if (mode === 'close') {
        await app.close();
        await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
      }
      await app.close();
      expect(f.plugin.cancel).toHaveBeenCalledOnce();
      expect(f.plugin.releaseModel).not.toHaveBeenCalled();
    },
  );

  it('does not cancel another client when an idle client closes', async () => {
    const f = fixture();
    let finish!: (value: { text: string; stopReason: 'stop' }) => void;
    vi.mocked(f.plugin.generate).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = connectRuntime(f.plugin);
    const second = connectRuntime(f.plugin);
    const generation = first.chat(request);
    await vi.waitFor(() => expect(f.plugin.generate).toHaveBeenCalledOnce());
    await second.close();
    expect(f.plugin.cancel).not.toHaveBeenCalled();
    expect(f.plugin.releaseModel).not.toHaveBeenCalled();
    finish({ text: 'Complete', stopReason: 'stop' });
    expect((await generation).choices[0]?.message.content).toBe('Complete');
    await first.close();
  });
  it.each([0, -1, 1.5, 100_000, '12', null])(
    'rejects invalid token budgets (%j)',
    async (max_tokens) => {
      const { plugin } = fixture();
      await expect(
        connectRuntime(plugin).chat({ ...request, max_tokens } as typeof request),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(plugin.generate).not.toHaveBeenCalled();
    },
  );

  it('normalizes native failures and rejects malformed final replies', async () => {
    const { plugin } = fixture();
    const app = connectRuntime(plugin);
    vi.mocked(plugin.generate).mockRejectedValueOnce(
      Object.assign(new Error('Device is busy'), { code: 'BUSY' }),
    );
    await expect(app.chat(request)).rejects.toMatchObject({ name: 'GezelSdkError', code: 'BUSY' });
    vi.mocked(plugin.generate).mockResolvedValueOnce({ text: 'x', stopReason: 'other' } as never);
    await expect(app.chat(request)).rejects.toMatchObject({ code: 'native_protocol' });
    await app.close();
  });

  it('keeps a cancelled request admitted until the native release barrier resolves', async () => {
    const f = fixture();
    let finish!: (reply: { text: string; stopReason: 'cancelled' }) => void;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.plugin.generate).mockImplementation((input) => {
      f.emit(input.requestId, 'First');
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    vi.mocked(f.plugin.cancel).mockImplementation(async () => {
      await released;
      finish({ text: 'First', stopReason: 'cancelled' });
    });
    const app = connectRuntime(f.plugin);
    const other = connectRuntime(f.plugin);
    const stream = await app.chat({ ...request, stream: true });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.plugin.cancel).toHaveBeenCalled());
    await expect(other.chat(request)).rejects.toMatchObject({ name: 'GezelSdkError' });
    expect(closed).toBe(false);
    expect(f.plugin.generate).toHaveBeenCalledOnce();
    release();
    await closing;
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    await other.close();
  });
});

it.each([true, false])(
  'keeps split model thought tags out of assistant content (stream=%s)',
  async (stream) => {
    const f = fixture();
    const raw = '<think>private reasoning</think>\n\nThe meeting moves to Tuesday.';
    vi.mocked(f.plugin.generate).mockImplementation(async (input) => {
      for (let i = 0; i < raw.length - 1; i += 2)
        f.emit(input.requestId, raw.slice(i, Math.min(i + 2, raw.length - 1)));
      return { text: raw, stopReason: 'stop' };
    });
    const app = connectRuntime(f.plugin);
    try {
      if (stream) {
        let answer = '';
        for await (const chunk of await app.chat({ ...request, stream: true }))
          answer += chunk.choices[0]?.delta.content ?? '';
        expect(answer).toBe('The meeting moves to Tuesday.');
      } else {
        expect((await app.chat(request)).choices[0]?.message.content).toBe(
          'The meeting moves to Tuesday.',
        );
      }
    } finally {
      await app.close();
    }
  },
);

describe('embedding text through the native transport', () => {
  it('accepts shared stream metadata, scopes native progress and preserves unknown usage', async () => {
    const { plugin } = fixture();
    const listeners = new Map<string, (event: unknown) => void>();
    vi.mocked(plugin.addListener).mockImplementation(async (name, listener) => {
      listeners.set(name, listener as (event: unknown) => void);
      return {
        remove: async () => {
          listeners.delete(name);
        },
      };
    });
    vi.mocked(plugin.listModelDownloads).mockResolvedValue({ downloads: [] });
    vi.mocked(plugin.generate).mockImplementation(async ({ requestId }) => {
      const phase = listeners.get('enginePhase')!;
      phase({ requestId: 'stale', phase: 'prefill', progress: 0.1 });
      phase({ requestId, phase: 'loading_model', progress: 0.5 });
      phase({ requestId, phase: 'cooling' });
      phase({ requestId, phase: 'generating', outputTokens: 3, tokensPerSec: 12 });
      return { text: 'Ready.', stopReason: 'stop' };
    });
    const host = createRuntimeEmbedding(plugin, { catalog: [] });
    await host.setEnabled(true);
    const events: unknown[] = [];
    try {
      const result = await host.streamText(request, { onEvent: (event) => events.push(event) });
      expect(result).toMatchObject({ text: 'Ready.', finishReason: 'stop', usage: null });
      expect(events).toEqual([
        {
          type: 'progress',
          progress: {
            phase: 'loading_model',
            percent: 50,
            outputTokens: null,
            tokensPerSecond: null,
          },
        },
        {
          type: 'progress',
          progress: { phase: 'queued', percent: null, outputTokens: null, tokensPerSecond: null },
        },
        {
          type: 'progress',
          progress: { phase: 'generating', percent: null, outputTokens: 3, tokensPerSecond: 12 },
        },
        { type: 'delta', text: 'Ready.' },
        result,
      ]);
      expect(listeners.size).toBe(0);
    } finally {
      await host.close();
    }
  });
  it.each([null, [], { include_progress: 'yes' }, { injected: true }])(
    'rejects malformed stream options before native generation: %j',
    async (stream_options) => {
      const { plugin } = fixture();
      const app = connectRuntime(plugin);
      try {
        await expect(
          app.chat({ ...request, stream: true, stream_options } as never),
        ).rejects.toMatchObject({ code: 'unsupported_capability' });
        expect(plugin.generate).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});

describe('native chat parity with desktop', () => {
  function nativeChatFixture() {
    const { plugin } = fixture();
    const listeners = new Map<string, (event: unknown) => void>();
    const providers = plugin.providers;
    plugin.providers = async () => {
      const result = await providers();
      result.providers[0]!.capabilities.structuredChat = true;
      return result;
    };
    vi.mocked(plugin.addListener).mockImplementation(async (name, listener) => {
      listeners.set(name, listener as (event: unknown) => void);
      return {
        remove: async () => {
          listeners.delete(name);
        },
      };
    });
    plugin.chat = vi.fn<NonNullable<GezelRuntimePlugin['chat']>>(async ({ requestId }) => {
      listeners.get('chatChunk')!({
        requestId: 'stale',
        chunks: [JSON.stringify({ choices: [{ index: 0, delta: { content: 'wrong' } }] })],
      });
      listeners.get('chatChunk')!({
        requestId,
        chunks: [
          JSON.stringify({
            choices: [{ index: 0, delta: { reasoning_content: 'private reasoning' } }],
          }),
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'Ready.' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        ],
      });
      return { status: 'ok' };
    });
    return { plugin, listeners };
  }
  it('uses native chat templates and reasoning controls while streaming only answer content', async () => {
    const { plugin, listeners } = nativeChatFixture();
    const app = connectRuntime(plugin);
    try {
      expect((await app.models()).data[0]!.supported_options).toContain('reasoning_effort');
      const events = [];
      for await (const event of await app.chat({
        stream: true,
        ...request,
        temperature: 0.2,
        reasoning_effort: 'none',
      }))
        events.push(event);
      expect(JSON.stringify(events)).toContain('Ready.');
      expect(JSON.stringify(events)).not.toContain('private reasoning');
      expect(JSON.stringify(events)).not.toContain('wrong');
      expect(plugin.generate).not.toHaveBeenCalled();
      expect(JSON.parse(vi.mocked(plugin.chat!).mock.calls[0]![0].requestJson)).toMatchObject({
        messages: request.messages,
        temperature: 0.2,
        reasoning_effort: 'none',
        stream: true,
      });
      expect(listeners.size).toBe(0);
    } finally {
      await app.close();
    }
  });
  it.each(['error', 'missing-finish', 'tool-call'])(
    'rejects native chat failures without reporting success: %s',
    async (failure) => {
      const { plugin, listeners } = nativeChatFixture();
      plugin.chat = vi.fn<NonNullable<GezelRuntimePlugin['chat']>>(async ({ requestId }) => {
        const chunk =
          failure === 'error'
            ? { error: { message: 'Engine unavailable' } }
            : {
                choices: [
                  {
                    index: 0,
                    delta: failure === 'tool-call' ? { tool_calls: [{}] } : { content: 'partial' },
                  },
                ],
              };
        listeners.get('chatChunk')!({ requestId, chunks: [JSON.stringify(chunk)] });
        return { status: 'ok' };
      });
      const app = connectRuntime(plugin);
      try {
        await expect(app.chat(request)).rejects.toBeInstanceOf(Error);
        expect(listeners.size).toBe(0);
      } finally {
        await app.close();
      }
    },
  );
  it('cancels native chat and releases its listeners before closing', async () => {
    const { plugin, listeners } = nativeChatFixture();
    let complete!: (reply: { status: 'cancelled' }) => void;
    plugin.chat = vi.fn<NonNullable<GezelRuntimePlugin['chat']>>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(plugin.cancel).mockImplementation(async () => {
      complete({ status: 'cancelled' });
    });
    const app = connectRuntime(plugin);
    const controller = new AbortController();
    const stream = await app.chat({ ...request, stream: true }, { signal: controller.signal });
    await vi.waitFor(() => expect(plugin.chat).toHaveBeenCalledOnce());
    controller.abort();
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: 'AbortError',
    });
    await app.close();
    expect(plugin.cancel).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
  it('keeps reasoning controls unsupported on legacy native bridges', async () => {
    const { plugin } = fixture();
    const app = connectRuntime(plugin);
    try {
      await expect(app.chat({ ...request, reasoning_effort: 'none' })).rejects.toMatchObject({
        code: 'unsupported_capability',
      });
      expect(plugin.generate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
