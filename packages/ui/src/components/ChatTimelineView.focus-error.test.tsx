import type {
  ListTimelineResponse,
  TerminalTimelineEntry,
  TimelineMessage,
} from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
// The SSE bridge would otherwise open a real EventSource loop per mount.
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* () {
    // Never yields; the test only exercises the persisted timeline.
  },
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');
const { publishOptimisticUserMessage } = await import('./chat-optimistic-events.js');
const { queueFocusSessionError } = await import('./pending-focus-session-error.js');

function message(overrides: Partial<TimelineMessage>): TimelineMessage {
  return {
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: 'Ship it',
    sessionCreatedAt: '2026-07-25T10:00:00.000Z',
    sessionLastActivityAt: '2026-07-25T10:00:00.000Z',
    sessionProviderName: 'mock',
    role: 'user',
    content: 'do the thing',
    at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  } as TimelineMessage;
}

const MESSAGES: TimelineMessage[] = [
  message({ sessionId: 's1', content: 'earlier chat', at: '2026-07-25T09:00:00.000Z' }),
  message({
    sessionId: 's2',
    gezelId: 'g2',
    content: 'the turn that blew up',
    at: '2026-07-25T10:00:00.000Z',
    sessionLastTurnError: 'engine crashed',
  }),
];

function renderTimeline(onFocusSession = vi.fn(), timelineMessages = MESSAGES) {
  const loadTimeline = vi.fn(
    async (): Promise<ListTimelineResponse> =>
      ({ messages: timelineMessages, hasMore: false }) as ListTimelineResponse,
  );
  render(
    <ChatTimelineView
      scopeKey="project:p1"
      activeSessionId={undefined}
      loadTimeline={loadTimeline}
      streamUrl={() => 'https://example.invalid/events'}
      inflightScope={{ projectId: 'p1' }}
      onFocusSession={onFocusSession}
    />,
  );
  return onFocusSession;
}

