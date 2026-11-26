import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadMolenStage, useMolenStageForTests } from '../../molen/documents.js';
import { molenRoutes } from './molen.js';

// @bendyline/molen-stage is optional until its first npm release (pnpm link:molen).
const installed = (await loadMolenStage()) !== null;

function makeApp(project: unknown = { id: 'p1' }): Hono {
  const ctx = {
    store: { getProject: async () => project },
  } as unknown as Parameters<typeof molenRoutes>[0];
  const app = new Hono();
  app.route('/api/projects', molenRoutes(ctx));
  return app;
}

function post(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request('/api/projects/p1/molen/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /:id/molen/check', () => {
  it.runIf(installed)('checks the document it is given and reads no file', async () => {
    const res = await post(makeApp(), {
      document: '{ "format": "molen/game@1", "name": "Cut',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; kind: string; issues: { code: string }[] };
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('game');
    expect(body.issues[0]?.code).toBe('invalid_json');
  });

  it('refuses a body that is not { document }', async () => {
    expect((await post(makeApp(), 'not json')).status).toBe(400);
  });

  it('answers 503 when this install cannot check Molen documents', async () => {
    const restore = useMolenStageForTests(null);
    try {
      const res = await post(makeApp(), { document: { format: 'molen/film@1' } });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain(
        'does not include @bendyline/molen-stage',
      );
    } finally {
      restore();
    }
  });

  it('answers 404 for a project that does not exist', async () => {
    expect((await post(makeApp(null), { document: {} })).status).toBe(404);
  });
});
