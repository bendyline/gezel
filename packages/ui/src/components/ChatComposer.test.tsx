// @vitest-environment jsdom

import { streamChatEvents } from '@bendyline/gezel-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock('@bendyline/gezel-client', () => ({ streamChatEvents: vi.fn() }));
vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
const roleBasedNameOnly = vi.hoisted(() => ({ value: false }));
vi.mock('./useRoleBasedNameOnlyMode.js', () => ({
  useRoleBasedNameOnlyMode: () => roleBasedNameOnly.value,
}));
vi.mock('./GezelIcon.js', () => ({ GezelIcon: () => <span /> }));
vi.mock('./GezelMediaProvider.js', () => ({
  createGezelMediaProvider: () => ({ dispose: vi.fn() }),
}));
vi.mock('./ChatNarrateButton.js', () => ({
  ChatNarrateButton: ({ onTranscript }: { onTranscript: (text: string) => void }) => (
    <button type="button" onClick={() => onTranscript('dictated words')}>
      Narrate prompt
    </button>
  ),
}));
vi.mock('@bendyline/squisq-editor-react', async () => {
  const { useState } = await import('react');
  return {
    EditorShell: ({
      initialMarkdown = '',
      placeholder,
      toolbarSlotRight,
      onChange,
      submitOnEnter,
    }: {
      initialMarkdown?: string;
      placeholder?: string;
      toolbarSlotRight?: React.ReactNode;
      onChange?: (value: string) => void;
      submitOnEnter?: () => void;
    }) => {
      // Match Squisq's mount-time-only placeholder configuration so this
      // mock catches regressions where a recipient change merely updates a
      // prop without refreshing the underlying Tiptap editor.
      const [mountedPlaceholder] = useState(placeholder);
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
          <span data-testid="editor-placeholder">{mountedPlaceholder}</span>
          <span data-testid="editor-draft">{draft}</span>
          <button
            type="button"
            onClick={() => {
              setDraft('Hello from the test');
              onChange?.('Hello from the test');
            }}
          >
            Fill draft
          </button>
          <button type="button" onClick={() => submitOnEnter?.()}>
            Press Enter
          </button>
          {toolbarSlotRight}
        </div>
      );
    },
  };
});

describe('ChatComposer keyboard hints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
  });

  it('uses the native modifier name for Windows and macOS', () => {
    window.__GEZEL__ = { ...window.__GEZEL__!, platform: 'win32' };
    const { rerender } = render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    expect(screen.getByRole('button', { name: /^send$/i })).toHaveAttribute(
      'title',
      'Enter to send, Ctrl+Enter for newline',
    );

    window.__GEZEL__ = { ...window.__GEZEL__!, platform: 'darwin' };
    rerender(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    expect(screen.getByRole('button', { name: /^send$/i })).toHaveAttribute(
      'title',
      'Enter to send, ⌘⏎ for newline',
    );
  });

  it('focuses the editor when its focus request key changes', async () => {
    const { rerender } = render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        focusRequestKey={0}
      />,
    );

    const editor = screen.getByTestId('chat-composer').querySelector('.squisq-wysiwyg-editor');
    expect(document.activeElement).not.toBe(editor);

    rerender(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        focusRequestKey={1}
      />,
    );

    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it('extends the current draft with narrated text', () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Narrate prompt' }));

    expect(screen.getByTestId('editor-draft')).toHaveTextContent(
      'Hello from the test dictated words',
    );
  });
});

describe('ChatComposer To line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    roleBasedNameOnly.value = false;
  });

  it('shows the role under the recipient name', () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        gezelRole="Scheepstimmerman"
        projectId="default"
        sessionId="session-1"
      />,
    );

    expect(screen.getByText('Tomas')).toBeTruthy();
    expect(screen.getByText('Scheepstimmerman')).toBeTruthy();
  });

  it('replaces the friendly name with the role-based name in boring mode', () => {
    roleBasedNameOnly.value = true;
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        gezelRoleBasedName="scheepstimmerman"
        gezelRole="Scheepstimmerman"
        projectId="default"
        sessionId="session-1"
      />,
    );

    expect(screen.getByText('scheepstimmerman')).toBeTruthy();
    expect(screen.queryByText('Tomas')).toBeNull();
    expect(screen.queryByText('Scheepstimmerman')).toBeNull();
  });
});

