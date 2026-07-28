import type { Question } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { plainPendingQuestions, updatePendingQuestion } from './question-queue.js';

const question = (overrides: Partial<Question> = {}): Question => ({
  id: 'q-1',
  projectId: 'project',
  gezelId: 'developer',
  sessionId: 'session',
  prompt: 'Choose one',
  createdAt: '2026-07-28T12:00:00.000Z',
  ...overrides,
});

describe('plain pending question queue', () => {
  it('keeps plain unanswered questions in oldest-first order', () => {
    const newer = question({ id: 'q-2', createdAt: '2026-07-28T13:00:00.000Z' });
    expect(plainPendingQuestions([newer, question()]).map((item) => item.id)).toEqual([
      'q-1',
      'q-2',
    ]);
  });

  it('excludes answered and specialized approval questions', () => {
    expect(
      plainPendingQuestions([
        question({ answer: { writeIn: 'done', at: '2026-07-28T12:01:00.000Z' } }),
        question({
          id: 'approval',
          intent: { kind: 'tool-permission', toolName: 'write_file', toolInput: {} },
        }),
      ]),
    ).toEqual([]);
  });

  it('adds, updates, and removes questions by id', () => {
    const pending = updatePendingQuestion([], question());
    expect(pending).toHaveLength(1);

    const answered = question({
      answer: { selectedChoices: [0], at: '2026-07-28T12:01:00.000Z' },
    });
    expect(updatePendingQuestion(pending, answered)).toEqual([]);
  });
});
