import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

describe('MessageBubble user markdown', () => {
  it('renders links in user prompts through Squisq', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="Read [the reference](https://example.com/reference) before answering."
        authorLabel="You"
        authorIcon={null}
      />,
    );

    expect(screen.getByRole('link', { name: 'the reference' })).toHaveAttribute(
      'href',
      'https://example.com/reference',
    );
    expect(container.querySelector('.msg-user .msg-body-rendered .squisq-linear')).toBeTruthy();
    expect(container.querySelector('.msg-user > .msg-body:not(.msg-body-rendered)')).toBeNull();
  });

  it('uses the same Squisq renderer for ordinary user prose', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble role="user" content="A plain prompt." authorLabel="You" authorIcon={null} />,
    );

    expect(screen.getByText('A plain prompt.')).toBeInTheDocument();
    expect(container.querySelector('.msg-user .msg-body-rendered .squisq-linear')).toBeTruthy();
  });
});
