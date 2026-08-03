import type { Question } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { questionChatTarget, questionToActions } from './question-nav.js';

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    projectId: 'p1',
    gezelId: 'g1',
    sessionId: 'sess-1',
    prompt: 'Which one?',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('questionChatTarget', () => {
  it('resolves the thread a normal question was asked in', () => {
    expect(questionChatTarget(question())).toEqual({
      gezelId: 'g1',
      sessionId: 'sess-1',
      projectId: 'p1',
    });
  });

  it('omits an empty projectId rather than sending a blank one', () => {
    expect(questionChatTarget(question({ projectId: '' }))).toEqual({
      gezelId: 'g1',
      sessionId: 'sess-1',
    });
  });

  // The service files task-paused / night-shift-review / schedule-approval
  // cards with sessionId '' — there is no conversation to open, and the
  // card must hide the affordance instead of offering a dead button.
  it('has no target for a service-synthesized card with no session', () => {
    expect(
      questionChatTarget(
        question({
          sessionId: '',
          taskRef: 'learning/3',
          intent: { kind: 'task-paused', taskRef: 'learning/3', reason: 'budget_exhausted' },
        }),
      ),
    ).toBeNull();
  });

  it('has no target when no Meester is designated to own the card', () => {
    expect(questionChatTarget(question({ gezelId: '' }))).toBeNull();
  });
});

describe('questionToActions', () => {
  it('queues the session intent before the tab event, live event last', () => {
    const intent = { gezelId: 'g1', sessionId: 'sess-1', projectId: 'p1' };
    expect(questionToActions(question())).toEqual([
      { kind: 'open-session', intent },
      { kind: 'event', type: 'gezel:open-tab', detail: { kind: 'gezel', id: 'g1' } },
      { kind: 'event', type: 'gezel:open-session', detail: intent },
    ]);
  });

  it('navigates nowhere for a question with no thread', () => {
    expect(questionToActions(question({ sessionId: '' }))).toEqual([]);
  });
});