describe('ChatComposer /open command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.revealProject).mockResolvedValue({ ok: true, path: '/tmp/project' });
  });

  it.each(['workspace', 'artifacts'] as const)(
    'opens the project %s folder locally without sending a chat turn',
    async (folder) => {
      render(
        <ChatComposer
          gezelId="tomas"
          gezelName="Tomas"
          projectId="project-1"
          sessionId="session-1"
        />,
      );

      fireEvent.change(screen.getByLabelText('Message'), {
        target: { value: `/open ${folder}` },
      });
      expect(screen.getByRole('menuitem', { name: `Open ${folder} folder` })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Press Enter' }));

      await waitFor(() => expect(api.revealProject).toHaveBeenCalledWith('project-1', folder));
      expect(api.sendToChatSession).not.toHaveBeenCalled();
      expect(api.createChatSession).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId('editor-draft')).toHaveTextContent(''));
    },
  );

  it('offers and opens a recent chat file in the References viewer', async () => {
    const onOpenReference = vi.fn();
    const reference = {
      key: 'workspace:project-1:security/review-scope.md',
      kind: 'workspace' as const,
      path: 'security/review-scope.md',
      projectId: 'project-1',
    };
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="project-1"
        sessionId="session-1"
        recentReferences={[reference]}
        onOpenReference={onOpenReference}
      />,
    );

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '/open scope' } });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open security/review-scope.md' }));

    expect(onOpenReference).toHaveBeenCalledWith(reference);
    expect(api.revealProject).not.toHaveBeenCalled();
    expect(api.sendToChatSession).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('editor-draft')).toHaveTextContent(''));
  });

  it('keeps an unknown target in the editor and explains how to recover', async () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="project-1"
        sessionId="session-1"
      />,
    );

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '/open missing.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Press Enter' }));

    expect(await screen.findByText(/no recent file matches/i)).toBeTruthy();
    expect(screen.getByTestId('editor-draft')).toHaveTextContent('/open missing.md');
    expect(api.sendToChatSession).not.toHaveBeenCalled();
  });
});

