import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GhostQueuedBubble, MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

function ghostProps(overrides: Partial<Parameters<typeof GhostQueuedBubble>[0]> = {}) {
  return {
    sessionId: 'session-1',
    queueId: 'q-1',
    preview: 'also add tests',
    enqueuedAt: new Date().toISOString(),
    onDiscard: vi.fn(),
    onCancelCurrent: vi.fn(),
    ...overrides,
  };
}

describe('GhostQueuedBubble', () => {
  it('labels a plain queued entry "queued" and a nudge entry "nudge"', () => {
    const { rerender } = render(<GhostQueuedBubble {...ghostProps()} />);
    expect(screen.getByText('⋯ queued')).toBeInTheDocument();

    rerender(<GhostQueuedBubble {...ghostProps({ nudge: true })} />);
    expect(screen.getByText('⋯ nudge')).toBeInTheDocument();
  });

  it('hides Edit until both edit handlers are provided', () => {
    const { rerender } = render(<GhostQueuedBubble {...ghostProps()} />);
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();

    rerender(
      <GhostQueuedBubble
        {...ghostProps({
          onLoadText: async () => 'full text',
          onSaveEdit: async () => true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
  });

  it('loads the full text into the editor and saves the edit', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(true);
    render(
      <GhostQueuedBubble
        {...ghostProps({
          preview: 'truncated pre…',
          onLoadText: async () => 'the full untruncated text',
          onSaveEdit,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const editor = await screen.findByRole('textbox');
    expect(editor).toHaveValue('the full untruncated text');

    fireEvent.change(editor, { target: { value: 'edited text' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onSaveEdit).toHaveBeenCalledWith('edited text');
    });
    // Edit mode exits; the preview body is back.
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull();
    });
  });

  it('never opens the editor when the entry is already gone', async () => {
    render(
      <GhostQueuedBubble
        {...ghostProps({
          onLoadText: async () => null,
          onSaveEdit: async () => true,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    // Give the async load a beat — the editor must not appear.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('exits edit mode silently when the entry vanished mid-edit (save → false)', async () => {
    render(
      <GhostQueuedBubble
        {...ghostProps({
          onLoadText: async () => 'text',
          onSaveEdit: async () => false,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull();
    });
    expect(document.querySelector('.msg-ghost-queued-edit-error')).toBeNull();
  });
});

describe('MessageBubble nudge chip', () => {
  it('marks a nudge-delivered user message with a "nudged" chip', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="also add tests"
        authorLabel="You"
        authorIcon={null}
        nudge
      />,
    );
    expect(screen.getByText('nudged')).toBeInTheDocument();
  });

  it('renders no chip on plain user messages', () => {
    // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
    render(<MessageBubble role="user" content="hello" authorLabel="You" authorIcon={null} />);
    expect(screen.queryByText('nudged')).toBeNull();
  });
});
