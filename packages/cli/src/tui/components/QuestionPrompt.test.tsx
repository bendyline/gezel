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

  it('renders a command approval with the regular approve/decline choices', () => {
    const question: Question = {
      ...baseQuestion,
      prompt: 'Run `npm run convert`?\n\nThis command can access your OS account.',
      choices: undefined,
      allowWriteIn: false,
      intent: {
        kind: 'command-approval',
        scope: 'script',
        name: 'convert',
        body: 'node scripts/convert-to-md.mjs',
      },
    };

    const output = renderToString(
      <QuestionPrompt
        client={client}
        question={question}
        askerLabel="developer"
        active={false}
        onAnswered={() => {}}
      />,
    );

    expect(output).toContain('Command approval');
    expect(output).toContain('npm run convert');
    expect(output).toContain('Approve');
    expect(output).toContain('Decline');
    expect(output).not.toContain('Other…');
    expect(questionOptionCount(question)).toBe(2);
  });

  it('renders npm approval decisions instead of an unusable empty prompt', () => {
    const question: Question = {
      ...baseQuestion,
      prompt: 'Approve tsx?',
      choices: undefined,
      allowWriteIn: false,
      intent: {
        kind: 'npm-install-approval',
        packages: [{ package: 'tsx', version: 'latest' }],
      },
    };

    const output = renderToString(
      <QuestionPrompt
        client={client}
        question={question}
        askerLabel="developer"
        active={false}
        onAnswered={() => {}}
      />,
    );

    expect(output).toContain('npm package approval');
    expect(output).toContain('tsx@latest');
    expect(output).toContain('Install');
    expect(output).toContain('Always allow');
    expect(output).toContain('Decline');
    expect(questionOptionCount(question)).toBe(3);
  });
});
