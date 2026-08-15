import type { Question } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { pendingQuestionsForTui, updatePendingQuestion } from './question-queue.js';

const question = (overrides: Partial<Question> = {}): Question => ({
  id: 'q-1',
  projectId: 'project',
  gezelId: 'developer',
  sessionId: 'session',
  prompt: 'Choose one',
  createdAt: '2026-07-28T12:00:00.000Z',
  ...overrides,
});

describe('pending TUI question queue', () => {
  it('keeps plain unanswered questions in oldest-first order', () => {
    const newer = question({ id: 'q-2', createdAt: '2026-07-28T13:00:00.000Z' });
    expect(pendingQuestionsForTui([newer, question()]).map((item) => item.id)).toEqual([
      'q-1',
      'q-2',
    ]);
  });

  it('keeps actionable approvals and excludes answered or informational cards', () => {
    expect(
      pendingQuestionsForTui([
        question({ answer: { writeIn: 'done', at: '2026-07-28T12:01:00.000Z' } }),
        question({
          id: 'approval',
          intent: { kind: 'tool-permission', toolName: 'write_file', toolInput: {} },
        }),
        question({
          id: 'night-review',
          intent: {
            kind: 'night-shift-review',
            windowKey: '2026-07-27',
            tasksCompleted: 1,
            reports: [],
          },
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'approval',
        intent: expect.objectContaining({ kind: 'tool-permission' }),
      }),
    ]);
  });

  it('adds, updates, and removes questions by id', () => {
    const pending = updatePendingQuestion([], question());
    expect(pending).toHaveLength(1);

    const answered = question({
      answer: { selectedChoices: [0], at: '2026-07-28T12:01:00.000Z' },
    });
    expect(updatePendingQuestion(pending, answered)).toEqual([]);
  });

  it('surfaces a live structured approval event and removes it when answered', () => {
    const approval = question({
      id: 'command-approval',
      choices: ['Approve', 'Decline'],
      allowWriteIn: false,
      intent: { kind: 'command-approval', scope: 'script', name: 'convert' },
    });

    expect(updatePendingQuestion([], approval)).toEqual([approval]);
    expect(
      updatePendingQuestion([approval], {
        ...approval,
        answer: { selectedChoices: [0], at: '2026-07-28T12:01:00.000Z' },
      }),
    ).toEqual([]);
  });
});
