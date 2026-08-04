import { describe, expect, it } from 'vitest';
import { LlamaCppCacheAdapter } from './llama-cpp/cache-adapter.js';
import { LlamaCppProvider } from './llama-cpp/provider.js';
import { MlxCacheAdapter } from './mlx/cache-adapter.js';
import { MlxProvider } from './mlx/provider.js';

describe('native prepared cache prefill', () => {
  it('binds a broker-namespaced llama.cpp session to its cache slot', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const provider = new LlamaCppProvider({
      baseUrl: 'http://llama.test',
      fetchImpl,
      concurrency: 2,
    });
    provider.setCacheAdapter(
      new LlamaCppCacheAdapter({ resolveBaseUrl: async () => null, slotCount: 2 }),
    );
    const session = await provider.createSession({
      systemMessage: 'stable system',
      priorMessages: [{ role: 'user', content: 'earlier' }],
      externalTools: [{ name: 'read_file', parameters: { type: 'object' } }],
    });

    await session.prefillOnly?.({ sessionId: 'dev:user-a:session-a', timeoutMs: 5_000 });

    expect(body).toMatchObject({
      stream: false,
      max_tokens: 1,
      cache_prompt: true,
      id_slot: expect.any(Number),
      messages: [
        { role: 'system', content: 'stable system' },
        { role: 'user', content: 'earlier' },
      ],
    });
    expect(body?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'read_file' }) }),
      ]),
    );
    await session.disconnect();
  });

  it('uses the broker-namespaced MLX cache id for the exact prepared prefix', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test', fetchImpl });
    provider.setCacheAdapter(new MlxCacheAdapter({ resolveBaseUrl: async () => null }));
    const session = await provider.createSession({
      systemMessage: 'stable system',
      systemPromptLayers: { gezel: 'gezel layer', project: 'project layer' },
      priorMessages: [{ role: 'user', content: 'earlier' }],
      externalTools: [{ name: 'read_file', parameters: { type: 'object' } }],
    });

    await session.prefillOnly?.({ sessionId: 'dev:user-a:session-a', timeoutMs: 5_000 });

    expect(body).toMatchObject({
      stream: false,
      max_tokens: 1,
      cache_id: 'dev:user-a:session-a',
      messages: [
        { role: 'system', content: 'stable system' },
        { role: 'user', content: 'earlier' },
      ],
    });
    expect(body?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: 'read_file' }) }),
      ]),
    );
    await session.disconnect();
  });
});
