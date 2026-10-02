import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession, Task } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

/**
 * A task-step session whose pass is over cannot pause, resume, or advance the
 * task through the real daemon: scope-guard → live session record → task.
 * Wild-caught on invoice-run (2026-10-01), where a reviewer whose `evaluate`
 * step had been looped back paused the whole run from its leftover turn.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-stale-step-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterEach(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
  delete process.env.GEZEL_DISABLE_EMBEDDINGS;
}, 30_000);

function postJson(path: string, token: string, body: unknown): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function bindSession(id: string, gezelId: string, task: Task, stepId: string) {
  const at = new Date().toISOString();
  const session: ChatSession = {
    version: 1,
    id,
    gezelId,
    projectId: task.projectId,
    providerName: 'copilot',
    title: task.title,
    createdAt: at,
    lastActivityAt: at,
    messages: [],
    providerState: {},
    taskRef: task.ref,
    stepId,
    stepActivationId: task.craftbook.steps.find((s) => s.id === stepId)!.lastActivatedAt!,
  };
  await svc.context.store.writeSession(session);
  return svc.context.tokenStore.issueSession({
    appId: `session:${id}`,
    projectId: task.projectId,
    gezelId,
    team: false,
  }).token;
}

describe('stale task-step sessions (integration)', () => {
  it('refuses status changes and advances from a pass the task left behind', async () => {
    const reviewer = await svc.context.store.createGezel({ name: 'Rusudan', role: 'Reviewer' });
    const created = await svc.context.tasks.create('default', {
      title: 'Monthly Invoice Run',
      description: 'A two-step run whose first step the task moves past.',
      assignee: { kind: 'user' },
      steps: [
        { id: 'evaluate', name: 'Evaluate' },
        { id: 'collect', name: 'Collect', terminal: true },
      ],
    });
    const staleToken = await bindSession('sess-evaluate', reviewer.id, created, 'evaluate');
    await svc.context.tasks.completeStep('default', created.num, 'evaluate', 'collect');
    const moved = (await svc.context.tasks.get('default', created.num))!;
    expect(moved.activeStepId).toBe('collect');

    const status = `/api/projects/default/tasks/${created.num}/status`;
    const paused = await postJson(status, staleToken, { status: 'paused' });
    expect(paused.status).toBe(403);
    const body = (await paused.json()) as { error: string; hint: string };
    expect(body.error).toBe('stale_task_step');
    expect(body.hint).toContain('Your step `evaluate` is no longer the active step');
    expect(body.hint).toContain('end your turn');
    expect((await svc.context.tasks.get('default', created.num))?.status).toBe('active');

    const advance = await postJson(
      `/api/projects/default/tasks/${created.num}/steps/collect/complete`,
      staleToken,
      {},
    );
    expect(advance.status).toBe(403);
    expect((await svc.context.tasks.get('default', created.num))?.activeStepId).toBe('collect');

    // The current pass's session keeps today's behavior.
    const currentToken = await bindSession('sess-collect', reviewer.id, moved, 'collect');
    expect((await postJson(status, currentToken, { status: 'paused' })).status).toBe(200);
    expect((await svc.context.tasks.get('default', created.num))?.status).toBe('paused');
  }, 30_000);
});
