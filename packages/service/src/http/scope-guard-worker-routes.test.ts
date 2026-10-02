import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  gezelScopeGuard,
  projectScopeGuard,
  sessionRouteGuard,
  teamRouteGuard,
} from './scope-guard.js';

/**
 * Worker-facing routes where the session guards used to disagree with each
 * other or with the tool kit that sends the request. Each request goes
 * through all four guards in server.ts order, so a 200 here is a 200 for a
 * real session token.
 */

const PROJECT = 'proj-a';
const GEZEL = 'gz-1';
const SESSION = 'sess-1';

function stack(team: boolean, onDeny?: (line: string) => void) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      appId: `session:${SESSION}`,
      scopes: ['session'],
      projectId: PROJECT,
      gezelId: GEZEL,
      team,
    } as never);
    await next();
  });
  app.use('/api/*', sessionRouteGuard({ ...(onDeny ? { log: onDeny } : {}) }));
  app.use('/api/projects/*', projectScopeGuard({ mode: 'enforce' }));
  app.use('/api/*', teamRouteGuard({ mode: 'enforce' }));
  app.use('/api/*', gezelScopeGuard({ mode: 'enforce' }));
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const ORIGIN = { projectId: PROJECT, fromGezelId: GEZEL, fromSessionId: SESSION };

describe('how_do_i reaches the Handboek from every session', () => {
  // The `handboek` group is in every role's kit; its one route was on no
  // session allowlist, so the tool 403'd for coordinator and worker alike.
  for (const team of [false, true]) {
    it(`${team ? 'coordinator' : 'worker'} may ask the Handboek`, async () => {
      const res = await stack(team).request('/api/handboek/how-do-i?q=change%20a%20model');
      expect(res.status).toBe(200);
    });
  }

  it('admits only the question route, not the rest of the Handboek API', async () => {
    const app = stack(true);
    for (const path of [
      '/api/handboek/toc',
      '/api/handboek/article/role/meester',
      '/api/handboek/narration/article/role/meester',
      `/api/handboek/narration/audio/${'a'.repeat(64)}`,
    ]) {
      expect((await app.request(path)).status, path).toBe(403);
    }
    expect((await app.request('/api/handboek/how-do-i?q=x', post({}))).status).toBe(403);
  });
});

describe('the session guard and the team guard agree on gezel-to-gezel routes', () => {
  // `sessionRouteGuard` admitted a same-project worker that `teamRouteGuard`
  // then refused. The security model is that a worker never messages, asks,
  // or ensures another gezel, so the session guard now refuses it itself.
  const routes: Array<[string, RequestInit]> = [
    ['/api/gezels/gz-2/message', post(ORIGIN)],
    ['/api/asks/request-and-wait', post(ORIGIN)],
    ['/api/gezels/ensure', post({ role: 'reviewer' })],
  ];

  for (const [path, init] of routes) {
    it(`a worker is refused ${path} by the session guard, with its reason`, async () => {
      const denials: string[] = [];
      const res = await stack(false, (line) => denials.push(line)).request(path, init);
      expect(res.status).toBe(403);
      expect(denials.join('\n')).toMatch(/requires a coordinator session/);
    });

    it(`a coordinator with its own origin is admitted to ${path}`, async () => {
      expect((await stack(true).request(path, init)).status).toBe(200);
    });
  }

  it('a coordinator still cannot speak for another session', async () => {
    const app = stack(true);
    const forged = { ...ORIGIN, fromSessionId: 'someone-else' };
    expect((await app.request('/api/gezels/gz-2/message', post(forged))).status).toBe(403);
    expect((await app.request('/api/asks/request-and-wait', post(forged))).status).toBe(403);
  });
});

describe('list_tasks for a worker', () => {
  it('the install-wide listing stays coordinator-only', async () => {
    expect((await stack(false).request('/api/tasks')).status).toBe(403);
    expect((await stack(true).request('/api/tasks')).status).toBe(200);
  });

  it('the own-project listing the tool falls back to is open to a worker', async () => {
    const app = stack(false);
    expect((await app.request(`/api/projects/${PROJECT}/tasks?status=active`)).status).toBe(200);
    expect((await app.request('/api/projects/proj-b/tasks')).status).toBe(403);
  });
});
