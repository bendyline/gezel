import type { ChatSession, Question, Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { questionPassIsOver, withdrawFinishedPassQuestions } from './finished-pass-questions.js';

const task = (activeStepId: string, lastActivatedAt: string, status: Task['status'] = 'active') =>
  ({
    ref: 'p/1',
    projectId: 'p',
    status,
    activeStepId,
    craftbook: { steps: [{ id: 'report', lastActivatedAt }, { id: 'evaluate' }] },
  }) as unknown as Task;

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  projectId: 'p',
  gezelId: 'tsumugi',
  sessionId: 's1',
  prompt: 'Where do the events come from?',
  taskRef: 'p/1',
  stepId: 'report',
  createdAt: '2026-10-21T18:40:00Z',
  ...over,
});

const bound = (stepActivationId: string) =>
  ({ taskRef: 'p/1', stepId: 'report', stepActivationId }) as Pick<
    ChatSession,
    'taskRef' | 'stepId' | 'stepActivationId'
  >;

describe('questionPassIsOver', () => {
  it('keeps a question from the pass the step is on', () => {
    expect(questionPassIsOver(question(), task('report', 't2'), bound('t2'))).toBe(false);
  });

  it('retires one from an earlier pass of the same step after a loop back', () => {
    // week-plan, 2026-10-21: pass-2 report questions kept waking a dead turn.
    expect(questionPassIsOver(question(), task('report', 't3'), bound('t2'))).toBe(true);
  });

  it('retires one whose task moved to another step or finished', () => {
    expect(questionPassIsOver(question(), task('evaluate', 't2'), bound('t2'))).toBe(true);
    expect(questionPassIsOver(question(), task('report', 't2', 'complete'), bound('t2'))).toBe(
      true,
    );
  });

  it('keeps one while the task is paused on the asking step', () => {
    expect(questionPassIsOver(question(), task('report', 't2', 'paused'), bound('t2'))).toBe(false);
  });

  it('falls back to the ask time when the session carries no binding', () => {
    const t = task('report', '2026-10-21T19:00:00Z');
    expect(questionPassIsOver(question(), t, null)).toBe(true);
    expect(questionPassIsOver(question({ createdAt: '2026-10-21T19:05:00Z' }), t, null)).toBe(
      false,
    );
  });
});

describe('withdrawFinishedPassQuestions', () => {
  it('silently closes only plain questions from passes that are over', async () => {
    const written: Question[] = [];
    const events: unknown[] = [];
    const questions = [
      question({ id: 'stale' }),
      question({ id: 'current', sessionId: 's2' }),
      question({ id: 'answered', answer: { writeIn: 'x', at: 'now' } }),
      question({ id: 'card', intent: { kind: 'task-paused' } as Question['intent'] }),
      question({ id: 'other-task', taskRef: 'p/2' }),
    ];
    const sessions: Record<string, ReturnType<typeof bound>> = { s1: bound('t1'), s2: bound('t2') };
    const count = await withdrawFinishedPassQuestions(
      {
        store: {
          listProjectQuestions: async () => questions,
          writeQuestion: async (q) => {
            written.push(q);
          },
          getSession: async (_gezelId, sessionId) =>
            (sessions[sessionId] ?? null) as ChatSession | null,
        },
        chatEvents: { publishProjectEvent: (_projectId, event) => events.push(event) },
      },
      task('report', 't2'),
    );
    expect(count).toBe(1);
    expect(written.map((q) => q.id)).toEqual(['stale']);
    expect(written[0]?.answer).toMatchObject({ silentSkip: true, withdrawn: true });
    expect(events).toEqual([{ type: 'question_answered', question: written[0] }]);
  });
});
