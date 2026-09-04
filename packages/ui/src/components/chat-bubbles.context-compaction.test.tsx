import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

describe('MessageBubble automatic context compaction', () => {
  it('renders a durable maintenance marker with exact window facts', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="[Earlier in this conversation, summarized to fit the model context:\n\n- Keep the exact citations.]"
        authorLabel="Dina"
        authorIcon={null}
        synthetic="compaction-summary"
        contextCompaction={{
          removedCount: 14,
          contextWindow: 40_960,
          estimatedTokensBefore: 29_100,
          compactionCount: 2,
          autoCompactRatio: 0.7,
        }}
      />,
    );

    expect(
      screen.getByRole('complementary', { name: 'Automatic context compaction' }),
    ).toHaveTextContent('Context auto-compacted');
    expect(screen.getByText(/14 earlier messages summarized/)).toHaveTextContent(
      '40K-token window · compaction #2',
    );
    expect(screen.getByText(/View continuity summary/)).toHaveTextContent('triggered around 70%');
    expect(screen.queryByText('Dina')).not.toBeInTheDocument();
  });

  it('keeps legacy summaries visible without invented measurements', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="[Earlier in this conversation: concise summary]"
        authorLabel="Dina"
        authorIcon={null}
        synthetic="compaction-summary"
      />,
    );

    expect(
      screen.getByText('Earlier messages were summarized so the conversation could continue.'),
    ).toBeInTheDocument();
  });
});
