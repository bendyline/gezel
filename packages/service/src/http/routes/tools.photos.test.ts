import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { toolRoutes } from './tools.js';

/** Which callers see a photo's location: the person's app, and a session on an on-device model. */
async function locationSeenBy(
  auth: { appId: string; scopes: string[] },
  sessionProvider?: string,
): Promise<{ list: boolean; groups: boolean }> {
  const listPhotos = vi.fn(async () => ({ photos: [], total: 0, truncated: false }));
  const photoGroups = vi.fn(async () => ({
    by: 'event',
    groups: [],
    truncated: false,
    engine: 'metadata',
  }));
  const ctx = {
    store: { getProject: async () => ({ id: 'pics' }) },
    contentIndex: { listPhotos, photoGroups },
    chat: {
      getSessionRecord: async () => (sessionProvider ? { providerName: sessionProvider } : null),
    },
  } as unknown as ServiceContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/', toolRoutes(ctx));
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post('/pics/tools/list-photos', { from: '2024' })).status).toBe(200);
  expect((await post('/pics/tools/photo-groups', { by: 'event' })).status).toBe(200);
  return {
    list: (listPhotos.mock.calls[0] as unknown as [string, unknown, boolean])[2],
    groups: (photoGroups.mock.calls[0] as unknown as [string, unknown, boolean])[2],
  };
}

describe('photo tool routes', () => {
  it("show locations to the person's own app", async () => {
    expect(await locationSeenBy({ appId: 'desktop', scopes: ['ui'] })).toEqual({
      list: true,
      groups: true,
    });
  });

  it('show locations to a session on an on-device model', async () => {
    const session = { appId: 'session:s1', scopes: ['session'] };
    expect(await locationSeenBy(session, 'mlx')).toEqual({ list: true, groups: true });
  });

  it('withhold them from a session on a cloud model, or one it cannot place', async () => {
    const session = { appId: 'session:s1', scopes: ['session'] };
    expect(await locationSeenBy(session, 'anthropic')).toEqual({ list: false, groups: false });
    expect(await locationSeenBy(session)).toEqual({ list: false, groups: false });
  });
});
