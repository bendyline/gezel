import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { opaqueServerErrors } from './server.js';

describe('opaqueServerErrors', () => {
  it('replaces route-caught exception details with a correlation id', async () => {
    const messages: string[] = [];
    const events: Parameters<NonNullable<Parameters<typeof opaqueServerErrors>[1]>>[0][] = [];
    const app = new Hono();
    app.use(
      '*',
      opaqueServerErrors({ error: (message) => messages.push(message) }, (event) =>
        events.push(event),
      ),
    );
    app.get('/boom', (c) => c.json({ error: 'C:\\Users\\alice\\secret.txt ENOENT' }, 500));
    const response = await app.request('/boom');
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('alice');
    expect(messages[0]).toContain('alice');
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'unsanitized_response',
        method: 'GET',
        path: '/boom',
        status: 500,
        detail: expect.stringContaining('alice'),
      }),
    ]);
  });

  it('does not alter actionable client errors', async () => {
    const app = new Hono();
    app.use('*', opaqueServerErrors({ error: () => {} }));
    app.get('/bad', (c) => c.json({ error: 'missing field' }, 400));
    const response = await app.request('/bad');
    expect(await response.json()).toEqual({ error: 'missing field' });
  });

  it('preserves the server-error status while hiding its body', async () => {
    const app = new Hono();
    app.use('*', opaqueServerErrors({ error: () => {} }));
    app.get('/upstream', (c) => c.json({ error: 'provider secret detail' }, 502));
    const response = await app.request('/upstream');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'internal_error' });
  });

  it('adds the request-id header to an already-sanitized internal error', async () => {
    const app = new Hono();
    app.use('*', opaqueServerErrors({ error: () => {} }));
    app.get('/already-opaque', (c) =>
      c.json({ error: 'internal_error', requestId: 'req-already-opaque' }, 500),
    );

    const response = await app.request('/already-opaque');

    expect(response.headers.get('x-request-id')).toBe('req-already-opaque');
    expect(await response.json()).toEqual({
      error: 'internal_error',
      requestId: 'req-already-opaque',
    });
  });

  it('preserves the fixed machine-engine outage code without leaking details', async () => {
    const app = new Hono();
    app.use('*', opaqueServerErrors({ error: () => {} }));
    app.get('/engine', (c) => c.json({ error: 'machine_engine_unavailable' }, 503));
    const response = await app.request('/engine');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'machine_engine_unavailable' });
  });

  it('preserves the fixed capacity-denial code without leaking model details', async () => {
    const app = new Hono();
    app.use('*', opaqueServerErrors({ error: () => {} }));
    app.get('/capacity', (c) => c.json({ error: 'capacity_denied' }, 503));
    const response = await app.request('/capacity');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'capacity_denied' });
  });
});
