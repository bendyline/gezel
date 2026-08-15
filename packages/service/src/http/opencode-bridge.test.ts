import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceContext } from './context.js';
import {
  OPENCODE_BRIDGE_MARKER_HEADER,
  buildOpenCodeBridgeApp,
  createOpenCodeBridgeController,
} from './opencode-bridge.js';

function context(opts: { enabled?: boolean } = {}): ServiceContext {
  const records = new Map([
    [
      'openai-token',
      {
        appId: 'opencode-test',
        appName: 'OpenCode test',
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

const controllers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
});

describe('buildOpenCodeBridgeApp', () => {
  it('exposes authenticated chat completions and nothing under /api', async () => {
    const app = buildOpenCodeBridgeApp(context());

    const noToken = await app.request('http://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(noToken.status).toBe(401);
    await expect(noToken.json()).resolves.toMatchObject({
      error: { code: 'invalid_api_key' },
    });

    const wrongScope = await app.request('http://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth('cli-token'), 'content-type': 'application/json' },
      body: '{',
    });
    expect(wrongScope.status).toBe(403);
    await expect(wrongScope.json()).resolves.toMatchObject({
      error: { code: 'missing_scope:openai' },
    });

    // Invalid JSON reaches the real chat route after auth — cheap proof of
    // route wiring that does not initialize a provider.
    const authorized = await app.request('http://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{',
    });
    expect(authorized.status).toBe(400);

    // The whole point of assembling this app separately: product surface is
    // absent by construction, not filtered.
    for (const path of ['/api/config', '/api/gezels', '/v1/apps', '/v1/responses']) {
      const response = await app.request(`http://127.0.0.1${path}`, { headers: auth() });
      expect(response.status, path).toBe(404);
    }
  });

  it('serves the OpenAI model listing shape, authenticated', async () => {
    const app = buildOpenCodeBridgeApp(context());

    expect((await app.request('http://127.0.0.1/v1/models')).status).toBe(401);

    const listed = await app.request('http://127.0.0.1/v1/models', { headers: auth() });
    expect(listed.status).toBe(200);
    // Codex's bridge answers `{ models: [...] }`; OpenCode reads its roster
    // from the managed config and expects the ordinary OpenAI envelope here.
    await expect(listed.json()).resolves.toMatchObject({ object: 'list' });
  });

  it('applies the Connected Apps master switch before inference', async () => {
    const app = buildOpenCodeBridgeApp(context({ enabled: false }));

    const response = await app.request('http://127.0.0.1/v1/chat/completions', {
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
    const app = buildOpenCodeBridgeApp(context());

    const forbidden = await app.request('http://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      headers: { host: 'evil.example', ...auth() },
    });

    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get(OPENCODE_BRIDGE_MARKER_HEADER)).toBe('1');
    expect(forbidden.headers.get('x-content-type-options')).toBe('nosniff');
    expect(forbidden.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('createOpenCodeBridgeController', () => {
  it('binds loopback, reports its origin, and stops idempotently', async () => {
    const app = buildOpenCodeBridgeApp(context());
    const controller = createOpenCodeBridgeController({
      fetch: () => app.fetch.bind(app),
      port: 0,
    });
    controllers.push(controller);

    expect(controller.status().listening).toBe(false);
    expect(controller.baseUrl()).toBeNull();

    const started = await controller.start();
    expect(started.listening).toBe(true);
    expect(controller.baseUrl()).toBe(`http://127.0.0.1:${started.port}`);

    const response = await fetch(`${controller.baseUrl()}/v1/models`, {
      headers: auth(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(OPENCODE_BRIDGE_MARKER_HEADER)).toBe('1');

    await controller.stop();
    await controller.stop();
    expect(controller.status().listening).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(() =>
      createOpenCodeBridgeController({ fetch: () => () => new Response(), port: 70_000 }),
    ).toThrow(/Invalid OpenCode bridge port/);
  });
});
