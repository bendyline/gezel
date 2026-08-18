import type { CodexSetupStatusResponse } from '@bendyline/gezel';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { codexSetupRoutes } from './codex-setup.js';

const STATUS: CodexSetupStatusResponse = {
  state: 'not-configured',
  models: [],
  reasons: [],
  codexInstalled: true,
  endpointsEnabled: true,
  profileName: 'gezel-local',
  profilePath: '/tmp/codex/gezel-local.config.toml',
  launchCommand: 'codex --profile gezel-local',
  bridge: { baseUrl: 'http://127.0.0.1:11435/v1', listening: false, port: 11_435 },
  canConfigure: false,
  canRemove: false,
  canRepair: false,
};

function app() {
  const status = vi.fn(async () => STATUS);
  const configure = vi.fn(async () => STATUS);
  const remove = vi.fn(async () => STATUS);
  const router = new Hono();
  router.use('*', async (c, next) => {
    const scope = c.req.header('x-test-scope') ?? 'ui';
    c.set('auth', { appId: 'test', scopes: [scope] });
    return next();
  });
  router.route(
    '/api/codex-setup',
    codexSetupRoutes({ codexSetup: { status, configure, remove } } as unknown as ServiceContext),
  );
  return { router, status, configure, remove };
}

describe('/api/codex-setup', () => {
  it('allows root/UI callers but denies ordinary product and CLI tokens', async () => {
    const { router } = app();
    expect(
      (await router.request('/api/codex-setup', { headers: { 'x-test-scope': 'ui' } })).status,
    ).toBe(200);
    expect(
      (await router.request('/api/codex-setup', { headers: { 'x-test-scope': 'root' } })).status,
    ).toBe(200);
    for (const scope of ['product', 'cli', 'session']) {
      const response = await router.request('/api/codex-setup', {
        headers: { 'x-test-scope': scope },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'missing_scope:first-party' });
    }
  });

  it('validates configure requests before mutating and returns the manager status', async () => {
    const { router, configure } = app();
    const invalid = await router.request('/api/codex-setup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(invalid.status).toBe(400);
    expect(configure).not.toHaveBeenCalled();

    const valid = await router.request('/api/codex-setup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama-cpp:coder.gguf' }),
    });
    expect(valid.status).toBe(200);
    expect(configure).toHaveBeenCalledWith({ model: 'llama-cpp:coder.gguf' });
  });

  it('delegates removal without accepting a body or model path', async () => {
    const { router, remove } = app();
    const response = await router.request('/api/codex-setup', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(remove).toHaveBeenCalledOnce();
  });
});
