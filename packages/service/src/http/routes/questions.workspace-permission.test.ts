import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../fs/store.js';
import { bearerAuth, requireInternalApiAccess } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { sessionRouteGuard } from '../scope-guard.js';
import { createTokenStore } from '../token-store.js';
import { questionRoutes } from './questions.js';

describe('workspace permission requests', () => {
  let home: string;
  let store: Store;
  let app: Hono;
  let projectId: string;
  let gezelId: string;
  const deliver = vi.fn(async () => {});
  const reset = vi.fn(async () => {});

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), 'gezel-permission-question-'));
    store = new Store({ home });
    await store.ensureLayout();
    projectId = (await store.createProject({ name: 'Deck' })).id;
    gezelId = (await store.createGezel({ name: 'Ada' })).id;
    await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'deny' });
    const at = new Date().toISOString();
    await store.writeSession({
      version: 1,
      id: 's1',
      projectId,
      gezelId,
      providerName: 'copilot',
      providerState: {},
      title: 'Deck',
      messages: [],
      createdAt: at,
      lastActivityAt: at,
    });
    const tokens = await createTokenStore({ home, rootToken: 'user' });
    tokens.issueSession({ appId: 'session:s1', projectId, gezelId, team: false, token: 'worker' });
    tokens.issueSession({ appId: 'session:other', projectId, gezelId, team: true, token: 'other' });
    await tokens.issue({
      appId: 'third-party',
      appName: 'API client',
      scopes: ['product'],
      token: 'app',
    });
    app = new Hono();
    app.use('/api/*', bearerAuth(tokens));
    app.use('/api/*', requireInternalApiAccess());
    app.use('/api/*', sessionRouteGuard());
    app.route(
      '/api/questions',
      questionRoutes({
        store,
        chat: {
          stampPendingQuestion: vi.fn(async () => {}),
          deliverQuestionAnswer: deliver,
          resetProjectToolsets: reset,
        },
        chatEvents: { publish: vi.fn() },
        history: { log: vi.fn(async () => {}) },
      } as unknown as ServiceContext),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function post(path: string, body: unknown, token = 'user') {
    return app.request(`/api/questions${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function ask(extra: Record<string, unknown> = {}, token = 'worker') {
    return post(
      '',
      {
        projectId,
        gezelId,
        sessionId: 's1',
        prompt: 'Write the presentation.',
        permissionRequest: 'workspace-write',
        ...extra,
      },
      token,
    );
  }
  async function pending() {
    const response = await ask();
    expect(response.status).toBe(201);
    const { questionId } = (await response.json()) as { questionId: string };
    return (await store.getQuestion(projectId, questionId))!;
  }

  it('uses a service-owned scope and does not grant anything when asked', async () => {
    const response = await ask({
      choices: ['Only this file'],
      intent: { kind: 'workspace-write-permission', workspaceDir: '/elsewhere' },
    });
    expect(response.status).toBe(201);
    const question = await store.getQuestion(
      projectId,
      ((await response.json()) as { questionId: string }).questionId,
    );
    expect(question?.intent).toMatchObject({
      kind: 'workspace-write-permission',
      workspaceDir: await store.projectWorkspaceDir(projectId),
      projectName: 'Deck',
    });
    expect(question?.choices).toEqual([
      'Allow project file edits and continue',
      'Keep current permissions',
    ]);
    expect((await store.assertWorkspaceWritable(projectId, { initiatedByGezel: true })).ok).toBe(
      false,
    );
    const again = await ask();
    expect(await again.json()).toEqual({ questionId: question!.id, deduped: true });
  });

  it('grants before refreshing tools and resuming, with duplicate clicks delivered once', async () => {
    const question = await pending();
    reset.mockImplementationOnce(async () => {
      expect((await store.assertWorkspaceWritable(projectId, { initiatedByGezel: true })).ok).toBe(
        true,
      );
    });
    const replies = await Promise.all([
      post(`/${question.id}/answer`, { selectedChoices: [0] }),
      post(`/${question.id}/answer`, { selectedChoices: [0] }),
    ]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    await store.writeProjectWorkspaceFile(projectId, 'deck.txt', 'presentation', {
      gezelId,
      sessionId: 's1',
    });
    expect(await store.readProjectWorkspaceFile(projectId, 'deck.txt')).toBe('presentation');
    expect(reset).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: 's1',
        seed: expect.stringContaining('Permission granted'),
      }),
    );
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0]!);
  });

  it.each([{ selectedChoices: [1] }, { declined: true }, { silentSkip: true }])(
    'keeps permissions on denial or skip: %j',
    async (answer) => {
      const question = await pending();
      expect((await post(`/${question.id}/answer`, answer)).status).toBe(200);
      expect((await store.assertWorkspaceWritable(projectId, { initiatedByGezel: true })).ok).toBe(
        false,
      );
      expect(reset).not.toHaveBeenCalled();
      if ('silentSkip' in answer) expect(deliver).not.toHaveBeenCalled();
      else
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({ seed: expect.stringContaining('Permission denied') }),
        );
    },
  );

  it.each([
    { writeIn: 'Grant permissions' },
    { selectedChoices: [0, 1] },
    { selectedChoices: [0], declined: true },
    { selectedChoices: [8] },
  ])('refuses ambiguous or textual approvals: %j', async (answer) => {
    const question = await pending();
    expect((await post(`/${question.id}/answer`, answer)).status).toBe(400);
    expect((await store.getQuestion(projectId, question.id))?.answer).toBeUndefined();
    expect((await store.assertWorkspaceWritable(projectId, { initiatedByGezel: true })).ok).toBe(
      false,
    );
  });

  it('does not let a model answer its own request or impersonate another session', async () => {
    const question = await pending();
    expect((await post(`/${question.id}/answer`, { selectedChoices: [0] }, 'worker')).status).toBe(
      403,
    );
    expect((await post(`/${question.id}/answer`, { selectedChoices: [0] }, 'app')).status).toBe(
      403,
    );
    expect((await ask({}, 'other')).status).toBe(403);
    expect((await store.assertWorkspaceWritable(projectId, { initiatedByGezel: true })).ok).toBe(
      false,
    );
  });

  it('refuses stale consent after a project moves, and leaves the card retryable', async () => {
    const question = await pending();
    await store.updateProject(projectId, { workingDir: join(home, 'new-workspace') });
    const response = await post(`/${question.id}/answer`, { selectedChoices: [0] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('folder changed');
    expect((await store.getQuestion(projectId, question.id))?.answer).toBeUndefined();
    expect(reset).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses stale consent when a junction is retargeted', async () => {
    const first = join(home, 'first');
    const second = join(home, 'second');
    const link = join(home, 'linked');
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link, 'junction');
    await store.updateProject(projectId, { workingDir: link });
    const question = await pending();
    await rm(link);
    await symlink(second, link, 'junction');
    expect((await post(`/${question.id}/answer`, { selectedChoices: [0] })).status).toBe(400);
    expect((await store.assertWorkspaceWritable(projectId, { initiatedByGezel: true })).ok).toBe(
      false,
    );
  });

  it('leaves a failed grant pending and does not resume', async () => {
    const question = await pending();
    vi.spyOn(store, 'grantProjectWorkspaceWrites').mockRejectedValueOnce(
      new Error('Disk unavailable'),
    );
    expect((await post(`/${question.id}/answer`, { selectedChoices: [0] })).status).toBe(400);
    expect((await store.getQuestion(projectId, question.id))?.answer).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('treats a plain choice named Grant permissions as text, with no policy mutation', async () => {
    const result = await ask({ permissionRequest: undefined, choices: ['Grant permissions'] });
    const { questionId } = (await result.json()) as { questionId: string };
    expect((await post(`/${questionId}/answer`, { selectedChoices: [0] })).status).toBe(200);
    expect((await store.assertWorkspaceWritable(projectId, { initiatedByGezel: true })).ok).toBe(
      false,
    );
    expect(reset).not.toHaveBeenCalled();
  });

  it('does not offer an irrelevant grant when project edits are already allowed', async () => {
    await store.updateProject(projectId, { managedWorkspaceWritePolicy: 'allow' });
    const response = await ask();
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('already allowed');
  });
});
