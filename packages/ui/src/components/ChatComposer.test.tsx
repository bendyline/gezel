// @vitest-environment jsdom

import { streamChatEvents } from '@bendyline/gezel-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';

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
vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    toolbarSlotRight,
    onChange,
  }: {
    toolbarSlotRight?: React.ReactNode;
    onChange?: (value: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onChange?.('Hello from the test')}>
        Fill draft
      </button>
      {toolbarSlotRight}
    </div>
  ),
}));

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
