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
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
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
});
