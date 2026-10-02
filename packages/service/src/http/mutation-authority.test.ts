import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { bearerAuth, requireInternalApiAccess } from './auth.js';
import type { ServiceContext } from './context.js';
import { gitRoutes } from './routes/git.js';
import { projectRoutes } from './routes/projects.js';
import {
  gezelScopeGuard,
  projectScopeGuard,
  sessionRouteGuard,
  teamRouteGuard,
} from './scope-guard.js';
import { createTokenStore } from './token-store.js';

describe('authenticated mutation authority', () => {
  let home: string;
  let store: Store;
  let app: Hono;
  let projectId: string;
  const discard = vi.fn(async () => ({ discarded: 1 }));
  const commit = vi.fn(async () => ({ sha: 'abc', filesChanged: 1 }));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mutation-authority-'));
    store = new Store({ home });
    await store.ensureLayout();
    const project = await store.createProject({ name: 'Authority' });
    projectId = project.id;
    await store.updateProject(projectId, {
      managedWorkspaceWritePolicy: 'deny',
      github: { url: 'https://github.com/example/fixture' },
    });
    const tokens = await createTokenStore({ home, rootToken: 'user' });
    for (const team of [false, true]) {
      tokens.issueSession({
        appId: `session:${team ? 'coordinator' : 'worker'}`,
        projectId,
        gezelId: 'worker',
        team,
        token: team ? 'coordinator' : 'worker',
      });
    }
    app = new Hono();
    app.use('/api/*', bearerAuth(tokens));
    app.use('/api/*', requireInternalApiAccess());
    app.use('/api/*', sessionRouteGuard());
    app.use('/api/*', projectScopeGuard({ mode: 'enforce' }));
    app.use('/api/*', teamRouteGuard({ mode: 'enforce' }));
    app.use('/api/*', gezelScopeGuard({ mode: 'enforce' }));
    const context = {
      home,
      store,
      git: { discardChanges: discard, commit },
    } as unknown as ServiceContext;
    app.route('/api/projects', projectRoutes(context));
    app.route('/api/projects', gitRoutes(context));
    app.route('/api/projects', gitRoutes(context, 'github'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function request(path: string, token: string, method: string, body?: unknown) {
    return app.request(`/api/projects/${projectId}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it.each(['worker', 'coordinator'])(
    'does not let %s omit its identity on raw writes',
    async (token) => {
      expect((await request('workspace/raw?path=blocked.txt', token, 'PUT', 'bytes')).status).toBe(
        403,
      );
      expect(await store.readProjectWorkspaceFile(projectId, 'blocked.txt')).toBeNull();
      expect(
        (await request('workspace/raw?path=blocked.txt', 'user', 'PUT', 'user bytes')).status,
      ).toBe(200);
      await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'allow' });
      expect((await request('workspace/raw?path=allowed.txt', token, 'PUT', 'bytes')).status).toBe(
        200,
      );
      expect(await store.readProjectWorkspaceFile(projectId, 'allowed.txt')).toBe(
        JSON.stringify('bytes'),
      );
    },
  );

  it.each(['worker', 'coordinator'])(
    'protects prompt drafts from unattributed %s mutations',
    async (token) => {
      const path = 'prompts/2026-10-02-0001/message.md';
      await store.writeProjectArtifact(projectId, path, 'user prompt');
      const attempts = [
        request('artifacts/write', token, 'PUT', { path, content: 'changed' }),
        request(`artifacts/raw?path=${path}`, token, 'PUT', 'changed'),
        request(`artifacts/delete?path=${path}`, token, 'DELETE'),
        request('artifacts/mkdir', token, 'POST', { path: 'prompts/2026-10-02-0002' }),
        request('artifacts/rename', token, 'POST', { fromPath: path, toPath: 'stolen.md' }),
      ];
      expect((await Promise.all(attempts)).map((response) => response.status)).toEqual([
        403, 403, 403, 403, 403,
      ]);
      expect(await store.readProjectArtifact(projectId, path)).toBe('user prompt');
      expect(
        (await request('artifacts/write', 'user', 'PUT', { path, content: 'edited by user' }))
          .status,
      ).toBe(200);
    },
  );

  it.each(['worker', 'coordinator'])(
    'uses %s credentials for every workspace mutation',
    async (token) => {
      await store.writeProjectWorkspaceFile(projectId, 'keep.txt', 'keep\n');
      await store.writeProjectArtifact(projectId, 'copy.txt', 'artifact');
      const attempts: Array<[string, string, unknown?]> = [
        ['workspace/file', 'PUT', { path: 'keep.txt', content: 'changed' }],
        ['workspace/replace', 'POST', { path: 'keep.txt', find: 'keep', replace: 'changed' }],
        [
          'workspace/replace-lines',
          'POST',
          { path: 'keep.txt', startLine: 1, endLine: 1, content: 'changed' },
        ],
        [
          'workspace/patch',
          'POST',
          { path: 'keep.txt', diff: '--- keep.txt\n+++ keep.txt\n@@ -1 +1 @@\n-keep\n+changed\n' },
        ],
        [
          'workspace/insert-at-marker',
          'POST',
          { path: 'keep.txt', marker: 'keep', content: 'changed' },
        ],
        ['workspace/path?path=keep.txt', 'DELETE'],
        ['workspace/mkdir', 'POST', { path: 'new-folder' }],
        ['workspace/rename', 'POST', { fromPath: 'keep.txt', toPath: 'moved.txt' }],
        ['workspace/copy-from-artifact', 'POST', { source: 'copy.txt', dest: 'copied.txt' }],
      ];
      for (const [path, method, body] of attempts) {
        expect((await request(path, token, method, body)).status, path).toBe(403);
      }
      expect(await store.readProjectWorkspaceFile(projectId, 'keep.txt')).toBe('keep\n');
      expect(await store.readProjectWorkspaceFile(projectId, 'copied.txt')).toBeNull();
    },
  );

  it.each(['git', 'github'])('enforces authority on the %s alias', async (segment) => {
    for (const token of ['worker', 'coordinator']) {
      expect((await request(`${segment}/discard`, token, 'POST', { all: true })).status).toBe(403);
      for (const operation of [
        'clone',
        'pull',
        'branch',
        'fetch',
        'commit',
        'push',
        'sync',
        'merge/resolve',
        'merge/complete',
        'merge/abandon',
      ]) {
        expect(
          (await request(`${segment}/${operation}`, token, 'POST', {})).status,
          operation,
        ).toBe(403);
      }
    }
    expect(discard).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'allow' });
    expect((await request(`${segment}/discard`, 'worker', 'POST', { all: true })).status).toBe(403);
    expect((await request(`${segment}/commit`, 'worker', 'POST', { message: 'test' })).status).toBe(
      200,
    );
    expect((await request(`${segment}/discard`, 'user', 'POST', { all: true })).status).toBe(200);
    expect(discard).toHaveBeenCalledOnce();
  });

  it.each(['worker', 'coordinator'])(
    'gates repository imports before %s can remove existing files',
    async (token) => {
      await store.writeProjectWorkspaceFile(projectId, 'repo/user.txt', 'keep');
      for (const operation of ['fetch-repo', 'fetch-diff']) {
        const response = await request(`workspace/${operation}`, token, 'POST', {
          url: 'https://example.com/repo.git',
          dest: 'repo',
          baseRef: 'main',
          headRef: 'feature',
        });
        expect(response.status, operation).toBe(403);
        expect(await store.readProjectWorkspaceFile(projectId, 'repo/user.txt')).toBe('keep');
      }
    },
  );
});
