import { act, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PageChatSlots } from './PageChatSlots.js';

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
});
