import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

/**
 * A killed turn persists as `synthetic: 'turn-aborted'` carrying whatever
 * the model streamed before the kill, with the reason on `warnings`. Both
 * signals used to stop at the persisted bubble: `MessageBubbleProps` had no
 * `warnings` prop at all, and the empty-body placeholder guessed from
 * `reasoning`/`toolCalls`. A four-hour `[llama-cpp] timed out after 14400s`
 * therefore rendered as "model produced reasoning but no visible reply" —
 * a model quirk, not the timeout it was.
 */
describe('MessageBubble turn-aborted salvage record', () => {
  it('names the abort instead of reading the reasoning as a model quirk', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Alejandro"
        authorIcon={null}
        synthetic="turn-aborted"
        reasoning="Let me plan the integration before writing types.ts."
        warnings={['[llama-cpp] timed out after 14400s']}
      />,
    );

    expect(
      screen.getByText(
        '(this turn was stopped before the model wrote a reply — see the notice below)',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('(model produced reasoning but no visible reply — see Thinking above)'),
    ).not.toBeInTheDocument();
  });

  it('renders the abort reason so it survives the streaming bubble', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Alejandro"
        authorIcon={null}
        synthetic="turn-aborted"
        warnings={['[llama-cpp] timed out after 14400s']}
      />,
    );

    expect(screen.getByText(/timed out after 14400s/)).toBeInTheDocument();
  });

  it('drops the banner reference when the abort carried no reason', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Alejandro"
        authorIcon={null}
        synthetic="turn-aborted"
      />,
    );

    expect(
      screen.getByText('(this turn was stopped before the model wrote a reply)'),
    ).toBeInTheDocument();
  });

  it('keeps the quieter continuation stub when the work landed next turn', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Alejandro"
        authorIcon={null}
        synthetic="turn-aborted"
        recoveredInNextTurn
        warnings={['[llama-cpp] timed out after 14400s']}
      />,
    );

    expect(screen.getByText('(continued in the next turn)')).toBeInTheDocument();
    // The reason still renders — a recovered turn is not a reason to hide
    // that four hours were spent getting there.
    expect(screen.getByText(/timed out after 14400s/)).toBeInTheDocument();
  });

  // A copywriter's whole visible output was "(continued in the next turn)".
  it('says what a recovered tool-only turn did instead of a bare stub', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Kylian"
        authorIcon={null}
        recoveredInNextTurn
        toolCalls={[
          {
            id: 'c1',
            name: 'write_file',
            path: 'social/drafts/week.md',
            success: true,
            durationMs: 40,
            at: '2026-09-28T10:00:00.000Z',
          } as never,
        ]}
      />,
    );
    expect(screen.queryByText('(continued in the next turn)')).not.toBeInTheDocument();
    expect(screen.getByText(/^Last action: .*social\/drafts\/week\.md\.$/)).toBeInTheDocument();
  });

  it('leaves a normal reasoning-only turn on its existing copy', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content=""
        authorLabel="Alejandro"
        authorIcon={null}
        reasoning="Thought about it and said nothing."
      />,
    );

    expect(
      screen.getByText('(model produced reasoning but no visible reply — see Thinking above)'),
    ).toBeInTheDocument();
  });
});
