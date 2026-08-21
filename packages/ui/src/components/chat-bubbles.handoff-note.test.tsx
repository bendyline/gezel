import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const HANDOFF_SEED =
  'Liesel has handed step `review` of task default/11 to you. Follow the step instructions already in your prompt — make the first tool call they name this turn. Append focused notes with `write_task_note` as you go so the next gezel can pick up where you left off.';

/**
 * The dispatch seed is written for the model. Rendered verbatim it opened
 * every task thread with four sentences of tool-calling procedure under a
 * SYSTEM tag — the card keeps the one sentence a reader wants and files the
 * rest under provenance.
 */
describe('MessageBubble hand-off note', () => {
  function renderHandoff(props: { onTaskReference?: (ref: string) => void } = {}) {
    return render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        origin="system"
        content={HANDOFF_SEED}
        authorLabel="Koray"
        receiverLabel="Koray"
        authorIcon={null}
        {...props}
      />,
    );
  }

  it('leads with who passed what to whom, not the procedure', () => {
    const { container } = renderHandoff();

    expect(screen.getByText('Liesel passed the review step to Koray.')).toBeInTheDocument();
    expect(screen.getByText('Hand-off')).toBeInTheDocument();
    expect(screen.queryByText('System')).toBeNull();
    // The instructions are present but collapsed — provenance, not the lede.
    const details = container.querySelector('.msg-handoff-note-details');
    expect(details).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.textContent).toContain('write_task_note');
  });

  it('keeps the msg-user class the timeline pairs replies against', () => {
    const { container } = renderHandoff();
    expect(container.querySelector('.msg-handoff-note.msg-user')).toBeTruthy();
  });

  it('offers the task as the card’s one action', () => {
    const onTaskReference = vi.fn();
    renderHandoff({ onTaskReference });

    fireEvent.click(screen.getByRole('button', { name: 'Task default/11' }));
    expect(onTaskReference).toHaveBeenCalledWith('default/11');
  });

  it('leaves other machine-authored turns as plain System bubbles', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        origin="system"
        content="The user just opened report.md."
        authorLabel="Koray"
        authorIcon={null}
      />,
    );

    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('automatic')).toBeInTheDocument();
  });
});
