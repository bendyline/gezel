import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const deck = { kind: 'workspace' as const, path: 'powerpoint/task-13/deck.pptx' };

function renderWrapUp(onFileReference = vi.fn()) {
  render(
    // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
    <MessageBubble
      role="assistant"
      synthetic="task-wrapup"
      content={
        "All done — **PowerPoint from Content** is finished.\n\nHere's your PowerPoint deck: `powerpoint/task-13/deck.pptx` (in the project folder)"
      }
      authorLabel="Fenton"
      authorIcon={null}
      projectId="default"
      referencedFiles={[deck]}
      deliverable={{ ...deck, bytes: 48_000, modifiedAt: '2026-09-30T10:00:00.000Z' }}
      onFileReference={onFileReference}
    />,
  );
  return onFileReference;
}

afterEach(() => {
  window.__GEZEL__ = undefined;
});

describe('MessageBubble deliverable', () => {
  it('closes a wrap-up with the deliverable card, and opens it', async () => {
    const user = userEvent.setup();
    const onFileReference = renderWrapUp();

    const card = screen.getByRole('region', { name: 'Your PowerPoint deck' });
    expect(within(card).getByText('deck.pptx')).toBeInTheDocument();
    expect(card).toHaveTextContent('In the project folder · powerpoint/task-13 · 46.9 KB');
    // The inline path still links too — the daemon resolved it.
    expect(screen.getByRole('link', { name: 'powerpoint/task-13/deck.pptx' })).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Open' }));
    expect(onFileReference).toHaveBeenCalledWith(deck);
  });

  it('offers the desktop shell reveal and save-a-copy only where they exist', async () => {
    renderWrapUp();
    const card = screen.getByRole('region', { name: 'Your PowerPoint deck' });
    expect(within(card).queryByRole('button', { name: 'Show in folder' })).toBeNull();
  });

  it('reports a failed reveal beside the card', async () => {
    const user = userEvent.setup();
    const showReferenceInFolder = vi.fn().mockResolvedValue({ ok: false, error: 'Gone.' });
    window.__GEZEL__ = { token: 't', showReferenceInFolder } as unknown as typeof window.__GEZEL__;
    renderWrapUp();
    const card = screen.getByRole('region', { name: 'Your PowerPoint deck' });
    await user.click(within(card).getByRole('button', { name: 'Show in folder' }));
    expect(showReferenceInFolder).toHaveBeenCalledWith({ projectId: 'default', ...deck });
    expect(await within(card).findByRole('alert')).toHaveTextContent('Gone.');
  });
});
