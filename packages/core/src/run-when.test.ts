import { describe, expect, it } from 'vitest';
import { runWhenVerdict } from './run-when.js';
import type { Question } from './schemas/question.js';

const QUEUE = {
  answerOf: 'review',
  choiceAnyOf: ['Approve and queue to Bluesky'],
  writeInMatches: '\\b(linkedin|bluesky)\\b',
};

function asked(
  createdAt: string,
  answer: Question['answer'],
  over: Partial<Question> = {},
): Question {
  return {
    id: createdAt,
    projectId: 'social',
    gezelId: 'omroeper',
    sessionId: 's1',
    prompt: 'Review the draft',
    choices: ['Approve', 'Revise', 'Approve and queue to Bluesky'],
    taskRef: 'social/4',
    stepId: 'review',
    createdAt,
    answer,
    ...over,
  };
}

describe('runWhenVerdict', () => {
  it('skips when the owner approved without asking to queue', () => {
    const verdict = runWhenVerdict(
      QUEUE,
      [asked('2026-09-28T10:00:00Z', { selectedChoices: [0] } as Question['answer'])],
      'social/4',
    );
    expect(verdict).toEqual({ run: false, reason: "the owner's answer did not ask for it" });
  });

  it('runs when the owner picked the choice, whatever its case', () => {
    const verdict = runWhenVerdict(
      { ...QUEUE, choiceAnyOf: ['approve and QUEUE to bluesky'] },
      [asked('2026-09-28T10:00:00Z', { selectedChoices: [2] } as Question['answer'])],
      'social/4',
    );
    expect(verdict.run).toBe(true);
  });

  it('runs when the reply asks for it in words', () => {
    const verdict = runWhenVerdict(
      QUEUE,
      [
        asked('2026-09-28T10:00:00Z', {
          selectedChoices: [0],
          writeIn: 'Looks good, and put it on LinkedIn too',
        } as Question['answer']),
      ],
      'social/4',
    );
    expect(verdict.run).toBe(true);
  });

  it('reads only the latest answer after a revision loop', () => {
    const verdict = runWhenVerdict(
      QUEUE,
      [
        asked('2026-09-28T10:00:00Z', { selectedChoices: [2] } as Question['answer']),
        asked('2026-09-28T11:00:00Z', { selectedChoices: [0] } as Question['answer']),
      ],
      'social/4',
    );
    expect(verdict.run).toBe(false);
  });

  it('ignores other tasks, other steps and skipped cards', () => {
    const noise = [
      asked('a', { selectedChoices: [2] } as Question['answer'], { taskRef: 'social/9' }),
      asked('b', { selectedChoices: [2] } as Question['answer'], { stepId: 'brief' }),
      asked('c', { silentSkip: true } as Question['answer']),
    ];
    expect(runWhenVerdict(QUEUE, noise, 'social/4').run).toBe(true);
    expect(runWhenVerdict({ ...QUEUE, onMissing: 'skip' }, noise, 'social/4').run).toBe(false);
  });
});
