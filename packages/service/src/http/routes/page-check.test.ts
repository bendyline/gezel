import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { pageCheckRoutes } from './page-check.js';

/**
 * The skip path is the contract that matters most here: an install
 * without the Playwright toolset must get a fast, non-error `ran: false`
 * — never a 500, never a background download — because this route sits
 * inside every HTML write's tool result. The positive path (actual
 * Chromium run) is covered by page-check/runner.test.ts.
 */
function makeApp(overrides: {
  getProject?: () => Promise<unknown>;
  listInstalledToolsets?: () => Promise<Array<{ toolsetId: string; installPath?: string }>>;
}): Hono {
  const ctx = {
    home: '/nonexistent-home',
    store: {
      getProject: overrides.getProject ?? (async () => ({ id: 'p1' })),
      listInstalledToolsets: overrides.listInstalledToolsets ?? (async () => []),
    },
  } as unknown as Parameters<typeof pageCheckRoutes>[0];
  const capabilities = {
    mint: () => {
      throw new Error('mint must not be called on the skip path');
    },
  } as unknown as Parameters<typeof pageCheckRoutes>[1];
  const app = new Hono();
  app.route('/api/projects', pageCheckRoutes(ctx, capabilities));
  return app;
}

function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /:id/page-check', () => {
  it('skips fast with ran:false when the Playwright toolset is absent', async () => {
    const app = makeApp({});
    const res = await post(app, '/api/projects/p1/page-check', { path: 'index.html' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: false, reason: 'browser-runtime-not-installed' });
  });

  it('skips with chromium-not-installed when the toolset exists but the browser cache does not', async () => {
    const app = makeApp({
      // process.cwd() exists as an installPath stand-in; the fake home has no browsers dir.
      listInstalledToolsets: async () => [
        { toolsetId: '@playwright/mcp', installPath: process.cwd() },
      ],
    });
    const res = await post(app, '/api/projects/p1/page-check', { path: 'index.html' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: false, reason: 'chromium-not-installed' });
  });

  it('rejects non-HTML and traversal paths', async () => {
    const app = makeApp({});
    expect((await post(app, '/api/projects/p1/page-check', { path: 'script.js' })).status).toBe(
      400,
    );
    expect(
      (await post(app, '/api/projects/p1/page-check', { path: '../outside.html' })).status,
    ).toBe(400);
  });

  it('404s for an unknown project', async () => {
    const app = makeApp({
      getProject: async () => {
        throw new Error('not found');
      },
    });
    const res = await post(app, '/api/projects/nope/page-check', { path: 'index.html' });
    expect(res.status).toBe(404);
  });
});
