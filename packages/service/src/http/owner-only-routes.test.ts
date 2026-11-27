import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ServiceContext } from './context.js';
import { lookoutRoutes, projectLookoutRoutes } from './routes/lookouts.js';
import { projectRoutes } from './routes/projects.js';

/**
 * Lookouts act on the person's behalf (an alert, a sound, an action), and an
 * app update may replace an edited script or write into an ungranted folder.
 * The session guard already keeps gezels off these routes; each handler also
 * answers `owner_only` itself, so a principal the guard does not know about
 * (an outside app's token, a future token kind) is refused at the route too.
 * These run the routers with the guards absent, which is exactly the case the
 * second check exists for.
 */

const NOT_OWNERS: Array<{ name: string; auth: Record<string, unknown> }> = [
  {
    name: 'a gezel session',
    auth: {
      appId: 'session:s1',
      scopes: ['session'],
      projectId: 'p1',
      gezelId: 'gz-1',
      team: true,
    },
  },
  {
    name: 'an outside app’s tools token',
    auth: { appId: 'harness:claude-code:p1', scopes: ['harness'], projectId: 'p1' },
  },
];

const ROUTES: Array<[method: string, path: string]> = [
  ['POST', '/api/projects/p1/lookouts'],
  ['PUT', '/api/projects/p1/lookouts/l1'],
  ['DELETE', '/api/projects/p1/lookouts/l1'],
  ['POST', '/api/projects/p1/lookouts/l1/approve'],
  ['POST', '/api/projects/p1/lookouts/l1/test'],
  ['POST', '/api/projects/p1/lookouts/l1/snooze'],
  ['POST', '/api/projects/p1/lookouts/firings/f1/feedback'],
  ['POST', '/api/lookouts/stop-sound'],
  ['GET', '/api/lookouts/recent-alerts'],
  ['POST', '/api/projects/p1/project-type/upgrade'],
];

function appFor(auth: Record<string, unknown>) {
  // Nothing behind the routes: a handler that passed its owner check would
  // fail on the empty context, which the assertions tell apart from a 403.
  const ctx = new Proxy({}, { get: () => undefined }) as ServiceContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await next();
  });
  app.route('/api/projects', projectLookoutRoutes(ctx));
  app.route('/api/projects', projectRoutes(ctx));
  app.route('/api/lookouts', lookoutRoutes(ctx));
  app.onError((_err, c) => c.json({ error: 'reached the handler' }, 500));
  return app;
}

describe('owner-only lookout and app-update routes', () => {
  for (const caller of NOT_OWNERS) {
    it.each(ROUTES)(`refuses ${caller.name}: %s %s`, async (method, path) => {
      const res = await appFor(caller.auth).request(path, {
        method,
        ...(method === 'GET' || method === 'DELETE'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('owner_only');
    });
  }

  it.each(ROUTES)(
    'lets an approved app (cli) through the owner check: %s %s',
    async (method, path) => {
      const res = await appFor({ appId: 'cli:1', scopes: ['cli'] }).request(path, {
        method,
        ...(method === 'GET' || method === 'DELETE'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      });
      expect(res.status).not.toBe(403);
    },
  );
});
