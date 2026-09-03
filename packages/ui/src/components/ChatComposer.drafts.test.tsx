// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';
import { readActiveDraftId, readDraftText } from './composer-drafts.js';

vi.mock('@bendyline/gezel-client', () => ({ streamChatEvents: vi.fn() }));
vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('./useRoleBasedNameOnlyMode.js', () => ({ useRoleBasedNameOnlyMode: () => false }));
vi.mock('./GezelIcon.js', () => ({ GezelIcon: () => <span /> }));
vi.mock('./PromptDraftMediaProvider.js', () => ({
  createPromptDraftMediaProvider: () => ({ dispose: vi.fn() }),
}));
vi.mock('@bendyline/squisq-editor-react', async () => {
  const { createContext, useContext, useState } = await import('react');
  const EditorTestContext = createContext({ replaceAll: (_source: string) => {} });
  return {
    useEditorContext: () => useContext(EditorTestContext),
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
        <EditorTestContext.Provider value={{ replaceAll: (source) => setDraft(source) }}>
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
        </EditorTestContext.Provider>
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

function draftFixture(over: Record<string, unknown> = {}) {
  return {
    id: '2026-09-03-0001',
    projectId: 'default',
    gezelId: 'tomas',
    sessionId: null,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
    status: 'draft',
    title: '',
    hasFiles: false,
    fileCount: 0,
    content: '',
    ...over,
  };
}

/**
 * The promise this feature makes: a message you are part-way through is still
 * there tomorrow. These cover the client half — that one draft is created and
 * kept up to date, that it follows the conversation rather than the mount,
 * and that sending it does not leave the composer writing over its own words.
 */
describe('ChatComposer prompt drafts', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.listPromptDrafts).mockResolvedValue({ drafts: [] });
    // The service echoes the content it was handed, so the mock does too.
    vi.mocked(api.createPromptDraft).mockImplementation(
      async (_projectId, body) => draftFixture({ content: body.content ?? '' }) as never,
    );
    vi.mocked(api.getPromptDraft).mockResolvedValue(draftFixture() as never);
    vi.mocked(api.writePromptDraftContent).mockResolvedValue({
      draft: draftFixture(),
      deleted: false,
    } as never);
    vi.mocked(api.deletePromptDraft).mockResolvedValue({ ok: true, deleted: true } as never);
  });

  // The draft is created through a round trip, so a single microtask flush
  // is not enough to be sure it exists before the next assertion.
  async function settle() {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  it('creates exactly one draft, however much the user types', async () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('a');
    await settle();
    type('a first line');
    type('a first line, and a second');
    await settle();

    expect(api.createPromptDraft).toHaveBeenCalledTimes(1);
    expect(api.createPromptDraft).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ gezelId: 'tomas', sessionId: 'session-1' }),
    );
  });

  it('never creates a draft for a composer nobody has typed in', async () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('   ');
    await settle();
    expect(api.createPromptDraft).not.toHaveBeenCalled();
  });

  it('saves the words typed while the draft was still being created', async () => {
    // The create round trip is where a naive implementation loses text: the
    // draft comes back holding the first keystroke, and everything typed in
    // the meantime looks already-saved.
    let releaseCreate: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    vi.mocked(api.createPromptDraft).mockImplementation(async (_projectId, body) => {
      await held;
      return draftFixture({ content: body.content ?? '' }) as never;
    });

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('first');
    type('first and then some more');
    releaseCreate?.();
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(api.writePromptDraftContent).toHaveBeenCalledWith(
      'default',
      '2026-09-03-0001',
      'first and then some more',
    );
  });

  it('saves after a pause in typing, not on every keystroke', async () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('the PRD');
    await settle();
    type('the PRD, second thoughts');
    expect(api.writePromptDraftContent).not.toHaveBeenCalled();

    // advanceTimersByTimeAsync flushes the promises each timer creates, which
    // a plain advance does not — the save is two awaits deep.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(api.writePromptDraftContent).toHaveBeenCalledWith(
      'default',
      '2026-09-03-0001',
      'the PRD, second thoughts',
    );
  });
});

describe('coming back to a draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.listPromptDrafts).mockResolvedValue({ drafts: [] });
    vi.mocked(api.createPromptDraft).mockImplementation(
      async (_projectId, body) => draftFixture({ content: body.content ?? '' }) as never,
    );
    vi.mocked(api.getPromptDraft).mockResolvedValue(draftFixture() as never);
    vi.mocked(api.writePromptDraftContent).mockResolvedValue({
      draft: draftFixture(),
      deleted: false,
    } as never);
  });

  it('paints the text back the moment the surface returns', async () => {
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
      await Promise.resolve();
    });
    cleanup();

    vi.mocked(api.getPromptDraft).mockResolvedValue(
      draftFixture({ content: 'abcdef', sessionId: 'session-1' }) as never,
    );
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    // Straight from the cache — no await, because a blank flash on every
    // return is exactly the feeling this feature exists to remove.
    expect(editorValue()).toBe('abcdef');
  });

  it('adopts the server copy when it is newer than what we remembered', async () => {
    vi.mocked(api.listPromptDrafts).mockResolvedValue({
      drafts: [draftFixture({ sessionId: 'session-1' })],
    } as never);
    vi.mocked(api.getPromptDraft).mockResolvedValue(
      draftFixture({ content: 'written in another window', sessionId: 'session-1' }) as never,
    );
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    await waitFor(() => expect(editorValue()).toBe('written in another window'));
  });

  it('keeps the attachment reference with the rest of the prompt', async () => {
    const withImage = 'look at this\n\n![shot](message_files/shot.png)';
    vi.mocked(api.listPromptDrafts).mockResolvedValue({
      drafts: [draftFixture({ sessionId: 'session-1' })],
    } as never);
    vi.mocked(api.getPromptDraft).mockResolvedValue(
      draftFixture({ content: withImage, sessionId: 'session-1' }) as never,
    );
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    await waitFor(() => expect(editorValue()).toBe(withImage));
  });
});

