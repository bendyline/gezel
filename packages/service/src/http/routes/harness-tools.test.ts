import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { harnessToolsRoutes } from './harness-tools.js';

function build(scopes: string[]) {
  const harnessTools = {
    status: vi.fn().mockResolvedValue({ clients: [] }),
    updateConfig: vi.fn().mockResolvedValue({ clients: [] }),
    configure: vi.fn().mockResolvedValue({ client: 'cursor', state: 'configured' }),
    remove: vi.fn().mockResolvedValue({ client: 'cursor', state: 'not-configured' }),
    stopConnection: vi.fn().mockResolvedValue({ clients: [] }),
    unblock: vi.fn().mockResolvedValue({ clients: [] }),
    launchSpec: vi
      .fn()
      .mockResolvedValue({ command: '/node', args: ['launch.mjs', '--harness', 'vscode'] }),
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { appId: 'x', appName: 'x', scopes } as never);
    await next();
  });
  app.route(
    '/api/harness-tools',
    harnessToolsRoutes({ harnessTools } as unknown as ServiceContext),
  );
  return { app, harnessTools };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/harness-tools', () => {
  it('is the person’s own app’s alone, except the launch command', async () => {
    const { app } = build(['product']);
    expect((await app.request('/api/harness-tools')).status).toBe(403);
    expect((await app.request('/api/harness-tools/clients/cursor', json('PUT', {}))).status).toBe(
      403,
    );
    expect(
      (await app.request('/api/harness-tools/config', json('PUT', { enabled: false }))).status,
    ).toBe(403);
    expect(
      (await app.request('/api/harness-tools/launcher?client=vscode&projectId=p1')).status,
    ).toBe(200);
    const session = build(['session']);
    expect((await session.app.request('/api/harness-tools/launcher?client=vscode')).status).toBe(
      403,
    );
  });

  it('validates the app and the body before it changes anything', async () => {
    const { app, harnessTools } = build(['ui']);
    expect((await app.request('/api/harness-tools/clients/emacs', json('PUT', {}))).status).toBe(
      400,
    );
    expect(
      (await app.request('/api/harness-tools/config', json('PUT', { memory: 'always' }))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/harness-tools/clients/claude-desktop',
          json('PUT', { projectId: 'p1' }),
        )
      ).status,
    ).toBe(200);
    expect(harnessTools.configure).toHaveBeenCalledWith('claude-desktop', { projectId: 'p1' });
    expect(
      (
        await app.request('/api/harness-tools/connections/harness%3Acursor%3Ap1/stop', {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(harnessTools.stopConnection).toHaveBeenCalledWith('harness:cursor:p1');
  });

  it('turns a setup refusal into its own status and message', async () => {
    const { app, harnessTools } = build(['ui']);
    harnessTools.configure.mockRejectedValueOnce(
      Object.assign(new Error('Cursor already has a server called gezel.'), {
        code: 'conflict',
        status: 409,
      }),
    );
    const res = await app.request('/api/harness-tools/clients/cursor', json('PUT', {}));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'conflict',
      message: 'Cursor already has a server called gezel.',
    });
  });
});
