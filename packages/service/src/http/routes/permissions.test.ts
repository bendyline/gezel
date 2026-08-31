import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question, RequestPermissionResponse } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-permissions-route-'));
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

function requestPermission(toolName: string, toolInput: Record<string, unknown>, session: string) {
  return api('POST', '/api/permissions/request-and-wait', {
    projectId: 'default',
    gezelId: 'koray',
    sessionId: session,
    toolName,
    toolInput,
  });
}

async function awaitPendingQuestion(
  predicate: (q: Question) => boolean,
  attempts = 40,
): Promise<Question> {
  for (let i = 0; i < attempts; i += 1) {
    const res = await api('GET', '/api/questions?project=default&pending=true');
    const { questions } = (await res.json()) as { questions: Question[] };
    const hit = questions.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('question never appeared');
}

function answer(questionId: string, body: Record<string, unknown>) {
  return api('POST', `/api/questions/${questionId}/answer`, body);
}

describe('POST /api/permissions/request-and-wait — AskUserQuestion interception', () => {
  it('renders a real question card and folds the answer into updatedInput.answers', async () => {
    const toolInput = {
      questions: [
        {
          question: 'The report gate rejects real file paths. How should we proceed?',
          header: 'Gate block',
          options: [
            { label: 'Fix the gate check', description: 'Point the citation check at the reader.' },
            { label: 'Waive the gate', description: 'Mark the step complete out-of-band.' },
          ],
          multiSelect: false,
        },
      ],
    };
    const pending = requestPermission('AskUserQuestion', toolInput, 'ask-single');

    const question = await awaitPendingQuestion(
      (q) => q.sessionId === 'ask-single' && q.intent?.kind === 'claude-user-question',
    );
    // The card is a real question — prompt text, labeled choices, and the
    // option descriptions on the intent — not an Allow/Deny JSON blob.
    expect(question.prompt).toBe('The report gate rejects real file paths. How should we proceed?');
    expect(question.choices).toEqual(['Fix the gate check', 'Waive the gate']);
    expect(question.allowWriteIn).toBe(true);
    expect(question.intent).toMatchObject({
      kind: 'claude-user-question',
      header: 'Gate block',
      questionIndex: 0,
      questionCount: 1,
    });

    await answer(question.id, { selectedChoices: [1] });

    const verdict = (await (await pending).json()) as RequestPermissionResponse;
    expect(verdict).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: toolInput.questions,
        answers: {
          'The report gate rejects real file paths. How should we proceed?': 'Waive the gate',
        },
      },
    });
  });

  it('joins multiSelect labels with ", " and passes write-in text through verbatim', async () => {
    const pending = requestPermission(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which sections should I include?',
            options: [{ label: 'Intro' }, { label: 'Findings' }, { label: 'Appendix' }],
            multiSelect: true,
          },
        ],
      },
      'ask-multi',
    );

    const question = await awaitPendingQuestion(
      (q) => q.sessionId === 'ask-multi' && q.intent?.kind === 'claude-user-question',
    );
    expect(question.multiSelect).toBe(true);
    await answer(question.id, { selectedChoices: [0, 2], writeIn: 'plus a glossary' });

    const verdict = (await (await pending).json()) as RequestPermissionResponse;
    expect(verdict.behavior).toBe('allow');
    if (verdict.behavior !== 'allow') return;
    expect(verdict.updatedInput.answers).toEqual({
      'Which sections should I include?': 'Intro, Appendix, plus a glossary',
    });
  });

  it('asks multi-question calls sequentially and collects every answer', async () => {
    const pending = requestPermission(
      'AskUserQuestion',
      {
        questions: [
          { question: 'First question?', options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Second question?', options: [{ label: 'C' }, { label: 'D' }] },
        ],
      },
      'ask-seq',
    );

    const first = await awaitPendingQuestion(
      (q) => q.sessionId === 'ask-seq' && q.prompt === 'First question?',
    );
    expect(first.intent).toMatchObject({ questionIndex: 0, questionCount: 2 });
    await answer(first.id, { selectedChoices: [0] });

    const second = await awaitPendingQuestion(
      (q) => q.sessionId === 'ask-seq' && q.prompt === 'Second question?',
    );
    expect(second.intent).toMatchObject({ questionIndex: 1, questionCount: 2 });
    await answer(second.id, { selectedChoices: [1] });

    const verdict = (await (await pending).json()) as RequestPermissionResponse;
    expect(verdict.behavior).toBe('allow');
    if (verdict.behavior !== 'allow') return;
    expect(verdict.updatedInput.answers).toEqual({
      'First question?': 'A',
      'Second question?': 'D',
    });
  });

  it('denies with a best-judgment message when the answer comes back declined', async () => {
    const pending = requestPermission(
      'AskUserQuestion',
      { questions: [{ question: 'Proceed how?', options: [{ label: 'Carefully' }] }] },
      'ask-decline',
    );

    const question = await awaitPendingQuestion(
      (q) => q.sessionId === 'ask-decline' && q.intent?.kind === 'claude-user-question',
    );
    await answer(question.id, { declined: true });

    const verdict = (await (await pending).json()) as RequestPermissionResponse;
    expect(verdict.behavior).toBe('deny');
    if (verdict.behavior !== 'deny') return;
    expect(verdict.message).toContain('best judgment');
  });

  it('keeps the generic Allow/Deny card for every other tool', async () => {
    const pending = requestPermission('mcp__playwright__navigate', { url: 'https://x' }, 'generic');

    const question = await awaitPendingQuestion(
      (q) => q.sessionId === 'generic' && q.intent?.kind === 'tool-permission',
    );
    expect(question.choices).toEqual(['Allow', 'Deny']);
    await answer(question.id, { selectedChoices: [0] });

    const verdict = (await (await pending).json()) as RequestPermissionResponse;
    expect(verdict).toEqual({ behavior: 'allow', updatedInput: { url: 'https://x' } });
  });
});
