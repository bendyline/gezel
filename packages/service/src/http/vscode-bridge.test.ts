import { describe, expect, it } from 'vitest';
import type { ServiceContext } from './context.js';
import { VSCODE_BRIDGE_MARKER_HEADER, buildVSCodeBridgeApp } from './vscode-bridge.js';

function context(): ServiceContext {
  const records = new Map([
    [
      'vscode-token',
      {
        appId: 'vscode-test',
        appName: 'VS Code test',
        scopes: ['openai'],
        token: 'vscode-token',
        createdAt: 1,
        lastUsedAt: 0,
      },
    ],
  ]);
  return {
    tokenStore: {
      lookup: (token: string) => records.get(token) ?? null,
      touch: () => undefined,
    },
    store: {
      readConfig: async () => ({ openaiEndpoints: {} }),
      listGezels: async () => [],
    },
    chat: { listModelsForProvider: async () => [] },
  } as unknown as ServiceContext;
}

const auth = { authorization: 'Bearer vscode-token' };

describe('buildVSCodeBridgeApp', () => {
  it('serves only authenticated chat completions and model discovery', async () => {
    const app = buildVSCodeBridgeApp(context());
    expect((await app.request('http://127.0.0.1/v1/models')).status).toBe(401);
    const models = await app.request('http://127.0.0.1/v1/models', { headers: auth });
    expect(models.status).toBe(200);
    expect(models.headers.get(VSCODE_BRIDGE_MARKER_HEADER)).toBe('1');
    await expect(models.json()).resolves.toMatchObject({ object: 'list' });

    for (const path of ['/api/config', '/v1/apps', '/v1/responses']) {
      expect((await app.request(`http://127.0.0.1${path}`, { headers: auth })).status).toBe(404);
    }
  });

  it('rejects non-loopback host headers and never enables CORS', async () => {
    const app = buildVSCodeBridgeApp(context());
    const response = await app.request('http://127.0.0.1/v1/models', {
      headers: { ...auth, host: 'evil.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get(VSCODE_BRIDGE_MARKER_HEADER)).toBe('1');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