describe('drafts and threads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.listPromptDrafts).mockResolvedValue({ drafts: [] });
    vi.mocked(api.createPromptDraft).mockImplementation(
      async (_projectId, body) => draftFixture({ content: body.content ?? '' }) as never,
    );
    vi.mocked(api.getPromptDraft).mockResolvedValue(draftFixture() as never);
    vi.mocked(api.patchPromptDraft).mockResolvedValue(draftFixture() as never);
    vi.mocked(api.writePromptDraftContent).mockResolvedValue({
      draft: draftFixture(),
      deleted: false,
    } as never);
  });

  it('brings up the other thread\u2019s draft when the user switches threads', async () => {
    vi.mocked(api.listPromptDrafts).mockResolvedValue({ drafts: [] });
    const { rerender } = render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('for the first thread');
    await act(async () => {
      await Promise.resolve();
    });

    vi.mocked(api.listPromptDrafts).mockResolvedValue({
      drafts: [draftFixture({ id: '2026-09-03-0002', sessionId: 'session-2' })],
    } as never);
    vi.mocked(api.getPromptDraft).mockResolvedValue(
      draftFixture({
        id: '2026-09-03-0002',
        sessionId: 'session-2',
        content: 'for the second thread',
      }) as never,
    );
    rerender(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-2"
        draftScope="meester"
      />,
    );
    await waitFor(() => expect(editorValue()).toBe('for the second thread'));
  });

  it('carries the draft along when the recipient changes under a live composer', async () => {
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
    await act(async () => {
      await Promise.resolve();
    });

    rerender(
      <ChatComposer
        gezelId="ada"
        gezelName="Ada"
        projectId="default"
        sessionId={undefined}
        draftScope="project"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // The words stay with the person typing them; the draft is re-filed to
    // the new recipient rather than swapped for whatever they had.
    expect(editorValue()).toBe('@ada can you finish this?');
    await waitFor(() =>
      expect(api.patchPromptDraft).toHaveBeenCalledWith(
        'default',
        '2026-09-03-0001',
        expect.objectContaining({ gezelId: 'ada' }),
      ),
    );
    expect(api.createPromptDraft).toHaveBeenCalledTimes(1);
  });

  it('adopts a thread that appears under a draft born without one', async () => {
    const { rerender } = render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId={undefined}
        draftScope="meester"
      />,
    );
    type('typed before the picker landed');
    await act(async () => {
      await Promise.resolve();
    });

    rerender(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    await waitFor(() =>
      expect(api.patchPromptDraft).toHaveBeenCalledWith('default', '2026-09-03-0001', {
        sessionId: 'session-1',
      }),
    );
    expect(editorValue()).toBe('typed before the picker landed');
    expect(api.createPromptDraft).toHaveBeenCalledTimes(1);
  });
});

describe('sending a draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.listPromptDrafts).mockResolvedValue({ drafts: [] });
    vi.mocked(api.createPromptDraft).mockImplementation(
      async (_projectId, body) => draftFixture({ content: body.content ?? '' }) as never,
    );
    vi.mocked(api.getPromptDraft).mockResolvedValue(draftFixture() as never);
    vi.mocked(api.writePromptDraftContent).mockResolvedValue({
      draft: draftFixture(),
      deleted: false,
    } as never);
    vi.mocked(api.sendToChatSession).mockResolvedValue(undefined as never);
  });

  it('names the draft on the way out and stops tracking it', async () => {
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
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });

    await waitFor(() =>
      expect(api.sendToChatSession).toHaveBeenCalledWith('session-1', {
        message: 'abcdef',
        draftId: '2026-09-03-0001',
      }),
    );
    // The composer forgets the draft rather than saving its own emptiness
    // over the message that just went out.
    await waitFor(() => expect(readDraftText('2026-09-03-0001')).toBeUndefined());
    expect(readActiveDraftId('meester|default|tomas|||session-1')).toBeUndefined();
    expect(editorValue()).toBe('');
  });

  it('does not save an empty draft after the editor clears', async () => {
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
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });
    await waitFor(() => expect(api.sendToChatSession).toHaveBeenCalled());

    const writesAfterSend = vi
      .mocked(api.writePromptDraftContent)
      .mock.calls.filter(([, , content]) => content === '');
    expect(writesAfterSend).toHaveLength(0);
  });

  it('keeps the draft when the daemon refuses the message', async () => {
    vi.mocked(api.sendToChatSession).mockRejectedValue(new Error('daemon unreachable'));
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        draftScope="meester"
      />,
    );
    type('worth keeping');
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });

    await waitFor(() => expect(api.sendToChatSession).toHaveBeenCalled());
    expect(editorValue()).toBe('worth keeping');
    expect(api.deletePromptDraft).not.toHaveBeenCalled();
  });
});
