import type { VSCodeSetupStatusResponse } from '@bendyline/gezel';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { vscodeSetupRoutes } from './vscode-setup.js';

const STATUS: VSCodeSetupStatusResponse = {
  state: 'not-configured',
  models: [],
  reasons: [],
  vscodeInstalled: true,
  endpointsEnabled: true,
  providerId: 'customendpoint',
  profiles: [
    {
      id: 'code:default',
      label: 'Default profile',
      product: 'code',
      configPath: '/tmp/Code/User/chatLanguageModels.json',
    },
  ],
  configPath: '/tmp/Code/User/chatLanguageModels.json',
  launchCommand: 'code',
  bridge: { baseUrl: 'http://127.0.0.1:24567/v1', listening: false, port: 24_567 },
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
    c.set('auth', { appId: 'test', scopes: [c.req.header('x-test-scope') ?? 'ui'] });
    return next();
  });
  router.route(
    '/api/vscode-setup',
    vscodeSetupRoutes({ vscodeSetup: { status, configure, remove } } as unknown as ServiceContext),
  );
  return { router, configure, remove };
}

describe('/api/vscode-setup', () => {
  it('is first-party only', async () => {
    const { router } = app();
    expect((await router.request('/api/vscode-setup')).status).toBe(200);
    expect(
      (
        await router.request('/api/vscode-setup', {
          headers: { 'x-test-scope': 'product' },
        })
      ).status,
    ).toBe(403);
  });

  it('validates and delegates profile setup and removal', async () => {
    const { router, configure, remove } = app();
    expect(
      (
        await router.request('/api/vscode-setup', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    const configured = await router.request('/api/vscode-setup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'code:default', backupConflictingConfig: true }),
    });
    expect(configured.status).toBe(200);
    expect(configure).toHaveBeenCalledWith({
      profileId: 'code:default',
      backupConflictingConfig: true,
    });
    expect((await router.request('/api/vscode-setup', { method: 'DELETE' })).status).toBe(200);
    expect(remove).toHaveBeenCalledOnce();
  });
});
