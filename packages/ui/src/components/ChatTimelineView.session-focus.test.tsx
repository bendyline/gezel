import type { ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* () {
    // Never yields; the test only exercises the persisted timeline.
  },
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');

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
  message({ sessionId: 's1', content: 'the older thread', at: '2026-07-25T09:00:00.000Z' }),
  message({
    sessionId: 's2',
    gezelId: 'g2',
    content: 'the thread the chip points at',
    at: '2026-07-25T10:00:00.000Z',
  }),
];

function renderTimeline(opts?: {
  sessionFocusRequest?: { sessionId: string; requestKey: number };
  loadTimeline?: () => Promise<ListTimelineResponse>;
}) {
  const onFocusSession = vi.fn<(sessionId: string, gezelId: string, projectId: string) => void>();
  const loadTimeline =
    opts?.loadTimeline ??
    vi.fn(async (): Promise<ListTimelineResponse> => ({ messages: MESSAGES, hasMore: false }));
  const view = render(
    <ChatTimelineView
      scopeKey="project:p1"
      activeSessionId={undefined}
      loadTimeline={loadTimeline}
      streamUrl={() => 'https://example.invalid/events'}
      inflightScope={{ projectId: 'p1' }}
      onFocusSession={onFocusSession}
      {...(opts?.sessionFocusRequest ? { sessionFocusRequest: opts.sessionFocusRequest } : {})}
    />,
  );
  const rerenderWith = (sessionFocusRequest: { sessionId: string; requestKey: number }) =>
    view.rerender(
      <ChatTimelineView
        scopeKey="project:p1"
        activeSessionId={undefined}
        loadTimeline={loadTimeline}
        streamUrl={() => 'https://example.invalid/events'}
        inflightScope={{ projectId: 'p1' }}
        onFocusSession={onFocusSession}
        sessionFocusRequest={sessionFocusRequest}
      />,
    );
  return { onFocusSession, rerenderWith };
}

function bubblesFor(sessionId: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-session-id="${sessionId}"]`)];
}

describe('ChatTimelineView — task-bar chip session focus', () => {
  beforeEach(() => {
    // jsdom implements neither scroll API the timeline drives.
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('scrolls to and flashes the requested session without re-notifying the parent', async () => {
    const { onFocusSession, rerenderWith } = renderTimeline();
    await waitFor(() => expect(bubblesFor('s2').length).toBeGreaterThan(0));

    rerenderWith({ sessionId: 's2', requestKey: 1 });

    const target = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.timeline-focus-flash');
      if (!el) throw new Error('nothing focused yet');
      return el;
    });
    expect(target).toHaveAttribute('data-session-id', 's2');
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    // The chip's own click already pointed the composer at the thread —
    // notifying again would clear a task scope set one tick earlier.
    expect(onFocusSession).not.toHaveBeenCalled();
  });

  it('retries a request that arrives before the session rows have rendered', async () => {
    let release: (value: ListTimelineResponse) => void = () => {};
    const pending = new Promise<ListTimelineResponse>((resolve) => {
      release = resolve;
    });
    renderTimeline({
      sessionFocusRequest: { sessionId: 's2', requestKey: 1 },
      loadTimeline: () => pending,
    });

    expect(document.querySelector('.timeline-focus-flash')).toBeNull();
    release({ messages: MESSAGES, hasMore: false } as ListTimelineResponse);

    await waitFor(() =>
      expect(document.querySelector('.timeline-focus-flash')).toHaveAttribute(
        'data-session-id',
        's2',
      ),
    );
  });

  it('re-fires when the same chip is clicked again after the user scrolled away', async () => {
    const { rerenderWith } = renderTimeline();
    await waitFor(() => expect(bubblesFor('s2').length).toBeGreaterThan(0));

    rerenderWith({ sessionId: 's2', requestKey: 1 });
    const target = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.timeline-focus-flash');
      if (!el) throw new Error('nothing focused yet');
      return el;
    });
    const calls = () => (target.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length;
    const afterFirst = calls();

    rerenderWith({ sessionId: 's2', requestKey: 2 });
    await waitFor(() => expect(calls()).toBeGreaterThan(afterFirst));
  });
});
