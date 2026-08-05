import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-questions-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function ask(project: string, session: string, prompt: string) {
  return api('POST', '/api/questions', {
    projectId: project,
    gezelId: 'imara',
    sessionId: session,
    prompt,
  });
}

async function pendingFor(project: string): Promise<Question[]> {
  const res = await api('GET', `/api/questions?project=${project}&pending=true`);
  const body = (await res.json()) as { questions: Question[] };
  return body.questions;
}

describe('POST /api/questions — cross-turn dedup', () => {
  it('suppresses a reworded re-ask while the first question is unanswered', async () => {
    const project = 'dedup-a';

    const first = await ask(project, 's1', 'What problem are you trying to solve with this game?');
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { questionId: string; deduped?: boolean };
    expect(firstBody.deduped).toBeUndefined();
    const q1 = firstBody.questionId;

    // Same session, reworded prompt (the wild failure mode) → suppressed.
    const second = await ask(
      project,
      's1',
      "To define the problem, could you tell me a little more about what we're building?",
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { questionId: string; deduped?: boolean };
    expect(secondBody.deduped).toBe(true);
    expect(secondBody.questionId).toBe(q1); // points at the existing card

    // Only ONE card is pending, and it's the original prompt.
    const pending = await pendingFor(project);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.prompt).toContain('What problem are you trying to solve');
  });

  it('scopes dedup to the session — a different session still gets its own card', async () => {
    const project = 'dedup-b';
    await ask(project, 'sessA', 'Question for session A?');
    const other = await ask(project, 'sessB', 'Question for session B?');
    expect(other.status).toBe(201);
    expect(((await other.json()) as { deduped?: boolean }).deduped).toBeUndefined();
    expect(await pendingFor(project)).toHaveLength(2);
  });

  it('allows a follow-up question once the first has been answered', async () => {
    const project = 'dedup-c';
    const first = await ask(project, 's1', 'First question?');
    const q1 = ((await first.json()) as { questionId: string }).questionId;

    // Answer it (silent skip — marks it answered without seeding a turn).
    const answered = await api('POST', `/api/questions/${q1}/answer`, { silentSkip: true });
    expect(answered.status).toBe(200);

    // A new question on the same session is now allowed (not deduped).
    const second = await ask(project, 's1', 'A genuinely different follow-up?');
    expect(second.status).toBe(201);
    expect(((await second.json()) as { deduped?: boolean }).deduped).toBeUndefined();
    expect(await pendingFor(project)).toHaveLength(1);
  });
});

describe('POST /api/questions/:id/answer — schedule-approval intent', () => {
  async function seedScheduleHost(projectName: string): Promise<{
    projectId: string;
    hostNum: number;
    questionId: string;
  }> {
    const { store, tasks } = svc.context;
    const project = await store.createProject({ name: projectName });
    const now = new Date().toISOString();
    await store.writeProjectCraftbook(project.id, {
      id: 'weekly-check',
      name: 'Weekly Check',
      version: '1.0.0',
      steps: [{ id: 'run', name: 'Run', prompt: 'Do the weekly check.', terminal: true }],
      entryStepId: 'run',
      createdAt: now,
      updatedAt: now,
    });
    const host = await tasks.create(
      project.id,
      {
        title: 'Schedule: weekly-check',
        description:
          'Recurring craftbook run installed by a test project type. Cron (UTC): 0 17 * * 5.',
        assignee: { kind: 'user' },
        steps: [{ name: 'Wait for schedule', prompt: 'Host task for a recurring schedule.' }],
        spawnsCraftbookId: 'weekly-check',
        cron: { expression: '0 17 * * 5' },
        createdBy: { kind: 'user' },
      },
      {
        origin: { kind: 'project-type-schedule', typeId: 'test-type', scheduleKey: 'weekly-check' },
      },
    );
    await tasks.setStatus(project.id, host.num, 'paused');
    const questionId = crypto.randomUUID();
    await store.writeQuestion({
      id: questionId,
      projectId: project.id,
      gezelId: '',
      sessionId: '',
      prompt: 'Enable the weekly-check schedule?',
      choices: ['Enable schedule', 'Keep paused'],
      allowWriteIn: false,
      multiSelect: false,
      taskRef: host.ref,
      intent: {
        kind: 'schedule-approval',
        typeId: 'test-type',
        craftbookId: 'weekly-check',
        cron: '0 17 * * 5',
      },
      createdAt: now,
    });
    return { projectId: project.id, hostNum: host.num, questionId };
  }

  it('arms the paused host on approve and re-derives the next fire from now', async () => {
    const { projectId, hostNum, questionId } = await seedScheduleHost('Sched Approve');
    const before = Date.now();

    const res = await api('POST', `/api/questions/${questionId}/answer`, {
      selectedChoices: [0],
    });
    expect(res.status).toBe(200);

    const host = await svc.context.tasks.get(projectId, hostNum);
    expect(host?.status).toBe('active');
    // Re-armed from NOW, not from the stale creation-time schedule.
    expect(Date.parse(host?.cron?.nextTickAt ?? '')).toBeGreaterThan(before);
  });

  it('keeps the host paused on decline', async () => {
    const { projectId, hostNum, questionId } = await seedScheduleHost('Sched Decline');

    const res = await api('POST', `/api/questions/${questionId}/answer`, {
      selectedChoices: [1],
      declined: true,
    });
    expect(res.status).toBe(200);

    const host = await svc.context.tasks.get(projectId, hostNum);
    expect(host?.status).toBe('paused');
    // Answer persisted so the card collapses and re-apply never re-asks.
    const questions = await svc.context.store.listProjectQuestions(projectId);
    expect(questions.find((q) => q.id === questionId)?.answer?.declined).toBe(true);
  });
});

