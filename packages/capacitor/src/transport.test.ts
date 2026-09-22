import { describe, expect, it, vi } from 'vitest';
import type { GezelRuntimePlugin } from './definitions.js';
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
