import { act, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PageChatSlots, clipAroundModal } from './PageChatSlots.js';

vi.mock('./PageChat.js', () => ({
  PageChat: ({ projectId }: { projectId: string }) => <span>Chat in {projectId}</span>,
}));

describe('page chat host boundary', () => {
  it('binds the project, rejects foreign windows and options, bounds mounts and cleans up on navigation', async () => {
    const frameRef = createRef<HTMLIFrameElement>();
    const { container } = render(
      <>
        <iframe title="App" ref={frameRef} />
        <PageChatSlots frameRef={frameRef} projectId="board" />
      </>,
    );
    const reply = vi.spyOn(frameRef.current!.contentWindow!, 'postMessage');
    function send(
      kind: string,
      id: string,
      fields: object = {},
      source = frameRef.current!.contentWindow,
    ) {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { source, data: { __gezelPage: 1, kind, id, ...fields } }),
        );
      });
    }
    send('chat-mount', 'foreign', { options: {} }, window);
    expect(reply).not.toHaveBeenCalled();
    send('chat-mount', 'escape', { options: { projectId: 'another-project' } });
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }), '*');
    for (let i = 0; i < 4; i++) send('chat-mount', `chat-${i}`, { options: {} });
    await waitFor(() => expect(screen.getAllByText('Chat in board')).toHaveLength(4));
    send('chat-mount', 'fifth', { options: {} });
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }), '*');
    send('chat-position', 'chat-0', { rect: { x: -50, y: -50, width: 200, height: 200 } });
    expect(container.querySelector('.page-chat-slot')).toHaveStyle({ left: '0px', top: '0px' });
    send('chat-destroy', 'chat-0');
    expect(screen.getAllByText('Chat in board')).toHaveLength(3);
    send('hello', '');
    expect(screen.queryByText('Chat in board')).not.toBeInTheDocument();
  });

  it('dims the conversation while a page modal is open, instead of emptying it', async () => {
    const frameRef = createRef<HTMLIFrameElement>();
    const { container } = render(
      <>
        <iframe title="App" ref={frameRef} />
        <PageChatSlots frameRef={frameRef} projectId="board" />
      </>,
    );
    function send(data: object) {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frameRef.current!.contentWindow,
            data: { __gezelPage: 1, id: 'chat', ...data },
          }),
        );
      });
    }
    const rect = { x: 800, y: 100, width: 300, height: 600 };
    send({ kind: 'chat-mount', options: {} });
    send({ kind: 'chat-position', rect });
    await screen.findByText('Chat in board');
    const slot = container.querySelector('.page-chat-slot')!;
    expect(slot).not.toHaveAttribute('data-dimmed');

    // A backdrop that is not a plain rgb() color never reaches host styles.
    send({
      kind: 'chat-position',
      rect,
      modal: { areas: [], scrim: 'url(https://example.com/x.png)' },
    });
    expect(slot).not.toHaveAttribute('data-dimmed');

    send({
      kind: 'chat-position',
      rect,
      modal: {
        areas: [{ x: 300, y: 200, width: 560, height: 400 }],
        scrim: 'rgba(20, 17, 14, 0.62)',
      },
    });
    expect(slot).toHaveAttribute('data-dimmed', 'true');
    expect(slot).toHaveAttribute('inert');
    expect(screen.getByText('Chat in board')).toBeInTheDocument();
    expect(container.querySelector('.page-chat-slot-scrim')).toHaveStyle({
      background: 'rgba(20, 17, 14, 0.62)',
    });

    send({ kind: 'chat-position', rect });
    expect(slot).not.toHaveAttribute('data-dimmed');
    expect(slot).not.toHaveAttribute('inert');
    expect(container.querySelector('.page-chat-slot-scrim')).toBeNull();
  });

  it('cuts the modal out of the dimmed conversation so the dialog stays uncovered', () => {
    const rect = { x: 800, y: 100, width: 300, height: 600 };
    expect(clipAroundModal(rect, undefined)).toBeUndefined();
    // The dialog's right edge overlaps the conversation's first 60px.
    expect(clipAroundModal(rect, { areas: [{ x: 300, y: 200, width: 560, height: 400 }] })).toBe(
      'path(evenodd, "M0 0H300V600H0ZM0 100H60V500H0Z")',
    );
    // A modal elsewhere leaves the whole conversation dimmed.
    expect(
      clipAroundModal(rect, { areas: [{ x: 0, y: 0, width: 200, height: 200 }] }),
    ).toBeUndefined();
  });
});
