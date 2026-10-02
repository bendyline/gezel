import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffpackManager } from '../diffpack/manager.js';
import { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import { bearerAuth, requireInternalApiAccess } from './auth.js';
import type { ServiceContext } from './context.js';
import { diffpackRoutes } from './routes/diffpacks.js';
import { gitRoutes } from './routes/git.js';
import { projectRoutes } from './routes/projects.js';
import {
  gezelScopeGuard,
  projectScopeGuard,
  sessionRouteGuard,
  teamRouteGuard,
} from './scope-guard.js';
import { type TokenStore, createTokenStore } from './token-store.js';

describe('authenticated mutation authority', () => {
  let home: string;
  let store: Store;
  let app: Hono;
  let projectId: string;
  let tokens: TokenStore;
  let diffpacks: DiffpackManager;
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
    tokens = await createTokenStore({ home, rootToken: 'user' });
    for (const team of [false, true]) {
      tokens.issueSession({
        appId: `session:${team ? 'coordinator' : 'worker'}`,
        projectId,
        gezelId: 'worker',
        team,
        token: team ? 'coordinator' : 'worker',
      });
    }
    const other = await store.createProject({ name: 'Other' });
    for (const token of ['other-project', 'revoked']) {
      tokens.issueSession({
        appId: `session:${token}`,
        projectId: token === 'other-project' ? other.id : projectId,
        gezelId: 'worker',
        team: false,
        token,
      });
    }
    tokens.revokeSession('session:revoked');
    diffpacks = new DiffpackManager({ home, store, tasks: new TaskManager(store) });
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
      diffpacks,
      git: { discardChanges: discard, commit },
    } as unknown as ServiceContext;
    app.route('/api/projects', projectRoutes(context));
    app.route('/api/projects', gitRoutes(context));
    app.route('/api/projects', gitRoutes(context, 'github'));
    app.route('/api/projects', diffpackRoutes(context));
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

  function putBytes(path: string, token: string, bytes: Uint8Array) {
    return app.request(`/api/projects/${projectId}/workspace/raw?path=${path}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
  }

  async function proposal() {
    await diffpacks.ensure(projectId, '1', {
      title: 'Proposed edit',
      origin: { kind: 'manual' },
      taskRef: `${projectId}/1`,
    });
    await diffpacks.drafts.write(projectId, '1', 'proposal.txt', 'proposal');
    await diffpacks.seal(projectId, '1');
  }

  // One actor table exercises the same sequence through the production guards
  // and routes. Filesystem assertions also catch a denial returned after a write.
  it.each([
    { actor: 'user', write: 200, apply: 200 },
    { actor: 'worker', write: 200, apply: 403 },
    { actor: 'coordinator', write: 200, apply: 403 },
    { actor: 'other-project', write: 403, apply: 403 },
    { actor: 'revoked', write: 401, apply: 401 },
  ])(
    'preserves mutation authority throughout a sequence for $actor',
    async ({ actor, write, apply }) => {
      await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'allow' });
      const bytes = Uint8Array.from([0, 255, 128, 13, 10, 65]);
      await store.writeProjectWorkspaceFile(projectId, 'original.txt', 'original');
      await store.writeProjectArtifactBinary(projectId, 'source.bin', Buffer.from(bytes));
      await proposal();
      const attribution = actor === 'user' ? {} : { gezelId: 'worker', sessionId: actor };

      expect(
        (
          await request('workspace/file', actor, 'PUT', {
            path: 'original.txt',
            content: 'edited',
            ...attribution,
          })
        ).status,
      ).toBe(write);
      expect((await putBytes('new/bytes.bin', actor, bytes)).status).toBe(write);
      expect(
        (
          await request('workspace/copy-from-artifact', actor, 'POST', {
            source: 'source.bin',
            dest: 'new/copy.bin',
            ...attribution,
          })
        ).status,
      ).toBe(write);
      expect(
        (
          await request('workspace/rename', actor, 'POST', {
            fromPath: 'original.txt',
            toPath: 'moved/text.txt',
            ...attribution,
          })
        ).status,
      ).toBe(write);
      const root = await store.projectWorkspaceDir(projectId);
      if (write === 200) {
        expect(await readFile(join(root, 'new/bytes.bin'))).toEqual(Buffer.from(bytes));
        expect(await readFile(join(root, 'new/copy.bin'))).toEqual(Buffer.from(bytes));
        expect(await store.readProjectWorkspaceFile(projectId, 'moved/text.txt')).toBe('edited');
      } else {
        expect(await store.readProjectWorkspaceFile(projectId, 'original.txt')).toBe('original');
        for (const path of ['new/bytes.bin', 'new/copy.bin', 'moved/text.txt']) {
          await expect(readFile(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
      expect(
        (
          await request(
            `workspace/path?path=moved/text.txt&gezelId=worker&sessionId=${actor}`,
            actor,
            'DELETE',
          )
        ).status,
      ).toBe(write);
      expect(await store.readProjectWorkspaceFile(projectId, 'moved/text.txt')).toBeNull();
      expect((await request('git/discard', actor, 'POST', { all: true })).status).toBe(apply);
      expect(discard).toHaveBeenCalledTimes(actor === 'user' ? 1 : 0);
      expect((await request('diffpacks/1/apply', actor, 'POST', {})).status).toBe(apply);
      expect(await store.readProjectWorkspaceFile(projectId, 'proposal.txt')).toBe(
        actor === 'user' ? 'proposal' : null,
      );
      expect((await diffpacks.get(projectId, '1')).status).toBe(
        actor === 'user' ? 'applied' : 'ready',
      );
    },
  );

  it('rechecks external consent and revocation between operations', async () => {
    const external = join(home, 'external');
    await mkdir(external);
    await store.updateProject(projectId, { workingDir: external });
    const bytes = Uint8Array.from([0, 255, 128]);
    expect((await putBytes('file.bin', 'worker', bytes)).status).toBe(403);
    await proposal();
    expect((await request('diffpacks/1/apply', 'worker', 'POST', {})).status).toBe(403);
    expect((await request('diffpacks/1/apply', 'user', 'POST', {})).status).toBe(200);
    expect(await readFile(join(external, 'proposal.txt'), 'utf8')).toBe('proposal');
    await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'allow' });
    expect((await putBytes('file.bin', 'worker', bytes)).status).toBe(200);
    tokens.revokeSession('session:worker');
    expect((await putBytes('file.bin', 'worker', Uint8Array.of(42))).status).toBe(401);
    expect((await request('workspace/path?path=file.bin', 'worker', 'DELETE')).status).toBe(401);
    expect(await readFile(join(external, 'file.bin'))).toEqual(Buffer.from(bytes));
  });

  it.each(['user', 'worker'])(
    'rejects recursive root deletion by %s through HTTP',
    async (actor) => {
      await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'allow' });
      await store.writeProjectWorkspaceFile(projectId, 'keep.txt', 'keep');
      const response = await request(
        `workspace/path?path=.&recursive=1&gezelId=worker&sessionId=${actor}`,
        actor,
        'DELETE',
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'empty-path' });
      expect(await store.readProjectWorkspaceFile(projectId, 'keep.txt')).toBe('keep');
    },
  );

  it.each(['worker', 'coordinator'])(
    'does not let %s omit its identity on raw writes',
    async (token) => {
      const bytes = Uint8Array.from([0, 255, 128]);
      expect((await putBytes('blocked.bin', token, bytes)).status).toBe(403);
      expect(await store.readProjectWorkspaceFile(projectId, 'blocked.bin')).toBeNull();
      expect((await putBytes('blocked.bin', 'user', bytes)).status).toBe(200);
      await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'allow' });
      expect((await putBytes('allowed.bin', token, bytes)).status).toBe(200);
      expect(
        await readFile(join(await store.projectWorkspaceDir(projectId), 'allowed.bin')),
      ).toEqual(Buffer.from(bytes));
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
      const attempts: Array<[string, string, Record<string, unknown>?]> = [
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
        const response = await request(
          method === 'DELETE' ? `${path}&gezelId=worker&sessionId=${token}` : path,
          token,
          method,
          body ? { ...body, gezelId: 'worker', sessionId: token } : undefined,
        );
        expect(response.status, path).toBe(403);
        expect(await response.json(), path).toMatchObject({ reason: 'disabled-by-project' });
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
          gezelId: 'worker',
          sessionId: token,
        });
        expect(response.status, operation).toBe(403);
        expect(await response.json(), operation).toMatchObject({ reason: 'disabled-by-project' });
        expect(await store.readProjectWorkspaceFile(projectId, 'repo/user.txt')).toBe('keep');
      }
    },
  );
});
