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

  // Squisq's single-dollar inline math once turned a catering budget into two
  // code spans with the dollar signs gone.
  it('keeps prices intact instead of parsing them as inline math', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="Budget about $300. Our catering prices: croissants $3.50, muffins $3.00."
        authorLabel="You"
        authorIcon={null}
      />,
    );

    const body = container.querySelector('.msg-body-rendered');
    expect(body?.textContent).toContain(
      'Budget about $300. Our catering prices: croissants $3.50, muffins $3.00.',
    );
    expect(container.querySelector('.squisq-md-inline-math')).toBeNull();
    expect(container.querySelector('.msg-body-rendered code')).toBeNull();
  });

  // Squisq's default cover promoted the first heading to a giant page title
  // above the opening paragraph, then repeated it in place.
  it('renders a reply heading once and never as a page cover', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content={[
          "It sounds like you're wearing every hat.",
          '',
          '## 1. Immediate Relief: Staff Schedules',
          '',
          'Move scheduling out of your texts.',
        ].join('\n')}
        authorLabel="Zara"
        authorIcon={null}
      />,
    );

    expect(container.querySelector('.squisq-page-hero-title')).toBeNull();
    expect(screen.getAllByText('1. Immediate Relief: Staff Schedules')).toHaveLength(1);
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
