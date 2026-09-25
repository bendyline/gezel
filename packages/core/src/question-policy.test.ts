import { describe, expect, it } from 'vitest';
import {
  answeredQuestion,
  assertAnswerFitsQuestion,
  findQuestion,
  newQuestion,
  normalizeQuestionAnswer,
  pendingQuestions,
  resolveAsk,
  sortQuestionsNewestFirst,
} from './question-policy.js';
import type { Question } from './schemas/question.js';

const identity = { id: 'q-new', at: '2026-09-22T10:00:00.000Z' };
const ask = {
  projectId: 'default',
  gezelId: 'maya',
  sessionId: 's1',
  prompt: 'Which colour?',
  choices: ['red', 'blue'],
};
const existing: Question = {
  ...newQuestion(ask, { id: 'q-old', at: '2026-09-22T09:00:00.000Z' }),
};

describe('newQuestion', () => {
  it('drops empty choice lists and unset options', () => {
    const q = newQuestion({ ...ask, choices: [], allowWriteIn: undefined }, identity);
    expect(q).not.toHaveProperty('choices');
    expect(q).not.toHaveProperty('allowWriteIn');
    expect(q.createdAt).toBe(identity.at);
  });
  it('refuses a question nobody could answer', () => {
    expect(() => newQuestion({ ...ask, choices: [], allowWriteIn: false }, identity)).toThrow(
      /Provide choices/,
    );
  });
});

describe('resolveAsk', () => {
  it('returns the outstanding card instead of stacking a second one', () => {
    const out = resolveAsk([existing], ask, identity);
    expect(out).toEqual({ question: existing, deduped: true });
  });
  it('creates a record once the previous one is answered', () => {
    const answered = answeredQuestion(existing, { selectedChoices: [0] }, identity.at);
    const out = resolveAsk([answered], ask, identity);
    expect(out.deduped).toBe(false);
    expect(out.question.id).toBe('q-new');
  });
});

describe('answers', () => {
  it('normalises an answer and refuses one the question cannot take', () => {
    expect(normalizeQuestionAnswer({ selectedChoices: [], writeIn: '' }, identity.at)).toEqual({
      at: identity.at,
    });
    expect(() =>
      assertAnswerFitsQuestion(existing, { selectedChoices: [5], at: identity.at }),
    ).toThrow(/Choose an option/);
    expect(() =>
      assertAnswerFitsQuestion(existing, { selectedChoices: [0, 1], at: identity.at }),
    ).toThrow(/only one/);
    expect(() => assertAnswerFitsQuestion(existing, { at: identity.at })).toThrow(
      /Select an option/,
    );
    expect(() =>
      assertAnswerFitsQuestion(existing, { silentSkip: true, at: identity.at }),
    ).not.toThrow();
  });
  it('is idempotent once answered', () => {
    const once = answeredQuestion(existing, { selectedChoices: [1] }, identity.at, {
      validate: true,
    });
    const twice = answeredQuestion(once, { selectedChoices: [0] }, '2027-01-01T00:00:00.000Z');
    expect(twice).toBe(once);
  });
});

describe('listing', () => {
  it('filters pending and orders newest first', () => {
    const answered = answeredQuestion(existing, { declined: true }, identity.at);
    const newer = newQuestion(ask, identity);
    expect(pendingQuestions([answered, newer])).toEqual([newer]);
    expect(sortQuestionsNewestFirst([answered, newer]).map((q) => q.id)).toEqual([
      'q-new',
      'q-old',
    ]);
    expect(findQuestion([answered, newer], 'q-old')).toBe(answered);
  });
});
