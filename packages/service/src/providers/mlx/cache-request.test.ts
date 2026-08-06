import { describe, expect, it } from 'vitest';
import { MlxCacheAdapter } from './cache-adapter.js';
import { MlxProvider } from './provider.js';

function completionResponse(
  content = 'ok',
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens?: number;
  },
): Response {
  const sse = [
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
      ...(usage ? { usage } : {}),
    })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  return new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('MlxProvider cache request wiring', () => {
  it('continues from a seeded tool result without appending an empty user turn', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return completionResponse('Built it.');
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    const session = await provider.createSession({
      systemMessage: 'system',
      priorMessages: [
        { role: 'user', content: 'Build index.html.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'note-1', name: 'write_task_note', arguments: '{"ref":"frogger/1"}' }],
        },
        { role: 'tool', content: 'Appended note.', toolCallId: 'note-1' },
      ],
    });

    await session.sendAndWait('', { timeoutMs: 5_000, continueFromToolResult: true });

    const messages = body?.messages as Array<{ role: string; content?: string }>;
    expect(messages.at(-1)).toMatchObject({ role: 'tool', content: 'Appended note.' });
    expect(messages).not.toContainEqual({ role: 'user', content: '' });
    await session.disconnect();
  });

  it('uses one stable fallback cache id when queue session metadata is absent', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return completionResponse();
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    provider.setCacheAdapter(
      new MlxCacheAdapter({
        // Keep prefix warming out of this request-body test. The adapter
        // still emits cache extras even when no live server is resolvable.
        resolveBaseUrl: async () => null,
      }),
    );
    const session = await provider.createSession({ systemMessage: 'system' });

    await session.sendAndWait('first', { timeoutMs: 5_000 });
    await session.sendAndWait('second', { timeoutMs: 5_000 });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.cache_id).toMatch(/^mlx-session-[0-9a-f-]{36}$/);
    expect(bodies[1]?.cache_id).toBe(bodies[0]?.cache_id);
    await session.disconnect();
  });

  it('prefers the durable chat session id when the queue supplies one', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return completionResponse();
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    provider.setCacheAdapter(new MlxCacheAdapter({ resolveBaseUrl: async () => null }));
    const session = await provider.createSession({ systemMessage: 'system' });

    await session.sendAndWait('hello', {
      timeoutMs: 5_000,
      queue: { lane: 'interactive', sessionId: 'durable-session-id' },
    });

    expect(body?.cache_id).toBe('durable-session-id');
    await session.disconnect();
  });

  it('reports the engine measured cached-token breakdown in turn usage', async () => {
    const fetchImpl = (async () =>
      completionResponse('ok', {
        input_tokens: 9_261,
        output_tokens: 2,
        cached_tokens: 9_200,
      })) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    const session = await provider.createSession({ systemMessage: 'system' });
    const usages: Array<{ inputTokens: number; cachedInputTokens?: number }> = [];
    const unsubscribe = session.onUsage((usage) => usages.push(usage));

    await session.sendAndWait('hello', { timeoutMs: 5_000 });

    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual(
      expect.objectContaining({ inputTokens: 9_261, cachedInputTokens: 9_200 }),
    );
    unsubscribe();
    await session.disconnect();
  });

  it('evicts a never-resumable fallback cache when an ephemeral session disconnects', async () => {
    let cacheId: string | undefined;
    const providerFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { cache_id?: string };
      cacheId = body.cache_id;
      return completionResponse();
    }) as typeof fetch;
    const adapterRequests: Array<{ url: string; method?: string }> = [];
    const adapterFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      adapterRequests.push({
        url: typeof input === 'string' ? input : input.toString(),
        ...(init?.method ? { method: init.method } : {}),
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl: providerFetch });
    provider.setCacheAdapter(
      new MlxCacheAdapter({
        resolveBaseUrl: async () => 'http://mlx.test',
        fetchImpl: adapterFetch,
      }),
    );
    const session = await provider.createSession({
      systemMessage: 'system',
      // Layered prep registers prefix ids without issuing a warm request,
      // keeping this test focused on disconnect cleanup.
      systemPromptLayers: { gezel: 'system', project: 'system' },
    });

    await session.sendAndWait('hello', { timeoutMs: 5_000 });
    await session.disconnect();

    expect(cacheId).toMatch(/^mlx-session-/);
    expect(adapterRequests).toEqual([
      { url: `http://mlx.test/v1/cache/${cacheId}`, method: 'DELETE' },
    ]);
  });
});
