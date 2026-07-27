import type { ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
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

function renderTimeline(onFocusSession = vi.fn()) {
  const loadTimeline = vi.fn(
    async (): Promise<ListTimelineResponse> =>
      ({ messages: MESSAGES, hasMore: false }) as ListTimelineResponse,
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
});
