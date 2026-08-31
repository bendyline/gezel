// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';
import { readComposerDraft } from './composer-drafts.js';

vi.mock('@bendyline/gezel-client', () => ({ streamChatEvents: vi.fn() }));
vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('./useRoleBasedNameOnlyMode.js', () => ({ useRoleBasedNameOnlyMode: () => false }));
vi.mock('./GezelIcon.js', () => ({ GezelIcon: () => <span /> }));
vi.mock('./GezelMediaProvider.js', () => ({
  createGezelMediaProvider: () => ({ dispose: vi.fn() }),
}));
vi.mock('@bendyline/squisq-editor-react', async () => {
  const { useState } = await import('react');
  return {
    EditorShell: ({
      initialMarkdown = '',
      onChange,
      toolbarSlotRight,
    }: {
      initialMarkdown?: string;
      onChange?: (value: string) => void;
      toolbarSlotRight?: React.ReactNode;
    }) => {
      const [draft, setDraft] = useState(initialMarkdown);
      return (
        <div>
          <textarea
            className="squisq-wysiwyg-editor"
            aria-label="Message"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              onChange?.(event.target.value);
            }}
          />
          {toolbarSlotRight}
        </div>
      );
    },
  };
});

function type(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
}

function editorValue(): string {
  return (screen.getByLabelText('Message') as HTMLTextAreaElement).value;
}

/**
 * The reported bug: type into the meester chat, open Settings, come back, and
 * the message is gone. Navigating away unmounts the whole surface, so these
 * tests unmount and re-render rather than merely re-rendering.
 */
describe('ChatComposer draft preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
  });

  it('restores an in-progress draft after the surface unmounts and comes back', () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('abcdef');
    cleanup();

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    expect(editorValue()).toBe('abcdef');
  });

  it('keeps an attachment reference with the rest of the draft', () => {
    const withImage = 'look at this\n\n![shot](attachments/shot.png)';
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId={undefined} />,
    );
    type(withImage);
    cleanup();

    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId={undefined} />,
    );
    expect(editorValue()).toBe(withImage);
  });

  it('keeps each surface draft separate', () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="meester"
      />,
    );
    type('for the meester');
    cleanup();

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="gezel"
      />,
    );
    expect(editorValue()).toBe('');
    type('for the gezel tab');
    cleanup();

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="meester"
      />,
    );
    expect(editorValue()).toBe('for the meester');
  });

  it('carries the draft along when the recipient changes under a live composer', () => {
    const { rerender } = render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="project"
      />,
    );
    type('@ada can you finish this?');
    rerender(
      <ChatComposer
        gezelId="ada"
        gezelName="Ada"
        projectId="default"
        sessionId={undefined}
        draftScope="project"
      />,
    );

    expect(editorValue()).toBe('@ada can you finish this?');
    cleanup();

    // The pivoted-away-from recipient must not hold a second copy.
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="project"
      />,
    );
    expect(editorValue()).toBe('');
    cleanup();

    render(
      <ChatComposer
        gezelId="ada"
        gezelName="Ada"
        projectId="default"
        sessionId={undefined}
        draftScope="project"
      />,
    );
    expect(editorValue()).toBe('@ada can you finish this?');
  });

  it('does not restore a draft the daemon already accepted', async () => {
    vi.mocked(api.sendToChatSession).mockResolvedValue(undefined as never);
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('abcdef');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });

    await waitFor(() => expect(readComposerDraft('meester|default|tomas||')).toBe(''));
    cleanup();

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    expect(editorValue()).toBe('');
  });

  it('keeps a draft the daemon rejected', async () => {
    vi.mocked(api.sendToChatSession).mockRejectedValue(new Error('network error'));
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('abcdef');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeTruthy());
    cleanup();

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    expect(editorValue()).toBe('abcdef');
  });

  it('drops the draft when the user escapes into the terminal', () => {
    const onTerminalEscape = vi.fn();
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="project"
        onTerminalEscape={onTerminalEscape}
      />,
    );
    type('> ls');
    expect(onTerminalEscape).toHaveBeenCalledWith('ls');
    cleanup();

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="project"
      />,
    );
    expect(editorValue()).toBe('');
  });
});