describe('ChatComposer lossless draft submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [] });
    vi.mocked(streamChatEvents).mockImplementation(() =>
      (async function* completedTurn() {
        yield { type: 'done' as const };
      })(),
    );
  });

  it('keeps the exact editor draft mounted until the daemon accepts it', async () => {
    const request = deferred<{ accepted: true; sessionId: string }>();
    vi.mocked(api.sendToChatSession).mockReturnValue(request.promise);
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    const editor = screen.getByLabelText<HTMLTextAreaElement>('Message');
    const source = '  Review this\n@[Ada](gezel:ada)\n![diagram](attachments/diagram.png)\n  ';
    fireEvent.change(editor, { target: { value: source } });
    editor.setSelectionRange(4, 10);
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(screen.getByLabelText('Message')).toBe(editor);
    expect(editor.value).toBe(source);
    expect(editor.selectionStart).toBe(4);
    expect(editor.selectionEnd).toBe(10);

    await act(async () => {
      request.resolve({ accepted: true, sessionId: 'session-1' });
      await request.promise;
    });

    await waitFor(() => expect(screen.getByTestId('editor-draft').textContent).toBe(''));
    expect(api.sendToChatSession).toHaveBeenCalledWith('session-1', {
      message: source.trim(),
      mentions: ['ada'],
    });
  });

  it('preserves the draft and editor instance when session creation fails', async () => {
    vi.mocked(api.createChatSession).mockRejectedValue(new Error('Failed to fetch'));
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId={undefined} />,
    );

    const editor = screen.getByLabelText<HTMLTextAreaElement>('Message');
    const source = 'A carefully written prompt for @[Ada](gezel:ada)';
    fireEvent.change(editor, { target: { value: source } });
    expect(screen.getByTitle('@Ada')).toBeTruthy();
    editor.setSelectionRange(2, 12);
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText(/lost the connection to the gezel service/i)).toBeTruthy();
    expect(screen.getByLabelText('Message')).toBe(editor);
    expect(editor.value).toBe(source);
    expect(screen.getByTitle('@Ada')).toBeTruthy();
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(12);
    expect(api.sendToChatSession).not.toHaveBeenCalled();
  });

  it.each([
    ['transport failure', new TypeError('Failed to fetch')],
    ['non-2xx response', new Error('Gezel API POST failed (503): service unavailable')],
    [
      'request cancellation',
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    ],
  ])('preserves exact source after a %s', async (_label, failure) => {
    vi.mocked(api.sendToChatSession).mockRejectedValue(failure);
    vi.mocked(streamChatEvents).mockImplementation((opts) =>
      (async function* waitForAbort() {
        await new Promise<void>((_, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (opts.signal?.aborted) abort();
          else opts.signal?.addEventListener('abort', abort, { once: true });
        });
      })(),
    );
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    const source = 'Draft with attachment ![x](attachments/x.png)  ';
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: source } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    expect(screen.getByTestId('editor-draft').textContent).toBe(source);
  });

  it('does not clear text typed while the acceptance response is pending', async () => {
    const request = deferred<{ accepted: true; sessionId: string }>();
    vi.mocked(api.sendToChatSession).mockReturnValue(request.promise);
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Original draft' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'New text typed while sending' },
    });

    await act(async () => {
      request.resolve({ accepted: true, sessionId: 'session-1' });
      await request.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('editor-draft').textContent).toBe('New text typed while sending');
    });
  });

  it('locks synchronously so a double submission creates and sends only once', async () => {
    const creation = deferred<{ id: string }>();
    vi.mocked(api.createChatSession).mockReturnValue(creation.promise as never);
    vi.mocked(api.sendToChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'created-session',
    });
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId={undefined} />,
    );

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Send exactly once' } });
    const sendButton = screen.getByRole('button', { name: /^send$/i });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    await waitFor(() => expect(api.createChatSession).toHaveBeenCalledTimes(1));
    await act(async () => {
      creation.resolve({ id: 'created-session' });
      await creation.promise;
    });
    await waitFor(() => expect(api.sendToChatSession).toHaveBeenCalledTimes(1));
  });
});

