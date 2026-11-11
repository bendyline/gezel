import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble, RenderedMarkdown } from './chat-bubbles.js';

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

  // Squisq's page register sizes in rem: a reply's heading came out near 32px
  // over 15px prose, and its numbered list as "01 / 02" numerals.
  it('keeps a reply with a heading and a numbered list at chat scale', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content={[
          '## Plan for Saturday',
          '',
          '1. Order the bread',
          '2. Confirm the van',
          '3. Print the menus',
        ].join('\n')}
        authorLabel="Zara"
        authorIcon={null}
      />,
    );

    const page = container.querySelector('.msg-body-rendered .squisq-page');
    expect(page).toHaveClass('squisq-page--document');
    // The heading is prose and the list is a list, not a banner over a
    // typed item section with its own numerals.
    expect(container.querySelector('.squisq-page-banner-title')).toBeNull();
    expect(container.querySelector('.squisq-page-items')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Plan for Saturday' })).toBeInTheDocument();
    expect(container.querySelectorAll('.msg-body-rendered ol > li')).toHaveLength(3);
  });

  it('leaves the report register on the page it had', () => {
    const { container } = render(
      <RenderedMarkdown markdown={'## Night report\n\nAll quiet.'} register="report" />,
    );
    expect(container.querySelector('.squisq-page')).not.toHaveClass('squisq-page--document');
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

describe('MessageBubble cross-gezel messages', () => {
  // A consultation opened with "[Question from Zara]: …" quoted at the owner;
  // the header already names the sender.
  it('drops the service sentinel from a consultation question', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="[Question from Zara]: Which three admin jobs should she hand off first?"
        authorLabel="Dina"
        authorIcon={null}
        from={{ gezelId: 'zara', gezelName: 'Zara' }}
      />,
    );
    const body = container.querySelector('.msg-from-gezel .msg-body-rendered');
    expect(body?.textContent).toContain('Which three admin jobs');
    expect(body?.textContent).not.toContain('[Question from');
  });
});