describe('ChatTimelineView — jumping to a failed turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom implements neither scroll API the timeline drives.
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('flashes the failed-turn banner and points the composer at that session (live event)', async () => {
    const onFocusSession = renderTimeline();
    const banner = await waitFor(() => {
      const el = document.querySelector('[data-session-error="s2"]');
      if (!el) throw new Error('banner not rendered yet');
      return el as HTMLElement;
    });
    expect(banner).toHaveTextContent('engine crashed');
    expect(banner.className).not.toContain('timeline-focus-flash');

    window.dispatchEvent(
      new CustomEvent('gezel:focus-session-error', {
        detail: { projectId: 'p1', sessionId: 's2' },
      }),
    );

    await waitFor(() => expect(banner.className).toContain('timeline-focus-flash'));
    expect(banner.scrollIntoView).toHaveBeenCalled();
    expect(onFocusSession).toHaveBeenCalledWith('s2', 'g2', 'p1');
  });

  it('consumes a queued intent when the timeline mounts after the click', async () => {
    queueFocusSessionError({ projectId: 'p1', sessionId: 's2' });
    const onFocusSession = renderTimeline();

    await waitFor(() =>
      expect(document.querySelector('.timeline-focus-flash')).toHaveAttribute(
        'data-session-error',
        's2',
      ),
    );
    expect(onFocusSession).toHaveBeenCalledWith('s2', 'g2', 'p1');
  });

  it('loads older pages until a busy project timeline reaches the failed session', async () => {
    const newest = message({
      sessionId: 's3',
      gezelId: 'g3',
      content: 'newer task chatter',
      at: '2026-07-25T12:00:00.000Z',
    });
    const middle = message({
      sessionId: 's1',
      content: 'still newer than the failure',
      at: '2026-07-25T11:00:00.000Z',
    });
    const failed = message({
      sessionId: 's2',
      gezelId: 'g2',
      content: 'the older turn that blew up',
      at: '2026-07-25T10:00:00.000Z',
      sessionLastTurnError: 'engine crashed behind task chatter',
    });
    const loadTimeline = vi.fn(
      async (opts: { limit: number; before?: string }): Promise<ListTimelineResponse> => {
        if (opts.before === 'cursor-2') {
          return { messages: [failed], hasMore: false } as ListTimelineResponse;
        }
        if (opts.before === 'cursor-1') {
          return {
            messages: [middle],
            hasMore: true,
            nextCursor: 'cursor-2',
          } as ListTimelineResponse;
        }
        return {
          messages: [newest],
          hasMore: true,
          nextCursor: 'cursor-1',
        } as ListTimelineResponse;
      },
    );
    const onFocusSession = vi.fn();
    queueFocusSessionError({ projectId: 'p1', sessionId: 's2' });

    render(
      <ChatTimelineView
        scopeKey="project:p1"
        activeSessionId={undefined}
        loadTimeline={loadTimeline}
        streamUrl={() => 'https://example.invalid/events'}
        inflightScope={{ projectId: 'p1' }}
        onFocusSession={onFocusSession}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector('.timeline-focus-flash')).toHaveAttribute(
        'data-session-error',
        's2',
      ),
    );
    expect(loadTimeline).toHaveBeenCalledWith({ limit: 100, before: 'cursor-1' });
    expect(loadTimeline).toHaveBeenCalledWith({ limit: 100, before: 'cursor-2' });
    expect(onFocusSession).toHaveBeenCalledWith('s2', 'g2', 'p1');
  });

  it('ignores a jump aimed at another project', async () => {
    const onFocusSession = renderTimeline();
    await screen.findByText('the turn that blew up');

    window.dispatchEvent(
      new CustomEvent('gezel:focus-session-error', {
        detail: { projectId: 'other', sessionId: 's2' },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('.timeline-focus-flash')).toBeNull();
    expect(onFocusSession).not.toHaveBeenCalled();
  });

  it('does not render failed-turn recovery UI for an intentionally stopped turn', async () => {
    renderTimeline(vi.fn(), [
      message({ content: 'please start', at: '2026-07-25T10:00:00.000Z' }),
      message({
        role: 'assistant',
        content: 'Partial answer preserved before I stopped.',
        at: '2026-07-25T10:00:01.000Z',
      }),
    ]);

    await screen.findByText('Partial answer preserved before I stopped.');
    expect(screen.queryByText(/Last turn failed:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('does not offer a GitHub report for a caller-cancelled turn', async () => {
    renderTimeline(vi.fn(), [
      message({
        sessionLastTurnError: '[Mac AI] turn cancelled by caller',
      }),
    ]);

    await screen.findByText(/turn cancelled by caller/);
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: /report error on github/i })).toBeNull();
  });

  it('offers a real Retry plus Acknowledge for a recoverable engine failure', async () => {
    vi.mocked(api.retryChatSessionTurn).mockResolvedValue({
      accepted: true,
      sessionId: 's1',
    } as never);
    renderTimeline(vi.fn(), [
      message({
        sessionLastTurnError:
          '[Mac AI] the on-device engine dropped the connection mid-turn. Retry the turn.',
        sessionLastTurnErrorDetail: {
          code: 'native-engine-crash',
          engine: 'mlx',
        },
      }),
    ]);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeVisible();
    fireEvent.click(retry);

    await waitFor(() => expect(api.retryChatSessionTurn).toHaveBeenCalledWith('s1'));
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
  });

  it('acknowledges the alert without retrying the turn', async () => {
    vi.mocked(api.clearProjectErrors).mockResolvedValue({ cleared: 1 } as never);
    renderTimeline();

    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(api.clearProjectErrors).toHaveBeenCalledWith('p1'));
    expect(api.retryChatSessionTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Last turn failed/)).toBeNull());
  });

  it('keeps a failed acknowledge visible and explains that the click failed', async () => {
    vi.mocked(api.clearProjectErrors).mockRejectedValue(new Error('offline'));
    renderTimeline();

    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));

    expect(
      await screen.findByText('Could not clear the alert. Check the connection and try again.'),
    ).toBeVisible();
    expect(screen.getByText(/Last turn failed/)).toBeVisible();
  });

  it('keeps the scrollbar visible briefly while the timeline is scrolling', async () => {
    renderTimeline();
    const timeline = await screen.findByTestId('chat-timeline');
    vi.useFakeTimers();
    try {
      fireEvent.scroll(timeline);
      expect(timeline).toHaveClass('chat-timeline-scrolling');

      act(() => vi.advanceTimersByTime(699));
      expect(timeline).toHaveClass('chat-timeline-scrolling');

      act(() => vi.advanceTimersByTime(1));
      expect(timeline).not.toHaveClass('chat-timeline-scrolling');
    } finally {
      vi.useRealTimers();
    }
  });

  it('brings a locally submitted chat prompt into view even when the reader was unpinned', async () => {
    renderTimeline(vi.fn(), [
      message({ sessionId: 's1', content: 'older context', at: '2026-07-25T09:00:00.000Z' }),
    ]);
    await screen.findByText('older context');
    const timeline = screen.getByTestId('chat-timeline');
    Object.defineProperties(timeline, {
      scrollTop: { configurable: true, writable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
    });
    fireEvent.scroll(timeline);
    await screen.findByRole('button', { name: 'Jump to newest and follow' });
    vi.mocked(timeline.scrollTo).mockClear();

    act(() => {
      publishOptimisticUserMessage({
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        content: 'new prompt from me',
        at: '2026-07-25T11:00:00.000Z',
      });
    });

    await screen.findByText('new prompt from me');
    await waitFor(() => expect(timeline.scrollTo).toHaveBeenCalledWith({ top: 88 }));
    expect(document.querySelector('.timeline-response-runway')).toBeInTheDocument();
  });

  it('brings an acknowledged terminal command into view', async () => {
    const command: TerminalTimelineEntry = {
      threadId: 'terminal-1',
      projectId: 'p1',
      workingDir: '',
      threadCreatedAt: '2026-07-25T11:00:00.000Z',
      threadLastActivityAt: '2026-07-25T11:00:00.000Z',
      messageId: 'terminal-message-1',
      msgKind: 'command',
      content: 'pnpm test',
      resolvedFrom: 'test',
      at: '2026-07-25T11:00:00.000Z',
    };
    const loadTimeline = vi.fn(
      async (): Promise<ListTimelineResponse> =>
        ({
          messages: [],
          terminalEntries: [command],
          hasMore: false,
        }) as ListTimelineResponse,
    );
    const props = {
      scopeKey: 'project:p1',
      activeSessionId: undefined,
      loadTimeline,
      streamUrl: () => 'https://example.invalid/events',
      inflightScope: { projectId: 'p1' },
    };
    const view = render(<ChatTimelineView {...props} />);
    const commandRow = await waitFor(() => {
      const el = document.querySelector('[data-terminal-message-id="terminal-message-1"]');
      if (!el) throw new Error('terminal command not rendered yet');
      return el;
    });
    expect(commandRow).toHaveTextContent('pnpm test');
    const timeline = screen.getByTestId('chat-timeline');
    Object.defineProperty(timeline, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 100,
    });
    vi.mocked(timeline.scrollTo).mockClear();

    view.rerender(
      <ChatTimelineView
        {...props}
        terminalSubmission={{
          runId: 'run-1',
          threadId: 'terminal-1',
          input: 'test',
        }}
      />,
    );

    await waitFor(() => expect(timeline.scrollTo).toHaveBeenCalledWith({ top: 88 }));
  });

  it('jumps a recent-terminal chip to the newest row in that terminal thread', async () => {
    const command: TerminalTimelineEntry = {
      threadId: 'terminal-1',
      projectId: 'p1',
      workingDir: '',
      threadCreatedAt: '2026-07-25T11:00:00.000Z',
      threadLastActivityAt: '2026-07-25T11:00:01.000Z',
      messageId: 'terminal-command-1',
      msgKind: 'command',
      content: 'ls',
      at: '2026-07-25T11:00:00.000Z',
    };
    const output: TerminalTimelineEntry = {
      ...command,
      messageId: 'terminal-output-1',
      msgKind: 'output',
      content: 'alpha.txt',
      at: '2026-07-25T11:00:01.000Z',
      exitCode: 0,
    };
    const props = {
      scopeKey: 'project:p1',
      activeSessionId: undefined,
      loadTimeline: async (): Promise<ListTimelineResponse> => ({
        messages: [],
        terminalEntries: [command, output],
        hasMore: false,
      }),
      streamUrl: () => 'https://example.invalid/events',
      inflightScope: { projectId: 'p1' },
    };
    const view = render(<ChatTimelineView {...props} />);
    const outputRow = await waitFor(() => {
      const el = document.querySelector('[data-terminal-message-id="terminal-output-1"]');
      if (!el) throw new Error('terminal output not rendered yet');
      return el as HTMLElement;
    });

    view.rerender(
      <ChatTimelineView
        {...props}
        terminalFocusRequest={{ threadId: 'terminal-1', requestKey: 1 }}
      />,
    );

    await waitFor(() => expect(outputRow.scrollIntoView).toHaveBeenCalledWith({ block: 'center' }));
    expect(outputRow).toHaveClass('timeline-focus-flash');
    expect(screen.getByRole('button', { name: 'Jump to newest and follow' })).toBeVisible();
  });
});
