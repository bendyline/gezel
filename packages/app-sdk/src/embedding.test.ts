import { describe, expect, it, vi } from 'vitest';
import { GezelApp } from './client.js';
import { type EmbeddingConnection, type TextEvent, createEmbedding } from './embedding.js';
import { createModelManager } from './model-manager.js';
function fixture() {
  const model = { id: 'fixture', object: 'model' as const, created: 0, owned_by: 'test' };
  const close = vi.fn(async () => {});
  const connection: EmbeddingConnection = {
    close,
    models: createModelManager({
      list: async () => [model],
      prepare: async () => model.id,
      cancellation: 'download',
    }),
    app: new GezelApp({
      baseUrl: 'http://fixture',
      token: 'test',
      fetch: async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
    }),
  };
  return { connection, close };
}
describe('optional embedding lifecycle', () => {
  it('starts nothing before opt-in; first use connects silently, reconnect is interactive', async () => {
    const connect = vi.fn(async () => fixture().connection);
    const host = createEmbedding({ connect });
    await expect(host.models.list()).rejects.toMatchObject({ code: 'disabled' });
    await host.setEnabled(true);
    expect(connect).not.toHaveBeenCalled();
    await host.models.list();
    expect(connect).toHaveBeenLastCalledWith({ interactive: false });
    await host.reconnect();
    expect(connect).toHaveBeenLastCalledWith({ interactive: true });
    await host.close();
  });
  it('closes a connection that completes after opt-out', async () => {
    const { connection, close } = fixture();
    let resolve!: (value: EmbeddingConnection) => void;
    const host = createEmbedding({
      connect: () =>
        new Promise((value) => {
          resolve = value;
        }),
    });
    await host.setEnabled(true);
    const listing = host.models.list();
    const rejected = expect(listing).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(host.state).toBe('connecting'));
    const stopped = host.setEnabled(false);
    resolve(connection);
    await stopped;
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(host.state).toBe('disabled');
  });
  it('suspends, releases, and reconnects lazily after resume', async () => {
    const { connection, close } = fixture();
    const connect = vi.fn(async () => connection);
    const host = createEmbedding({ connect });
    await host.setEnabled(true);
    await host.models.list();
    await host.suspend();
    expect(close).toHaveBeenCalledOnce();
    await expect(host.models.list()).rejects.toMatchObject({ code: 'suspended' });
    host.resume();
    expect(connect).toHaveBeenCalledOnce();
    await host.close();
  });
  it('emits one terminal event, retaining partial output on cancellation', async () => {
    const { connection } = fixture();
    const host = createEmbedding({ connect: async () => connection });
    await host.setEnabled(true);
    const controller = new AbortController();
    const events: TextEvent[] = [];
    const result = await host.streamText(
      { model: 'fixture', messages: [{ role: 'user', content: 'hello' }] },
      {
        signal: controller.signal,
        onEvent(event) {
          events.push(event);
          if (event.type === 'delta') controller.abort();
        },
      },
    );
    expect(result).toMatchObject({ text: 'hello', cancelled: true });
    expect(events.filter((event) => event.type !== 'delta')).toHaveLength(1);
    await host.close();
  });
  it('rejects a missing explicit selection without invoking chat', async () => {
    const { connection } = fixture();
    const chat = vi.spyOn(connection.app, 'chat');
    const host = createEmbedding({ connect: async () => connection });
    await host.setEnabled(true);
    const events: TextEvent[] = [];
    await expect(
      host.streamText(
        { model: 'deleted', messages: [] },
        { onEvent: (event) => events.push(event) },
      ),
    ).rejects.toMatchObject({ code: 'model_not_ready' });
    expect(chat).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['error']);
    await host.close();
  });
});

it('still closes the transport if model cleanup fails, and reports the failure', async () => {
  const { connection, close } = fixture();
  vi.spyOn(connection.models, 'close').mockRejectedValue(new Error('cleanup fixture'));
  const host = createEmbedding({ connect: async () => connection });
  await host.setEnabled(true);
  await host.models.list();
  await expect(host.close()).rejects.toMatchObject({ code: 'cleanup_failed' });
  expect(close).toHaveBeenCalledOnce();
});

it('carries progress, tuning, final model and usage without treating metadata as text', async () => {
  const { connection } = fixture();
  const progress = { phase: 'prefill', percent: 50, outputTokens: null, tokensPerSecond: null };
  const usage = { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 };
  const chat = vi.spyOn(connection.app, 'chat').mockResolvedValue(
    (async function* () {
      yield { choices: [], gezel_progress: progress };
      yield {
        model: 'actual',
        choices: [{ delta: { content: 'draft' }, finish_reason: 'length' }],
      };
      yield { choices: [], usage };
    })() as never,
  );
  const host = createEmbedding({ connect: async () => connection });
  await host.setEnabled(true);
  const events: TextEvent[] = [];
  const result = await host.streamText(
    { model: 'fixture', messages: [], temperature: 0.35, reasoningEffort: 'none', maxTokens: 100 },
    { onEvent: (event) => events.push(event) },
  );
  expect(chat).toHaveBeenCalledWith(
    expect.objectContaining({
      temperature: 0.35,
      reasoning_effort: 'none',
      max_tokens: 100,
      stream_options: { include_usage: true, include_progress: true },
    }),
    expect.anything(),
  );
  expect(events.map((event) => event.type)).toEqual(['progress', 'delta', 'done']);
  expect(result).toMatchObject({ text: 'draft', finishReason: 'length', model: 'actual', usage });
  await host.close();
});

it('rejects explicitly unsupported sampling options before generation', async () => {
  const { connection } = fixture();
  vi.spyOn(connection.models, 'inspect').mockResolvedValue({
    id: 'fixture',
    availability: 'available',
    supported_options: ['max_tokens'],
  } as never);
  const chat = vi.spyOn(connection.app, 'chat');
  const host = createEmbedding({ connect: async () => connection });
  await host.setEnabled(true);
  await expect(
    host.streamText({ model: 'fixture', messages: [], temperature: 0.7 }),
  ).rejects.toMatchObject({ code: 'unsupported_option' });
  expect(chat).not.toHaveBeenCalled();
  await host.close();
});

it('tracks knowledge operations through opt-out and discards late retrieval', async () => {
  const { connection } = fixture();
  let signal: AbortSignal | undefined;
  connection.knowledge = {
    state: vi.fn(),
    update: vi.fn(),
    retrieve: vi.fn(async (_query, opts) => {
      signal = opts?.signal;
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal?.throwIfAborted();
      return { reranked: false, passages: [] };
    }),
  };
  const host = createEmbedding({ connect: async () => connection });
  await host.setEnabled(true);
  const pending = host.knowledge.retrieve({ query: 'test', maxResults: 1, maxCharacters: 100 });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
  await vi.waitFor(() => expect(signal).toBeDefined());
  await host.setEnabled(false);
  await rejected;
  await host.close();
});
