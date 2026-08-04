import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { LLMProvider, SessionOpts } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { v1RemoteRoutes } from './v1-remote.js';

function authenticatedRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { appId: 'user-daemon-a' } as never);
    await next();
  });
  app.route('/', v1RemoteRoutes(ctx));
  return app;
}

function context(provider: LLMProvider, invalidated: string[] = []): ServiceContext {
  return {
    serviceRole: 'machine-engine',
    chat: {
      peekResidentLocalProviders: () => [provider],
      invalidateSessionCache: (sessionId: string) => invalidated.push(sessionId),
    },
  } as unknown as ServiceContext;
}

describe('/v1/remote/cache', () => {
  it('prefills a user-prepared prompt under the authenticated tenant namespace', async () => {
    let sessionOpts: SessionOpts | undefined;
    let prefillOpts: { sessionId?: string } | undefined;
    let disconnected = false;
    let resolveWarm: (() => void) | undefined;
    const warmed = new Promise<void>((resolve) => {
      resolveWarm = resolve;
    });
    const provider = {
      name: 'mlx',
      currentBaseUrl: () => 'http://127.0.0.1:8123',
      queue: {
        snapshot: () => ({ running: 0, queuedInteractive: 0, queuedBackground: 0 }),
      },
      createSession: async (opts: SessionOpts) => {
        sessionOpts = opts;
        return {
          prefillOnly: async (opts?: { sessionId?: string }) => {
            prefillOpts = opts;
            resolveWarm?.();
          },
          disconnect: async () => {
            disconnected = true;
          },
        };
      },
    } as unknown as LLMProvider;

    const response = await authenticatedRoutes(context(provider)).request('/cache/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        model: 'mlx:qwen',
        sessionId: 'session-a',
        systemMessage: 'stable system',
        systemPromptLayers: { gezel: 'gezel layer', project: 'project layer' },
        volatileContext: 'volatile state',
        priorMessages: [{ role: 'user', content: 'earlier' }],
        tools: [{ name: 'read_file', parameters: { type: 'object' } }],
        tuning: { sampling: { temperature: 0.2 } },
      }),
    });

    expect(response.status).toBe(202);
    await warmed;
    expect(sessionOpts).toMatchObject({
      systemMessage: 'stable system',
      model: 'qwen',
      priorMessages: [{ role: 'user', content: 'earlier' }],
      externalTools: [{ name: 'read_file' }],
      volatileContext: 'volatile state',
    });
    expect(prefillOpts).toEqual({ sessionId: 'dev:user-daemon-a:session-a' });
    await Promise.resolve();
    expect(disconnected).toBe(true);
  });

  it('does not cold-start an engine solely to warm a focused session', async () => {
    let createCalls = 0;
    const provider = {
      name: 'llama-cpp',
      currentBaseUrl: () => null,
      createSession: async () => {
        createCalls += 1;
        throw new Error('cold engine must not be started');
      },
    } as unknown as LLMProvider;

    const response = await authenticatedRoutes(context(provider)).request('/cache/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        model: 'llama-cpp:qwen.gguf',
        sessionId: 'session-a',
        systemMessage: 'system',
      }),
    });

    expect(response.status).toBe(202);
    await Promise.resolve();
    expect(createCalls).toBe(0);
  });

  it('namespaces a raw user session id before broker cache eviction', async () => {
    const invalidated: string[] = [];
    const provider = { name: 'mlx' } as unknown as LLMProvider;
    const response = await authenticatedRoutes(context(provider, invalidated)).request(
      '/cache/evict',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-a' }),
      },
    );

    expect(response.status).toBe(200);
    expect(invalidated).toEqual(['dev:user-daemon-a:session-a']);
  });
});