describe('ChatComposer server-authoritative cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(streamChatEvents).mockImplementation((opts) =>
      (async function* waitForAbort() {
        await new Promise<void>((_, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (opts.signal?.aborted) abort();
          else opts.signal?.addEventListener('abort', abort, { once: true });
        });
      })(),
    );
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({
      inflight: {
        userText: 'Create the deck',
        startedAt: Date.now() - 5_000,
        elapsedMs: 5_000,
      },
    });
    vi.mocked(api.cancelChatSessionTurn).mockResolvedValue({ cancelled: true });
  });

  it('shows Stop for a turn that is running on the service after a remount', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    expect(await screen.findByRole('button', { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull();
  });

  it('Escape cancels the service turn, not just the local event stream', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await screen.findByRole('button', { name: /stop/i });
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(api.cancelChatSessionTurn).toHaveBeenCalledWith('session-1');
    });
  });

  it('returns to Send when the accepted turn is idle even if the local SSE misses done', async () => {
    let resolveAcceptedPoll: ((value: { inflight: null }) => void) | undefined;
    const acceptedPoll = new Promise<{ inflight: null }>((resolve) => {
      resolveAcceptedPoll = resolve;
    });
    vi.mocked(api.getChatSessionInflight)
      .mockResolvedValueOnce({ inflight: null })
      .mockReturnValueOnce(acceptedPoll);
    vi.mocked(api.sendToChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'session-1',
    });

    let streamSignal: AbortSignal | undefined;
    vi.mocked(streamChatEvents).mockImplementation((opts) => {
      streamSignal = opts.signal;
      return (async function* waitForAbort() {
        await new Promise<void>((_, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (opts.signal?.aborted) abort();
          else opts.signal?.addEventListener('abort', abort, { once: true });
        });
      })();
    });

    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await waitFor(() => {
      expect(api.getChatSessionInflight).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByRole('button', { name: /stop/i })).toBeTruthy();
    await waitFor(() => {
      expect(api.sendToChatSession).toHaveBeenCalledWith('session-1', {
        message: 'Hello from the test',
      });
      expect(api.getChatSessionInflight).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      resolveAcceptedPoll?.({ inflight: null });
      await acceptedPoll;
    });

    expect(await screen.findByRole('button', { name: /^send$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(streamSignal?.aborted).toBe(true);
  });

  it('does not let an idle poll started before acceptance clear the new turn', async () => {
    let resolveStalePoll: ((value: { inflight: null }) => void) | undefined;
    const stalePoll = new Promise<{ inflight: null }>((resolve) => {
      resolveStalePoll = resolve;
    });
    vi.mocked(api.getChatSessionInflight)
      .mockReturnValueOnce(stalePoll)
      .mockResolvedValueOnce({
        inflight: {
          userText: 'Hello from the test',
          startedAt: Date.now(),
          elapsedMs: 0,
        },
      });
    vi.mocked(api.sendToChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'session-1',
    });

    let streamSignal: AbortSignal | undefined;
    vi.mocked(streamChatEvents).mockImplementation((opts) => {
      streamSignal = opts.signal;
      return (async function* waitForAbort() {
        await new Promise<void>((_, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (opts.signal?.aborted) abort();
          else opts.signal?.addEventListener('abort', abort, { once: true });
        });
      })();
    });

    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await waitFor(() => {
      expect(api.getChatSessionInflight).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByRole('button', { name: /stop/i })).toBeTruthy();
    await waitFor(() => {
      expect(api.getChatSessionInflight).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      resolveStalePoll?.({ inflight: null });
      await stalePoll;
    });

    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull();
    expect(streamSignal?.aborted).toBe(false);
  });
});

describe('ChatComposer mid-turn nudge + interrupt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({
      inflight: {
        userText: 'Create the deck',
        startedAt: Date.now() - 5_000,
        elapsedMs: 5_000,
      },
    });
    vi.mocked(api.sendToChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'session-1',
    });
    vi.mocked(api.interruptChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'session-1',
    });
  });

  it('shows only Stop while the draft is empty', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    expect(await screen.findByRole('button', { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^nudge$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^interrupt$/i })).toBeNull();
  });

  it('typing mid-turn reveals Nudge + Interrupt, and Nudge queues with the flag', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await screen.findByRole('button', { name: /stop/i });
    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));

    const nudgeBtn = await screen.findByRole('button', { name: /^nudge$/i });
    expect(screen.getByRole('button', { name: /^interrupt$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();

    fireEvent.click(nudgeBtn);
    await waitFor(() => {
      expect(api.sendToChatSession).toHaveBeenCalledWith('session-1', {
        message: 'Hello from the test',
        nudge: true,
      });
    });
    // The draft cleared: the editor remounted empty and the mid-turn
    // action buttons folded back to Stop only.
    await waitFor(() => {
      expect(screen.getByTestId('editor-draft').textContent).toBe('');
    });
    expect(screen.queryByRole('button', { name: /^nudge$/i })).toBeNull();
  });

  it('Enter mid-turn queues a nudge instead of silently doing nothing', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await screen.findByRole('button', { name: /stop/i });
    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Press Enter' }));

    await waitFor(() => {
      expect(api.sendToChatSession).toHaveBeenCalledWith('session-1', {
        message: 'Hello from the test',
        nudge: true,
      });
    });
  });

  it('Interrupt sends the draft through the interrupt endpoint', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await screen.findByRole('button', { name: /stop/i });
    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^interrupt$/i }));

    await waitFor(() => {
      expect(api.interruptChatSession).toHaveBeenCalledWith('session-1', {
        message: 'Hello from the test',
      });
    });
    expect(api.sendToChatSession).not.toHaveBeenCalled();
  });

  it.each([
    ['Nudge', 'sendToChatSession'],
    ['Interrupt', 'interruptChatSession'],
  ] as const)('keeps the live draft when %s submission fails', async (buttonName, method) => {
    vi.mocked(api[method]).mockRejectedValue(new Error('service unavailable'));
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await screen.findByRole('button', { name: /stop/i });
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Message');
    fireEvent.change(editor, { target: { value: 'Do not lose this steering note' } });
    editor.setSelectionRange(3, 11);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${buttonName}$`, 'i') }));

    expect(await screen.findByText('service unavailable')).toBeTruthy();
    expect(screen.getByLabelText('Message')).toBe(editor);
    expect(editor.value).toBe('Do not lose this steering note');
    expect(editor.selectionStart).toBe(3);
    expect(editor.selectionEnd).toBe(11);
  });
});

describe('ChatComposer recipient picker', () => {
  const gezels = [
    { id: 'tomas', name: 'Tomas', role: 'Meester', updatedAt: '2026-07-30T00:00:00.000Z' },
    { id: 'ada', name: 'Ada', role: 'Developer', updatedAt: '2026-07-30T00:00:00.000Z' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.sendToChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'session-1',
    });
    vi.mocked(streamChatEvents).mockImplementation((opts) =>
      (async function* waitForAbort() {
        await new Promise<void>((_, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (opts.signal?.aborted) abort();
          else opts.signal?.addEventListener('abort', abort, { once: true });
        });
      })(),
    );
  });

  it('uses the row action to replace the primary recipient', async () => {
    const onPrimaryRecipientChange = vi.fn();
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        recipientGezels={gezels}
        onPrimaryRecipientChange={onPrimaryRecipientChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose recipients' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Talk to Ada' }));

    expect(onPrimaryRecipientChange).toHaveBeenCalledWith('ada');
  });

  it('refreshes the recipient placeholder without losing the current draft', () => {
    const { rerender } = render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        placeholder="Ask Tomas a question."
      />,
    );

    expect(screen.getByTestId('editor-placeholder').textContent).toBe('Ask Tomas a question.');
    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    expect(screen.getByTestId('editor-draft').textContent).toBe('Hello from the test');

    rerender(
      <ChatComposer
        gezelId="ada"
        gezelName="Ada"
        projectId="default"
        sessionId="session-1"
        placeholder="Ask Ada a question."
      />,
    );

    expect(screen.getByTestId('editor-placeholder').textContent).toBe('Ask Ada a question.');
    expect(screen.getByTestId('editor-draft').textContent).toBe('Hello from the test');
  });

  it('adds a secondary recipient to the To line and fans the message out', async () => {
    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        recipientGezels={gezels}
        onPrimaryRecipientChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose recipients' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Ada to recipients' }));

    expect(screen.getByRole('button', { name: 'Remove Ada from recipients' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Ada to recipients' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(api.sendToChatSession).toHaveBeenCalledWith('session-1', {
        message: 'Hello from the test',
        mentions: ['ada'],
      });
    });
  });
});

describe('ChatComposer ordinary-session fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [
        {
          id: 'night-shift-session',
          gezelId: 'tomas',
          projectId: 'default',
          title: 'Night-shift oversight',
          taskRef: 'default/1',
          archived: false,
          providerName: 'openai',
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
        },
        {
          id: 'ordinary-session',
          gezelId: 'tomas',
          projectId: 'default',
          title: 'Morning chat',
          archived: false,
          providerName: 'openai',
          createdAt: new Date(Date.now() - 1_000).toISOString(),
          lastActivityAt: new Date(Date.now() - 1_000).toISOString(),
        },
      ],
    });
    vi.mocked(api.sendToChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'ordinary-session',
    });
    vi.mocked(streamChatEvents).mockImplementation(() =>
      (async function* completedTurn() {
        yield { type: 'done' as const };
      })(),
    );
  });

  it('skips a newer task session when the switcher has not auto-picked yet', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId={undefined} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(api.sendToChatSession).toHaveBeenCalledWith('ordinary-session', {
        message: 'Hello from the test',
      });
    });
    expect(api.createChatSession).not.toHaveBeenCalled();
  });
});

describe('ChatComposer transport resilience', () => {
  const toolEvent = (name: string) => ({
    type: 'tool' as const,
    name,
    durationMs: 10,
    success: true,
  });
  const transportError = () => {
    // Chromium's exact message when a fetch body stream dies mid-read —
    // the raw string that used to land verbatim in the composer.
    return new TypeError('network error');
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.sendToChatSession).mockResolvedValue({
      accepted: true,
      sessionId: 'session-1',
    });
  });

  it('reconnects after a mid-turn transport break and dedupes replayed tool events', async () => {
    // Mount poll idle; the post-send poll must report the turn still
    // running so it doesn't settle the turn before the reconnect fires;
    // later polls go idle again once the reconnected stream delivers done.
    vi.mocked(api.getChatSessionInflight)
      .mockResolvedValueOnce({ inflight: null })
      .mockResolvedValueOnce({
        inflight: { userText: 'Hello from the test', startedAt: Date.now(), elapsedMs: 0 },
      })
      .mockResolvedValue({ inflight: null });

    const onToolActivity = vi.fn();
    vi.mocked(streamChatEvents)
      .mockImplementationOnce(() =>
        (async function* firstConnection() {
          yield toolEvent('read_file');
          yield toolEvent('write_file');
          throw transportError();
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* reconnectedWithReplay() {
          // The event bus replays the in-flight turn's history on
          // resubscribe — the composer must not re-emit these two.
          yield toolEvent('read_file');
          yield toolEvent('write_file');
          yield toolEvent('list_dir');
          yield { type: 'done' as const };
        })(),
      );

    render(
      <ChatComposer
        gezelId="tomas"
        gezelName="Tomas"
        projectId="default"
        sessionId="session-1"
        onToolActivity={onToolActivity}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(streamChatEvents).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(await screen.findByRole('button', { name: /^send$/i }, { timeout: 3_000 })).toBeTruthy();
    expect(onToolActivity).toHaveBeenCalledTimes(3);
    expect(onToolActivity.mock.calls.map(([tool]) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'list_dir',
    ]);
    expect(screen.queryByText(/network error/i)).toBeNull();
  });

  it('names an unavailable model plainly instead of showing the broker JSON', async () => {
    // Wild-caught: an install default pinned a download that never finished, so
    // every send painted `[remote] /v1/remote/admit returned HTTP 404
    // {"error":"model_not_loaded","model":"llama-cpp:qwen3.6-27b-q8"}` in red
    // under the composer. The service humanizes this at its source now; the
    // composer is the backstop for older daemons and other paths that
    // stringify the rejection.
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({ inflight: null });
    vi.mocked(streamChatEvents).mockImplementation(() =>
      (async function* rejectedTurn() {
        yield {
          type: 'error' as const,
          error:
            '[remote] /v1/remote/admit returned HTTP 404 {"error":"model_not_loaded","model":"llama-cpp:qwen3.6-27b-q8"}',
        };
      })(),
    );

    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    const message = await screen.findByText(/isn't available on this device/i, undefined, {
      timeout: 3_000,
    });
    expect(message.textContent).toContain('qwen3.6-27b-q8');
    expect(message.textContent).toMatch(/Settings → Artificial Intelligence/);
    expect(screen.queryByText(/model_not_loaded/)).toBeNull();
    expect(screen.queryByText(/HTTP 404/)).toBeNull();
  });

  it('gives up after repeated transport failures with a readable message, not the raw error', async () => {
    vi.useFakeTimers();
    try {
      // Mount poll idle, then the daemon is unreachable — the inflight
      // poll rejecting must not mask or clear the transport failure.
      vi.mocked(api.getChatSessionInflight)
        .mockResolvedValueOnce({ inflight: null })
        .mockRejectedValue(new Error('Gezel API transport unavailable on GET: Failed to fetch'));
      vi.mocked(streamChatEvents).mockImplementation(() =>
        // biome-ignore lint/correctness/useYield: the stream dies before yielding any frame
        (async function* alwaysBroken() {
          throw transportError();
        })(),
      );

      render(
        <ChatComposer
          gezelId="tomas"
          gezelName="Tomas"
          projectId="default"
          sessionId="session-1"
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Fill draft' }));
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

      // Walk through every reconnect backoff (500+1000+2000+4000+5000ms).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(streamChatEvents).toHaveBeenCalledTimes(6);
      expect(screen.getByText(/lost the connection to the gezel service/i)).toBeTruthy();
      expect(screen.queryByText(/^network error$/i)).toBeNull();
      expect(screen.getByRole('button', { name: /^send$/i })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