describe('POST /api/questions/:id/answer — toolset install approval', () => {
  it('persists the approval without seeding a duplicate model turn', async () => {
    const project = await svc.context.store.createProject({ name: 'MCP Approval' });
    const questionId = crypto.randomUUID();
    await svc.context.store.writeQuestion({
      id: questionId,
      projectId: project.id,
      gezelId: 'imara',
      sessionId: 'live-install-call',
      prompt: 'Install Example MCP?',
      choices: ['Install', 'Not now'],
      allowWriteIn: false,
      intent: {
        kind: 'toolset-install-approval',
        toolsetId: 'example-mcp',
        sourceId: 'bundled',
        version: '1.0.0',
        targetProjectId: project.id,
        craftbookId: 'example-book',
      },
      createdAt: new Date().toISOString(),
    });
    const deliver = vi.spyOn(svc.context.chat, 'deliverQuestionAnswer');

    const res = await api('POST', `/api/questions/${questionId}/answer`, {
      selectedChoices: [0],
    });
    expect(res.status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      (await svc.context.store.getQuestion(project.id, questionId))?.answer?.selectedChoices,
    ).toEqual([0]);

    deliver.mockRestore();
  });

  it('blocks a live install request until the user answers its question', async () => {
    const project = await svc.context.store.createProject({ name: 'MCP Request Bridge' });
    const config = await svc.context.store.readConfig();
    const gezelId = config.meesterGezelId!;
    const sessionId = 'toolset-request-session';
    const detail = await svc.context.catalog.get('toolset', 'docblocks');
    expect(detail?.manifest.kind).toBe('toolset');
    if (!detail || detail.manifest.kind !== 'toolset') throw new Error('DocBlocks missing');

    const sessionToken = svc.context.tokenStore.issueSession({
      appId: `session:${sessionId}`,
      projectId: project.id,
      gezelId,
      team: true,
    });
    const installResponse = httpFetch(
      `${baseUrl}/api/catalog/toolset/docblocks/request-install-and-wait`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scope: { kind: 'project', projectId: project.id },
          sourceId: detail.sourceId,
          version: detail.manifest.version,
          gezelId,
          sessionId,
          craftbookId: 'powerpoint-deck',
        }),
      },
    );

    let question: Question | undefined;
    for (let attempt = 0; attempt < 20 && !question; attempt += 1) {
      question = (await pendingFor(project.id)).find(
        (entry) => entry.intent?.kind === 'toolset-install-approval',
      );
      if (!question) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(question?.intent?.kind).toBe('toolset-install-approval');

    const answer = await api('POST', `/api/questions/${question!.id}/answer`, {
      selectedChoices: [1],
      declined: true,
    });
    expect(answer.status).toBe(200);
    expect((await installResponse).status).toBe(403);
  });
});
