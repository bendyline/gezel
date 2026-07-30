import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

describe('MessageBubble reasoning summary', () => {
  it('shows a subtle word count and observed duration while collapsed', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        reasoning="First I inspect, then I answer."
        reasoningDurationMs={1_250}
      />,
    );

    const label = screen.getByText('Thinking');
    const summary = label.closest('summary');
    expect(summary).toHaveTextContent('Thinking');
    expect(screen.getByText('· 6 words · 1.3s')).toBeInTheDocument();
    expect(summary?.parentElement).not.toHaveAttribute('open');
  });

  it('omits duration when the provider did not expose timing data', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Done."
        authorLabel="Ada"
        authorIcon={null}
        reasoning="One careful thought."
      />,
    );

    expect(screen.getByText('· 3 words')).toBeInTheDocument();
  });
});
