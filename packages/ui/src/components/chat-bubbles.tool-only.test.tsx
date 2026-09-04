import type { Question } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble, summarizeTerminalToolCall } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const question: Question = {
  id: 'q-1',
  projectId: 'gezel',
  gezelId: 'amadou',
  sessionId: 's-1',
  prompt: 'What would you like me to work on?',
  choices: ['Check current tasks', 'Investigate a bug'],
  createdAt: '2026-09-04T03:19:12.747Z',
};

describe('MessageBubble tool-only endings', () => {
  it('renders JSON-quoted question arguments as ordinary text', () => {
    expect(
      summarizeTerminalToolCall([
        {
          name: 'ask_user_question',
          durationMs: 25,
          success: true,
          argsSummary:
            'question: "\\"dsaav\\" — I\'m not sure what you want", prompt: "What now?", choices: [4 items]',
        },
      ]),
    ).toBe(
      'Last action: Ask you a question — question: "dsaav" — I\'m not sure what you want, prompt: What now?, choices: [4 items].',
    );
  });

  it('treats an inline question card as the visible response', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Amadou"
        authorIcon={null}
        reasoning="I should ask what they want to do."
        toolCalls={[
          {
            name: 'ask_user_question',
            durationMs: 25,
            success: true,
            argsSummary: 'What would you like me to work on?',
          },
        ]}
        question={question}
      />,
    );

    expect(container.querySelector('.pending-question-prompt')).toHaveTextContent(
      'What would you like me to work on?',
    );
    expect(
      screen.queryByText('(model produced reasoning but no visible reply — see Thinking above)'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Last action:/)).not.toBeInTheDocument();
  });

  it('summarizes the final tool call even when the turn also has reasoning', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Amadou"
        authorIcon={null}
        reasoning="Maya should take this one."
        toolCalls={[
          { name: 'list_gezels', durationMs: 5, success: true },
          {
            name: 'ask_gezel',
            durationMs: 80,
            success: true,
            argsSummary: 'Maya about the rendering bug',
          },
        ]}
      />,
    );

    expect(
      screen.getByText('Last action: Ask a gezel — Maya about the rendering bug.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('(model produced reasoning but no visible reply — see Thinking above)'),
    ).not.toBeInTheDocument();
  });
});
