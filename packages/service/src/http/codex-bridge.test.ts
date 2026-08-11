import { type RequestListener, type Server, createServer } from 'node:http';
import type { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_BRIDGE_MARKER_HEADER,
  CODEX_BRIDGE_PORT,
  buildCodexBridgeApp,
  createCodexBridgeController,
} from './codex-bridge.js';
import type { ServiceContext } from './context.js';

type ServeFetch = Parameters<typeof serve>[0]['fetch'];

function context(opts: { enabled?: boolean } = {}): ServiceContext {
  const records = new Map([
    [
      'openai-token',
      {
        appId: 'codex-test',
        appName: 'Codex test',
        scopes: ['openai'],
        token: 'openai-token',
        createdAt: 1,
        lastUsedAt: 0,
      },
    ],
    [
      'cli-token',
      {
        appId: 'cli-test',
        appName: 'CLI test',
        scopes: ['cli'],
        token: 'cli-token',
        createdAt: 1,
        lastUsedAt: 0,
      },
    ],
  ]);
  const openaiEndpoints = opts.enabled === false ? { enabled: false } : {};
  return {
    tokenStore: {
      lookup: (token: string) => records.get(token) ?? null,
      touch: () => undefined,
    },
    store: {
      readConfig: async () => ({ openaiEndpoints }),
      listGezels: async () => [],
    },
    chat: {
      listModelsForProvider: async () => [],
    },
  } as unknown as ServiceContext;
}

function auth(token = 'openai-token'): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('buildCodexBridgeApp', () => {
  it('exposes authenticated Responses inference and nothing under /api', async () => {
    const app = buildCodexBridgeApp(context());

    const noToken = await app.request('http://127.0.0.1/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(noToken.status).toBe(401);
    await expect(noToken.json()).resolves.toMatchObject({
      error: { code: 'invalid_api_key' },
    });

    const wrongScope = await app.request('http://127.0.0.1/v1/responses', {
      method: 'POST',
      headers: { ...auth('cli-token'), 'content-type': 'application/json' },
      body: '{',
    });
    expect(wrongScope.status).toBe(403);
    await expect(wrongScope.json()).resolves.toMatchObject({
      error: { code: 'missing_scope:openai' },
    });

    // Invalid JSON reaches the real Responses route after auth. It is a
    // cheap assertion of route wiring that does not initialize a provider.
    const authorized = await app.request('http://127.0.0.1/v1/responses', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{',
    });
    expect(authorized.status).toBe(400);
    await expect(authorized.json()).resolves.toMatchObject({
      error: { code: 'invalid_json' },
    });

    const productApi = await app.request('http://127.0.0.1/api/config', {
      headers: auth(),
    });
    expect(productApi.status).toBe(404);
    const chatCompat = await app.request('http://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      headers: auth(),
    });
    expect(chatCompat.status).toBe(404);
  });

  it('applies the Connected Apps master switch before inference', async () => {
    const app = buildCodexBridgeApp(context({ enabled: false }));
    const response = await app.request('http://127.0.0.1/v1/responses', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'openai_endpoints_disabled' },
    });
  });

  it('adds security/ownership headers, rejects rebound hosts, and does not enable CORS', async () => {
    const app = buildCodexBridgeApp(context());
    const forbidden = await app.request('http://127.0.0.1/v1/responses', {
      method: 'POST',
      headers: { host: 'evil.example', ...auth() },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get(CODEX_BRIDGE_MARKER_HEADER)).toBe('1');
    expect(forbidden.headers.get('x-content-type-options')).toBe('nosniff');
    expect(forbidden.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('mounts /v1/models only when requested and keeps it authenticated', async () => {
    const narrow = buildCodexBridgeApp(context());
    expect((await narrow.request('http://127.0.0.1/v1/models', { headers: auth() })).status).toBe(
      404,
    );

    const withModels = buildCodexBridgeApp(context(), {
      models: async () => [{ slug: 'llama-cpp:test', display_name: 'Test model' }],
    });
    expect((await withModels.request('http://127.0.0.1/v1/models')).status).toBe(401);
    const listed = await withModels.request('http://127.0.0.1/v1/models', {
      headers: auth(),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      models: [{ slug: 'llama-cpp:test', display_name: 'Test model' }],
    });
  });

  it('replaces unexpected model-catalog failures with an opaque error', async () => {
    const app = buildCodexBridgeApp(context(), {
      models: async () => {
        throw new Error('/Users/private/model-catalog.json contained SECRET-DATA');
      },
    });
    const response = await app.request('http://127.0.0.1/v1/models', {
      headers: auth(),
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('internal_error');
    expect(body).not.toContain('/Users/private');
    expect(body).not.toContain('SECRET-DATA');
  });
});

async function occupyPort(
  handler: RequestListener = () => undefined,
): Promise<{ port: number; close: () => Promise<void> }> {
  const blocker: Server = createServer(handler);
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    close: () => new Promise((resolve) => blocker.close(() => resolve())),
  };
}

const okFetch = (): (() => ServeFetch) => {
  const handler = (async () => new Response('ok')) as unknown as ServeFetch;
  return () => handler;
};

describe('createCodexBridgeController', () => {
  const controllers: Array<ReturnType<typeof createCodexBridgeController>> = [];

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  });

  it('uses the documented default and validates explicit ports', () => {
    expect(CODEX_BRIDGE_PORT).toBe(11_435);
    expect(() => createCodexBridgeController({ fetch: okFetch(), port: -1 })).toThrow(
      /Invalid Codex bridge port/,
    );
  });

  it('starts and stops an exact loopback listener idempotently', async () => {
    const controller = createCodexBridgeController({ fetch: okFetch(), port: 0 });
    controllers.push(controller);
    expect(controller.status()).toEqual({ listening: false });
    expect(controller.desiredPort()).toBe(0);
    expect(controller.baseUrl()).toBeNull();

    const started = await controller.start();
    expect(started.listening).toBe(true);
    expect(started.port).toBeGreaterThan(0);
    expect(controller.baseUrl()).toBe(`http://127.0.0.1:${started.port}`);
    expect(await (await fetch(`http://127.0.0.1:${started.port}`)).text()).toBe('ok');
    expect(await controller.start()).toEqual(started);

    await controller.stop();
    expect(controller.status()).toEqual({ listening: false });
    await controller.stop();
    await expect(fetch(`http://127.0.0.1:${started.port}`)).rejects.toThrow();
  });

  it('refuses an occupied port with an actionable message', async () => {
    const blocker = await occupyPort();
    try {
      const controller = createCodexBridgeController({ fetch: okFetch(), port: blocker.port });
      controllers.push(controller);
      await expect(controller.start()).rejects.toThrow(
        `Port ${blocker.port} is already in use by another process`,
      );
      expect(controller.status()).toEqual({ listening: false });
    } finally {
      await blocker.close();
    }
  });

  it('identifies another Gezel Codex bridge during conflict diagnosis', async () => {
    const blocker = await occupyPort((_request, response) => {
      response.writeHead(404, { [CODEX_BRIDGE_MARKER_HEADER]: '1' });
      response.end();
    });
    try {
      const controller = createCodexBridgeController({ fetch: okFetch(), port: blocker.port });
      controllers.push(controller);
      await expect(controller.start()).rejects.toThrow(/another Gezel Codex bridge/);
    } finally {
      await blocker.close();
    }
  });
});
