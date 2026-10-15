import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { sessionRoutes } from './sessions.js';

function context() {
  const getGezel = vi.fn(async (id: string) => (id === 'ship-tester' ? { id } : null));
  const createSession = vi.fn(async (body: { gezelId: string }) => ({
    id: 'session-1',
    gezelId: body.gezelId,
  }));
  return {
    getGezel,
    createSession,
    ctx: {
      chat: { createSession },
      store: { getGezel },
    } as unknown as ServiceContext,
  };
}

function post(app: ReturnType<typeof sessionRoutes>, gezelId: string) {
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gezelId }),
  });
}

describe('POST /api/sessions', () => {
  it('answers 400, not 500, for a display name sent as a gezel id', async () => {
    const fixture = context();
    const response = await post(sessionRoutes(fixture.ctx), 'Ship Tester');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_entity_id' });
    expect(fixture.createSession).not.toHaveBeenCalled();
  });

  it('answers 404 for a gezel that does not exist', async () => {
    const fixture = context();
    const response = await post(sessionRoutes(fixture.ctx), 'nobody');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'gezel_not_found' });
    expect(fixture.createSession).not.toHaveBeenCalled();
  });

  it('creates the session for an existing gezel', async () => {
    const fixture = context();
    const response = await post(sessionRoutes(fixture.ctx), 'ship-tester');

    expect(response.status).toBe(201);
    expect(fixture.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ gezelId: 'ship-tester' }),
    );
  });
});
