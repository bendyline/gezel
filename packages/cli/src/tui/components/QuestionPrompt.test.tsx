import type { Question } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { QuestionPrompt, questionOptionCount } from './QuestionPrompt.js';

const baseQuestion: Question = {
  id: 'q-1',
  projectId: 'project',
  gezelId: 'developer',
  sessionId: 'session',
  prompt: 'How should I proceed?',
  choices: ['Dig into the dead-lock bug', 'Run the test suite'],
  createdAt: '2026-07-28T12:00:00.000Z',
};

const client = {
  answerQuestion: async () => baseQuestion,
} as unknown as GezelClient;

describe('QuestionPrompt', () => {
  it('renders choices and the default write-in path', () => {
    const output = renderToString(
      <QuestionPrompt
        client={client}
        question={baseQuestion}
        askerLabel="developer"
        active={false}
        onAnswered={() => {}}
      />,
    );

    expect(output).toContain('developer asks');
    expect(output).toContain('How should I proceed?');
    expect(output).toContain('Dig into the dead-lock bug');
    expect(output).toContain('Run the test suite');
    expect(output).toContain('Other…');
  });

  it('budgets an extra submit row for multi-select questions', () => {
    expect(questionOptionCount(baseQuestion)).toBe(3);
    expect(questionOptionCount({ ...baseQuestion, multiSelect: true })).toBe(4);
  });
});
