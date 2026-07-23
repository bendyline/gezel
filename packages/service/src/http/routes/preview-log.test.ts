import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { PreviewLogBuffer } from '../../preview-log/buffer.js';
import { previewLogRoutes } from './preview-log.js';

function makeApp(opts: { scopes: string[]; projectExists?: boolean }): {
  app: Hono;
  buffer: PreviewLogBuffer;
} {
  const buffer = new PreviewLogBuffer();
  const ctx = {
    previewLog: buffer,
    store: {
      getProject: async () => {
        if (opts.projectExists === false) throw new Error('not found');
        return { id: 'p1' };
      },
    },
  } as unknown as Parameters<typeof previewLogRoutes>[0];
  const app = new Hono();
  // Simulate bearerAuth having classified the caller.
  app.use('*', async (c, next) => {
    c.set('auth' as never, { scopes: opts.scopes } as never);
    await next();
  });
  app.route('/api/projects', previewLogRoutes(ctx));
  return { app, buffer };
}

const ENTRY = {
  kind: 'error',
  message: "Failed to execute 'addColorStop' on 'CanvasGradient'",
  path: 'index.html',
  source: 'workspace',
  at: '2026-07-19T00:00:00.000Z',
};

function post(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request('/api/projects/p1/preview-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /:id/preview-log', () => {
  it('records entries for first-party callers', async () => {
    const { app, buffer } = makeApp({ scopes: ['ui'] });
    const res = await post(app, { entries: [ENTRY] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pending: 1 });
    expect(buffer.drain('p1')[0]?.message).toContain('addColorStop');
  });

  it('rejects session-scoped tokens (prompt-injection channel)', async () => {
    const { app, buffer } = makeApp({ scopes: ['session'] });
    const res = await post(app, { entries: [ENTRY] });
    expect(res.status).toBe(403);
    expect(buffer.pendingCount('p1')).toBe(0);
  });

  it('404s for an unknown project', async () => {
    const { app } = makeApp({ scopes: ['ui'], projectExists: false });
    expect((await post(app, { entries: [ENTRY] })).status).toBe(404);
  });
});
