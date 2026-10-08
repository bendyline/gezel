import type { ChatEventEnvelope, Question } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { morningNotificationFor } from './morning-notification.js';

function asked(question: Partial<Question>): ChatEventEnvelope {
  return {
    sessionId: '',
    gezelId: '',
    projectId: 'default',
    event: {
      type: 'question_asked',
      question: {
        id: 'q1',
        projectId: 'default',
        gezelId: 'wren',
        sessionId: '',
        prompt: 'Overnight your crew read 1,204 files.',
        choices: ['Dismiss'],
        allowWriteIn: false,
        multiSelect: false,
        createdAt: '2026-10-08T06:00:00.000Z',
        intent: {
          kind: 'night-shift-review',
          windowKey: '2026-10-07',
          tasksCompleted: 0,
          reports: [],
        },
        ...question,
      } as Question,
    },
  } as ChatEventEnvelope;
}

describe('morningNotificationFor', () => {
  it('notifies once per morning card, with the card as the body', () => {
    const seen = new Set<string>();
    expect(morningNotificationFor(asked({}), seen)).toEqual({
      title: 'Your crew worked overnight',
      body: 'Overnight your crew read 1,204 files.',
    });
    expect(morningNotificationFor(asked({}), seen)).toBeNull();
  });

  it('ignores every other card', () => {
    expect(morningNotificationFor(asked({ id: 'q2', intent: undefined }), new Set())).toBeNull();
  });
});
