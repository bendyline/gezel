import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  type TokenScopeMode,
  gezelScopeGuard,
  isTeamRoute,
  projectIdFromPath,
  projectScopeGuard,
  resolveIdentityScopeMode,
  resolveTeamScopeMode,
  resolveTokenScopeMode,
  sessionRouteGuard,
  teamRouteGuard,
} from './scope-guard.js';

type Auth = {
  appId: string;
  scopes: readonly string[];
  projectId?: string;
  gezelId?: string;
  team?: boolean;
};

function appWith(
  auth: Auth | null,
  mode: TokenScopeMode = 'enforce',
  log?: (m: string) => void,
  isProjectLinked?: (source: string, target: string) => Promise<boolean>,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  app.use(
    '/api/projects/*',
    projectScopeGuard({
      mode,
      ...(log ? { log } : {}),
      ...(isProjectLinked ? { isProjectLinked } : {}),
    }),
  );
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

const session = (projectId: string, team = false): Auth => ({
  appId: `session:${projectId}`,
  scopes: ['session'],
  projectId,
  gezelId: 'gz-1',
  team,
});

describe('projectIdFromPath', () => {
  it('extracts the id from a project-item path', () => {
    expect(projectIdFromPath('/api/projects/abc/tools/fetch-url')).toBe('abc');
    expect(projectIdFromPath('/api/projects/abc')).toBe('abc');
    expect(projectIdFromPath('/api/projects/abc/')).toBe('abc');
  });
  it('returns null for the collection route', () => {
    expect(projectIdFromPath('/api/projects')).toBeNull();
    expect(projectIdFromPath('/api/projects/')).toBeNull();
    expect(projectIdFromPath('/api/gezels/abc')).toBeNull();
  });
});

describe('resolveTokenScopeMode', () => {
  it('defaults to enforce', () => {
    expect(resolveTokenScopeMode(undefined)).toBe('enforce');
    expect(resolveTokenScopeMode('')).toBe('enforce');
    expect(resolveTokenScopeMode('enforce')).toBe('enforce');
  });
  it('honors audit and off', () => {
    expect(resolveTokenScopeMode('audit')).toBe('audit');
    expect(resolveTokenScopeMode('off')).toBe('off');
  });
});

describe('projectScopeGuard', () => {
  it('lets an unscoped (root/ui/app) token reach any project', async () => {
    const app = appWith({ appId: 'root', scopes: ['root'] });
    expect((await app.request('/api/projects/anything/tools/x')).status).toBe(200);
  });

  it('lets a session token reach its OWN project', async () => {
    const app = appWith(session('proj-a'));
    expect((await app.request('/api/projects/proj-a/tools/fetch-url')).status).toBe(200);
  });

  it('denies a session token reaching a DIFFERENT project (403)', async () => {
    const app = appWith(session('proj-a'));
    const res = await app.request('/api/projects/proj-b/tools/fetch-url');
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('proj-a');
    expect(json.error).toContain('proj-b');
  });

  it('admits only file routes on an explicitly linked project', async () => {
    const linked = vi.fn(
      async (source: string, target: string) => source === 'proj-a' && target === 'proj-b',
    );
    const app = appWith(session('proj-a'), 'enforce', undefined, linked);
    const headers = { 'x-gezel-linked-from': 'proj-a' };
    expect(
      (await app.request('/api/projects/proj-b/workspace/read?path=x', { headers })).status,
    ).toBe(200);
    expect((await app.request('/api/projects/proj-b/tasks/1', { headers })).status).toBe(403);
    expect((await app.request('/api/projects/proj-b/workspace/read?path=x')).status).toBe(403);
    expect(linked).toHaveBeenCalledWith('proj-a', 'proj-b');
  });

  it('lets a TEAM (coordinator) session reach any project', async () => {
    const app = appWith(session('proj-a', true));
    expect((await app.request('/api/projects/proj-b/tools/x')).status).toBe(200);
  });

  it('audit mode logs WOULD-DENY but allows the call through', async () => {
    const log = vi.fn();
    const app = appWith(session('proj-a'), 'audit', log);
    expect((await app.request('/api/projects/proj-b/tools/x')).status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('WOULD-DENY');
  });

  it('off mode skips the guard entirely', async () => {
    const log = vi.fn();
    const app = appWith(session('proj-a'), 'off', log);
    expect((await app.request('/api/projects/proj-b/tools/x')).status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  });

  it('does not guard the project collection route', async () => {
    // `/api/projects` (no id segment) isn't a project-item route.
    const app = appWith(session('proj-a'));
    expect((await app.request('/api/projects')).status).toBe(200);
  });
});

function teamApp(auth: Auth | null, mode: TokenScopeMode = 'enforce', log?: (m: string) => void) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  app.use('/api/*', teamRouteGuard({ mode, ...(log ? { log } : {}) }));
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

describe('resolveTeamScopeMode', () => {
  it('defaults to enforce', () => {
    expect(resolveTeamScopeMode(undefined)).toBe('enforce');
    expect(resolveTeamScopeMode('')).toBe('enforce');
    expect(resolveTeamScopeMode('enforce')).toBe('enforce');
  });
  it('honors audit and off', () => {
    expect(resolveTeamScopeMode('audit')).toBe('audit');
    expect(resolveTeamScopeMode('off')).toBe('off');
  });
});

describe('isTeamRoute', () => {
  it('matches orchestration routes (method-specific)', () => {
    expect(isTeamRoute('POST', '/api/gezels')).toBe(true);
    expect(isTeamRoute('DELETE', '/api/gezels/gz-9')).toBe(true);
    expect(isTeamRoute('POST', '/api/gezels/ensure')).toBe(true);
    expect(isTeamRoute('POST', '/api/gezels/gz-9/message')).toBe(true);
    expect(isTeamRoute('PUT', '/api/gezels/gz-9/about')).toBe(true);
    expect(isTeamRoute('POST', '/api/asks/request-and-wait')).toBe(true);
    expect(isTeamRoute('POST', '/api/projects')).toBe(true);
    expect(isTeamRoute('PUT', '/api/projects/proj-a')).toBe(true);
    expect(isTeamRoute('DELETE', '/api/projects/proj-a')).toBe(true);
    expect(isTeamRoute('POST', '/api/projects/proj-a/gezels')).toBe(true);
    expect(isTeamRoute('DELETE', '/api/projects/proj-a/gezels/gz-9')).toBe(true);
    expect(isTeamRoute('POST', '/api/projects/proj-a/tasks')).toBe(true);
    expect(isTeamRoute('POST', '/api/projects/proj-a/tasks/3/spawn')).toBe(true);
    expect(isTeamRoute('GET', '/api/tasks')).toBe(true);
  });

  it('does NOT match worker-self / read routes', () => {
    // Reads of own gezel/project.
    expect(isTeamRoute('GET', '/api/gezels/gz-9')).toBe(false);
    expect(isTeamRoute('GET', '/api/gezels/gz-9/growth')).toBe(false);
    expect(isTeamRoute('GET', '/api/projects/proj-a')).toBe(false);
    expect(isTeamRoute('GET', '/api/projects/proj-a/gezels')).toBe(false);
    // Task READS + worker progress writes (notes / status / steps).
    expect(isTeamRoute('GET', '/api/projects/proj-a/tasks')).toBe(false);
    expect(isTeamRoute('GET', '/api/projects/proj-a/tasks/3')).toBe(false);
    expect(isTeamRoute('POST', '/api/projects/proj-a/tasks/3/notes')).toBe(false);
    expect(isTeamRoute('POST', '/api/projects/proj-a/tasks/3/status')).toBe(false);
    expect(isTeamRoute('POST', '/api/projects/proj-a/tasks/3/steps/s1/complete')).toBe(false);
    // Misc worker-safe surfaces.
    expect(isTeamRoute('GET', '/api/config')).toBe(false);
    expect(isTeamRoute('POST', '/api/memory/save')).toBe(false);
    // The project-item file/tool routes (guarded by the project guard, not here).
    expect(isTeamRoute('POST', '/api/projects/proj-a/tools/fetch-url')).toBe(false);
    expect(isTeamRoute('PUT', '/api/projects/proj-a/workspace/file')).toBe(false);
    expect(isTeamRoute('PUT', '/api/projects/proj-a/workspace/raw')).toBe(false);
  });
});

describe('teamRouteGuard', () => {
  it('denies a worker session a team route (enforce → 403)', async () => {
    const app = teamApp(session('proj-a'));
    expect((await app.request('/api/gezels', { method: 'POST' })).status).toBe(403);
  });

  it('lets a worker session reach its own non-team routes', async () => {
    const app = teamApp(session('proj-a'));
    expect((await app.request('/api/gezels/gz-1')).status).toBe(200); // GET own gezel
    expect((await app.request('/api/projects/proj-a/tasks')).status).toBe(200); // list tasks
  });

  it('lets a TEAM (coordinator) session reach team routes', async () => {
    const app = teamApp(session('proj-a', true));
    expect((await app.request('/api/gezels', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/asks/request-and-wait', { method: 'POST' })).status).toBe(200);
  });

  it('lets an unscoped (root/ui/app) token reach team routes', async () => {
    const app = teamApp({ appId: 'root', scopes: ['root'] });
    expect((await app.request('/api/gezels', { method: 'POST' })).status).toBe(200);
  });

  it('audit mode logs WOULD-DENY but allows the call through', async () => {
    const log = vi.fn();
    const app = teamApp(session('proj-a'), 'audit', log);
    expect((await app.request('/api/gezels', { method: 'POST' })).status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('WOULD-DENY');
  });

  it('off mode skips the guard entirely', async () => {
    const log = vi.fn();
    const app = teamApp(session('proj-a'), 'off', log);
    expect((await app.request('/api/gezels', { method: 'POST' })).status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  });
});

function gezelApp(auth: Auth | null, mode: TokenScopeMode = 'enforce', log?: (m: string) => void) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  app.use('/api/*', gezelScopeGuard({ mode, ...(log ? { log } : {}) }));
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('resolveIdentityScopeMode', () => {
  it('defaults to enforce and honors audit/off', () => {
    expect(resolveIdentityScopeMode(undefined)).toBe('enforce');
    expect(resolveIdentityScopeMode('enforce')).toBe('enforce');
    expect(resolveIdentityScopeMode('audit')).toBe('audit');
    expect(resolveIdentityScopeMode('off')).toBe('off');
  });
});

describe('gezelScopeGuard', () => {
  // session('x') sets gezelId='gz-1'.
  it('lets a worker reach its OWN gezel routes (path)', async () => {
    const app = gezelApp(session('proj-a'));
    expect((await app.request('/api/gezels/gz-1')).status).toBe(200);
    expect((await app.request('/api/gezels/gz-1/growth')).status).toBe(200);
  });

  it('denies a worker another gezel via the path (403)', async () => {
    const app = gezelApp(session('proj-a'));
    const res = await app.request('/api/gezels/gz-other/growth');
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('gz-1');
    expect(json.error).toContain('gz-other');
  });

  it('leaves /api/gezels/:id/message to the team guard (not gezel-checked)', async () => {
    // `:id` there is a recipient, not the caller's identity.
    const app = gezelApp(session('proj-a'));
    expect((await app.request('/api/gezels/gz-other/message', { method: 'POST' })).status).toBe(
      200,
    );
  });

  it('denies a worker another gezel via a query param', async () => {
    const app = gezelApp(session('proj-a'));
    expect((await app.request('/api/sessions?gezel=gz-other')).status).toBe(403);
    expect((await app.request('/api/sessions?gezel=gz-1')).status).toBe(200);
    expect((await app.request('/api/sessions')).status).toBe(200); // no gezel filter
    expect((await app.request('/api/timeline?gezel=gz-other')).status).toBe(403);
  });

  it('denies a worker another gezel via the JSON body (memory)', async () => {
    const app = gezelApp(session('proj-a'));
    expect(
      (await app.request('/api/memory/search', jsonPost({ gezelId: 'gz-other' }))).status,
    ).toBe(403);
    expect((await app.request('/api/memory/search', jsonPost({ gezelId: 'gz-1' }))).status).toBe(
      200,
    );
    // save: scope='gezel' → id is a gezelId; scope='project' → not gezel-checked.
    expect(
      (await app.request('/api/memory/save', jsonPost({ scope: 'gezel', id: 'gz-other' }))).status,
    ).toBe(403);
    expect(
      (await app.request('/api/memory/save', jsonPost({ scope: 'project', id: 'proj-a' }))).status,
    ).toBe(200);
  });

  it('lets a TEAM (coordinator) session reach any gezel', async () => {
    const app = gezelApp(session('proj-a', true));
    expect((await app.request('/api/gezels/gz-other/growth')).status).toBe(200);
    expect(
      (await app.request('/api/memory/search', jsonPost({ gezelId: 'gz-other' }))).status,
    ).toBe(200);
  });

  it('lets an unscoped (root/ui) token reach any gezel', async () => {
    const app = gezelApp({ appId: 'root', scopes: ['root'] });
    expect((await app.request('/api/gezels/gz-other/growth')).status).toBe(200);
  });

  it('audit mode logs WOULD-DENY but allows the call through', async () => {
    const log = vi.fn();
    const app = gezelApp(session('proj-a'), 'audit', log);
    expect((await app.request('/api/gezels/gz-other')).status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('WOULD-DENY');
  });

  it('off mode skips the guard entirely', async () => {
    const log = vi.fn();
    const app = gezelApp(session('proj-a'), 'off', log);
    expect((await app.request('/api/gezels/gz-other')).status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  });
});

function sessionPolicyApp(
  auth: Auth | null,
  isProjectLinked?: (source: string, target: string) => Promise<boolean>,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  const guard = sessionRouteGuard({ ...(isProjectLinked ? { isProjectLinked } : {}) });
  app.use('/api/*', guard);
  app.use('/events/*', guard);
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

describe('sessionRouteGuard', () => {
  it('preserves root/ui behavior', async () => {
    const root = sessionPolicyApp({ appId: 'root', scopes: ['root'] });
    const ui = sessionPolicyApp({ appId: 'desktop-client', scopes: ['ui'] });
    expect((await root.request('/api/config')).status).toBe(200);
    expect((await ui.request('/api/sessions/other/debug')).status).toBe(200);
    expect((await ui.request('/events/chat/all')).status).toBe(200);
  });

  it('allows the own-project MCP surface and denies foreign projects', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    expect((await app.request('/api/projects/proj-a/workspace')).status).toBe(200);
    expect((await app.request('/api/projects/proj-a/tasks/1')).status).toBe(200);
    expect((await app.request('/api/projects/proj-b/workspace')).status).toBe(403);
  });

  it('allows linked workspace CRUD without opening other target-project capabilities', async () => {
    const app = sessionPolicyApp(
      session('proj-a'),
      async (source, target) => source === 'proj-a' && target === 'proj-b',
    );
    const headers = { 'x-gezel-linked-from': 'proj-a' };
    expect((await app.request('/api/projects/proj-b/workspace', { headers })).status).toBe(200);
    expect(
      (
        await app.request('/api/projects/proj-b/workspace/file', {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            path: 'x.txt',
            content: 'x',
            gezelId: 'gz-1',
            sessionId: 'proj-a',
          }),
        })
      ).status,
    ).toBe(200);
    expect((await app.request('/api/projects/proj-b/artifacts', { headers })).status).toBe(403);
    expect((await app.request('/api/projects/proj-b/tasks/1', { headers })).status).toBe(403);
    expect((await app.request('/api/projects/proj-b', { headers })).status).toBe(403);
  });

  it('lets coordinator sessions cross projects but still blocks UI/admin capabilities', async () => {
    const app = sessionPolicyApp(session('proj-a', true));
    expect((await app.request('/api/projects/proj-b/workspace')).status).toBe(200);
    expect((await app.request('/api/projects/proj-b', { method: 'DELETE' })).status).toBe(403);
    expect((await app.request('/api/config')).status).toBe(403);
    expect((await app.request('/api/projects/proj-a/terminals')).status).toBe(403);
    expect(
      (await app.request('/api/projects/proj-a/preview-capability', jsonPost({}))).status,
    ).toBe(403);
    expect((await app.request('/api/sessions/anything')).status).toBe(403);
    expect((await app.request('/events/chat/all')).status).toBe(403);
  });

  it('does not misclassify project collection UI routes as team-accessible project ids', async () => {
    const app = sessionPolicyApp(session('proj-a', true));
    expect(
      (await app.request('/api/projects/preview-folder', jsonPost({ path: 'C:\\' }))).status,
    ).toBe(403);
    expect((await app.request('/api/projects/preview-about', jsonPost({}))).status).toBe(403);
    expect((await app.request('/api/projects/poisoned')).status).toBe(403);
  });

  it('protects raw sessions, event streams, terminals, and unclassified admin routes', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    expect((await app.request('/api/sessions')).status).toBe(403);
    expect((await app.request('/api/sessions/other/debug')).status).toBe(403);
    expect((await app.request('/api/sessions/other/tools')).status).toBe(403);
    expect((await app.request('/events/chat/project?project=proj-a')).status).toBe(403);
    expect((await app.request('/api/projects/proj-a/terminals/run', jsonPost({}))).status).toBe(
      403,
    );
    expect((await app.request('/api/engines/status')).status).toBe(403);
  });

  it('keeps shared documents available without the foreign-project fallback', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    expect((await app.request('/api/documents/read?path=guidelines%2Fcoding.md')).status).toBe(200);
    expect(
      (await app.request('/api/documents/read?path=projects%2Fproj-b%2Fartifacts%2Fsecret.md'))
        .status,
    ).toBe(403);
  });

  it('binds project-local craftbook selectors while preserving shared templates', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    expect((await app.request('/api/craftbooks?source=local')).status).toBe(200);
    expect((await app.request('/api/craftbooks?source=project&projectId=proj-a')).status).toBe(200);
    expect((await app.request('/api/craftbooks?source=project&projectId=proj-b')).status).toBe(403);
    expect((await app.request('/api/craftbooks/book/document?projectId=proj-b')).status).toBe(403);
    expect(
      (
        await app.request(
          '/api/craftbooks/suggest',
          jsonPost({ query: 'review', projectId: 'proj-b' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          '/api/craftbooks/document',
          jsonPost({ content: '{}', format: 'json', projectId: 'proj-b' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/craftbooks/book/document', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: '{}', format: 'json', projectId: 'proj-a' }),
        })
      ).status,
    ).toBe(200);

    const coordinator = sessionPolicyApp(session('proj-a', true));
    expect(
      (await coordinator.request('/api/craftbooks?source=project&projectId=proj-b')).status,
    ).toBe(200);
  });

  it('keeps composer-only roster selectors and non-canonical paths off session tokens', async () => {
    const worker = sessionPolicyApp(session('proj-a'));
    const coordinator = sessionPolicyApp(session('proj-a', true));
    expect((await worker.request('/api/gezels/mention-candidates?project=proj-b')).status).toBe(
      403,
    );
    expect(
      (await coordinator.request('/api/gezels/mention-candidates?project=proj-b')).status,
    ).toBe(403);
    expect((await coordinator.request('/api/projects/proj-a//terminals/run')).status).toBe(403);
    expect((await worker.request('/api/projects/proj-a/%74erminals/run')).status).toBe(403);
    expect((await worker.request('/api/projects/proj-a/workspace/../terminals/run')).status).toBe(
      403,
    );
  });

  it('binds memory, history, and transcript search to the session identity', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    expect(
      (
        await app.request(
          '/api/memory/search',
          jsonPost({ projectId: 'proj-a', gezelId: 'gz-1', query: 'x' }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/api/memory/search',
          jsonPost({ projectId: 'proj-b', gezelId: 'gz-1', query: 'x' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/memory/day?scope=project&id=proj-a&day=2026-08-04', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'edited' }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request('/api/history?project=proj-a&gezel=gz-1')).status).toBe(200);
    expect((await app.request('/api/history?project=proj-a')).status).toBe(403);
    expect((await app.request('/api/sessions/search?q=x&project=proj-a&gezel=gz-1')).status).toBe(
      200,
    );
    expect((await app.request('/api/sessions/search?q=x&project=proj-b&gezel=gz-1')).status).toBe(
      403,
    );
  });

  it('binds question, permission, ask, and message origins to the live session', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    const own = { projectId: 'proj-a', gezelId: 'gz-1', sessionId: 'proj-a' };
    expect((await app.request('/api/questions', jsonPost(own))).status).toBe(200);
    expect((await app.request('/api/permissions/request-and-wait', jsonPost(own))).status).toBe(
      200,
    );
    expect(
      (
        await app.request(
          '/api/asks/request-and-wait',
          jsonPost({ projectId: 'proj-a', fromGezelId: 'gz-1', fromSessionId: 'proj-a' }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/api/gezels/gz-2/message',
          jsonPost({ projectId: 'proj-a', fromGezelId: 'gz-1', fromSessionId: 'proj-a' }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/api/questions',
          jsonPost({ ...own, projectId: 'proj-b', sessionId: 'other' }),
        )
      ).status,
    ).toBe(403);
  });

  it('binds generic project search private memory to the current gezel', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    expect(
      (
        await app.request(
          '/api/projects/proj-a/tools/search',
          jsonPost({ query: 'vehicle physics', gezelId: 'gz-1' }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/api/projects/proj-a/tools/search',
          jsonPost({ query: 'vehicle physics', gezelId: 'gz-2' }),
        )
      ).status,
    ).toBe(403);
    // Omitting the gezel id intentionally disables private-memory search and
    // remains safe for non-MCP callers.
    expect(
      (
        await app.request(
          '/api/projects/proj-a/tools/search',
          jsonPost({ query: 'vehicle physics' }),
        )
      ).status,
    ).toBe(200);
  });

  it('admits only coordinator, project-scoped craftbook toolset installs and requests', async () => {
    const worker = sessionPolicyApp(session('proj-a'));
    const coordinator = sessionPolicyApp(session('proj-a', true));
    const install = { scope: { kind: 'project', projectId: 'proj-b' } };
    expect(
      (await coordinator.request('/api/catalog/toolset/docblocks/install', jsonPost(install)))
        .status,
    ).toBe(200);
    expect(
      (await worker.request('/api/catalog/toolset/docblocks/install', jsonPost(install))).status,
    ).toBe(403);
    expect(
      (
        await coordinator.request(
          '/api/catalog/toolset/docblocks/install',
          jsonPost({ scope: { kind: 'shared' } }),
        )
      ).status,
    ).toBe(403);

    const request = {
      ...install,
      gezelId: 'gz-1',
      sessionId: 'proj-a',
      sourceId: 'bundled',
      version: '1.0.0',
      craftbookId: 'powerpoint-deck',
    };
    expect(
      (
        await coordinator.request(
          '/api/catalog/toolset/example/request-install-and-wait',
          jsonPost(request),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await coordinator.request(
          '/api/catalog/toolset/example/request-install-and-wait',
          jsonPost({ ...request, sessionId: 'other' }),
        )
      ).status,
    ).toBe(403);
  });

  it('binds project action attribution and task-note authorship to the bearer identity', async () => {
    const app = sessionPolicyApp(session('proj-a'));
    const ownWrite = {
      path: 'out.txt',
      content: 'ok',
      gezelId: 'gz-1',
      sessionId: 'proj-a',
    };
    expect(
      (
        await app.request('/api/projects/proj-a/workspace/file', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ownWrite),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/api/projects/proj-a/workspace/file', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...ownWrite, gezelId: 'gz-other' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/projects/proj-a/workspace/file', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'out.txt', content: 'missing attribution' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          '/api/projects/proj-a/workspace/path?path=out.txt&gezelId=gz-1&sessionId=proj-a',
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/api/projects/proj-a/workspace/path?path=out.txt&gezelId=gz-other&sessionId=proj-a',
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await app.request('/api/projects/proj-a/tasks/1/notes', {
          ...jsonPost({ text: 'note' }),
          headers: { 'content-type': 'application/json', 'x-gezel-actor': 'gz-1' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/api/projects/proj-a/tasks/1/notes', {
          ...jsonPost({ text: 'forged note' }),
          headers: { 'content-type': 'application/json', 'x-gezel-actor': 'gz-other' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/api/projects/proj-a/tasks/1/notes/2', { method: 'DELETE' })).status,
    ).toBe(403);
  });
});
