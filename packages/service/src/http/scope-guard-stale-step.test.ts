import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { type StaleStepSessionLookup, sessionRouteGuard } from './scope-guard.js';

type Auth = {
  appId: string;
  scopes: readonly string[];
  projectId?: string;
  gezelId?: string;
  team?: boolean;
};

const STALE =
  "Your step `evaluate` is no longer the active step on proj-a/1 — the task is now on `collect`. Don't change the task — end your turn.";

function appWith(auth: Auth, staleStepSession?: StaleStepSessionLookup) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.use(
    '/api/*',
    sessionRouteGuard({
      isUserDirectedTurn: () => true,
      taskStatus: async () => 'active',
      ...(staleStepSession ? { staleStepSession } : {}),
    }),
  );
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

const session = (team = false): Auth => ({
  appId: 'session:sess-reviewer',
  scopes: ['session'],
  projectId: 'proj-a',
  gezelId: 'rusudan',
  team,
});

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const STATUS = '/api/projects/proj-a/tasks/1/status';
const ADVANCE = '/api/projects/proj-a/tasks/1/steps/evaluate/complete';

describe('sessionRouteGuard — stale task-step sessions', () => {
  it('refuses status changes and step advances from a session whose pass is over', async () => {
    const lookup = vi.fn<StaleStepSessionLookup>(async () => STALE);
    // A coordinator token gets no pass either: the binding decides, not the
    // role. Its own unbound sessions never produce a refusal.
    for (const team of [false, true]) {
      const app = appWith(session(team), lookup);
      for (const status of ['paused', 'active', 'complete', 'canceled']) {
        const res = await app.request(STATUS, post({ status }));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'stale_task_step', hint: STALE });
      }
      const advance = await app.request(ADVANCE, post({}));
      expect(advance.status).toBe(403);
      expect(await advance.json()).toEqual({ error: 'stale_task_step', hint: STALE });
    }
    expect(lookup).toHaveBeenCalledWith('sess-reviewer', 'proj-a', 1);
  });

  it("keeps today's behavior for the current pass, unbound sessions, and other routes", async () => {
    const current = appWith(session(), async () => null);
    expect((await current.request(STATUS, post({ status: 'paused' }))).status).toBe(200);
    expect((await current.request(ADVANCE, post({}))).status).toBe(200);

    const stale = appWith(session(), async () => STALE);
    // Notes stay open: recording the blocker is the honest exit.
    expect(
      (
        await stale.request('/api/projects/proj-a/tasks/1/notes', {
          ...post({ text: 'blocked' }),
          headers: { 'content-type': 'application/json', 'x-gezel-actor': 'rusudan' },
        })
      ).status,
    ).toBe(200);
    expect((await stale.request('/api/projects/proj-a/tasks/1')).status).toBe(200);
    // A num the route itself rejects is not looked up.
    expect((await stale.request('/api/projects/proj-a/tasks/01/status', post({}))).status).toBe(
      200,
    );
  });

  it('fails open when the lookup is missing or throws', async () => {
    const unwired = appWith(session());
    expect((await unwired.request(STATUS, post({ status: 'paused' }))).status).toBe(200);
    const failing = appWith(session(), async () => {
      throw new Error('disk');
    });
    expect((await failing.request(STATUS, post({ status: 'paused' }))).status).toBe(200);
  });

  it('never consults the lookup for first-party clients', async () => {
    const lookup = vi.fn<StaleStepSessionLookup>(async () => STALE);
    const ui = appWith({ appId: 'desktop-client', scopes: ['ui'] }, lookup);
    expect((await ui.request(STATUS, post({ status: 'paused' }))).status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });
});
