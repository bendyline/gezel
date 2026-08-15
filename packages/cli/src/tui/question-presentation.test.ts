import type { Question } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  allowsWriteIn,
  canAnswerQuestionInTui,
  choicesForQuestion,
  npmApprovalPackages,
  questionHeading,
  questionOptionCount,
} from './question-presentation.js';

const baseQuestion: Question = {
  id: 'q-1',
  projectId: 'project',
  gezelId: 'developer',
  sessionId: 'session',
  prompt: 'How should I proceed?',
  createdAt: '2026-08-14T12:00:00.000Z',
};

describe('question presentation', () => {
  it('presents plain questions with their choices and default write-in', () => {
    const question: Question = {
      ...baseQuestion,
      choices: ['Investigate', 'Run tests'],
      multiSelect: true,
    };

    expect(canAnswerQuestionInTui(question)).toBe(true);
    expect(choicesForQuestion(question)).toEqual(['Investigate', 'Run tests']);
    expect(allowsWriteIn(question)).toBe(true);
    expect(questionHeading(question, 'Developer')).toBe('Developer asks');
    expect(questionOptionCount(question)).toBe(4);
  });

  it.each([
    ['command-approval', ['Approve', 'Decline'], 'Command approval'],
    ['tool-permission', ['Allow', 'Deny'], 'Tool permission'],
    ['toolset-install-approval', ['Install', 'Not now'], 'Toolset install approval'],
    [
      'image-generation-approval',
      ['Allow once', 'Always allow', 'Decline'],
      'Image generation approval',
    ],
    [
      'video-generation-approval',
      ['Allow once', 'Always allow', 'Decline'],
      'Video generation approval',
    ],
    ['schedule-approval', ['Enable schedule', 'Keep paused'], 'Schedule approval'],
  ] as const)('synthesizes usable choices for %s', (kind, choices, heading) => {
    const question = {
      ...baseQuestion,
      intent: { kind },
    } as unknown as Question;

    expect(canAnswerQuestionInTui(question)).toBe(true);
    expect(choicesForQuestion(question)).toEqual(choices);
    expect(allowsWriteIn(question)).toBe(false);
    expect(questionHeading(question, 'Developer')).toBe(heading);
    expect(questionOptionCount(question)).toBe(choices.length);
  });

  it('keeps informational desktop cards out of the blocking TUI queue', () => {
    const question = {
      ...baseQuestion,
      intent: { kind: 'task-paused' },
    } as unknown as Question;

    expect(canAnswerQuestionInTui(question)).toBe(false);
  });

  it('supports current and legacy npm approval payloads', () => {
    const packages = [
      { package: 'tsx', version: 'latest' },
      { package: 'vitest', version: '^4.1.10' },
    ];
    const current = {
      ...baseQuestion,
      intent: {
        kind: 'npm-install-approval',
        packages,
      },
    } as Question;
    const legacy = {
      ...baseQuestion,
      intent: { kind: 'npm-install-approval', package: 'tsx', version: 'latest' },
    } as unknown as Question;
    const malformed = {
      ...baseQuestion,
      intent: { kind: 'npm-install-approval' },
    } as unknown as Question;

    expect(questionHeading(current, 'Developer')).toBe('npm package approval');
    expect(npmApprovalPackages(current)).toEqual(packages);
    expect(questionOptionCount(current)).toBe(3);
    expect(npmApprovalPackages(legacy)).toEqual([{ package: 'tsx', version: 'latest' }]);
    expect(questionOptionCount(malformed)).toBe(1);
  });
});
