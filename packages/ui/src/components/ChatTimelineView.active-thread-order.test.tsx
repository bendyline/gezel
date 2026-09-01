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

const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function message(overrides: Partial<TimelineMessage>): TimelineMessage {
  const at = overrides.at ?? minutesAgo(1);
  return {
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: 'Ship it',
    sessionCreatedAt: at,
    sessionLastActivityAt: at,
    sessionProviderName: 'mock',
    role: 'user',
    content: 'do the thing',
    ...overrides,
    at,
  } as TimelineMessage;
}

function renderTimeline(activeSessionId: string | undefined, messages: TimelineMessage[]) {
  const loadTimeline = vi.fn(
    async (): Promise<ListTimelineResponse> => ({ messages, hasMore: false }),
  );
  render(
    <ChatTimelineView
      scopeKey="project:p1"
      activeSessionId={activeSessionId}
      loadTimeline={loadTimeline}
      streamUrl={() => 'https://example.invalid/events'}
      inflightScope={{ projectId: 'p1' }}
    />,
  );
}

function renderedSessionOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-session-id]')].map(
    (el) => el.dataset.sessionId ?? '',
  );
}

describe('ChatTimelineView — the composer thread sits at the bottom', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('puts the active session last even when another session spoke more recently', async () => {
    renderTimeline('s1', [
      message({ sessionId: 's1', content: 'what the composer answers', at: minutesAgo(6) }),
      message({ sessionId: 's2', gezelId: 'g2', content: 'a task talking', at: minutesAgo(1) }),
    ]);
    await waitFor(() => expect(renderedSessionOrder().length).toBe(2));
    expect(renderedSessionOrder().at(-1)).toBe('s1');
  });

  it('keeps a delegated child directly below its active parent thread', async () => {
    renderTimeline('s1', [
      message({ sessionId: 's1', content: 'research the launch', at: minutesAgo(6) }),
      message({
        sessionId: 's2',
        gezelId: 'g2',
        content: 'delegated research',
        at: minutesAgo(1),
        parentSession: { sessionId: 's1', gezelId: 'g1', kind: 'delegation' },
      }),
    ]);

    await waitFor(() => expect(renderedSessionOrder().length).toBe(2));
    expect(renderedSessionOrder()).toEqual(['s1', 's2']);
    const child = document
      .querySelector<HTMLElement>('[data-session-id="s2"]')
      ?.closest<HTMLElement>('.timeline-thread');
    expect(child?.classList.contains('timeline-session-subthread')).toBe(true);
    expect(child?.classList.contains('timeline-session-depth-1')).toBe(true);
  });

  it('renders peer task steps as siblings under the task-launching thread', async () => {
    renderTimeline('s1', [
      message({ sessionId: 's1', content: 'make the deck', at: minutesAgo(6) }),
      message({
        sessionId: 's2',
        gezelId: 'g2',
        content: 'researching',
        at: minutesAgo(4),
        parentSession: { sessionId: 's1', gezelId: 'g1', kind: 'task-entry' },
      }),
      message({
        sessionId: 's3',
        gezelId: 'g3',
        content: 'writing',
        at: minutesAgo(2),
        parentSession: { sessionId: 's1', gezelId: 'g1', kind: 'task-handoff' },
        handoffFrom: { sessionId: 's2', gezelId: 'g2' },
      }),
    ]);

    await waitFor(() => expect(renderedSessionOrder().length).toBe(3));
    expect(renderedSessionOrder()).toEqual(['s1', 's2', 's3']);
    const rootThread = document
      .querySelector<HTMLElement>('[data-session-id="s1"]')
      ?.closest<HTMLElement>('.timeline-thread');
    expect(rootThread?.classList.contains('timeline-session-parent')).toBe(true);
    expect(rootThread?.classList.contains('timeline-thread-railed')).toBe(true);

    const childDividers = [...document.querySelectorAll('.timeline-session-divider-child')];
    expect(childDividers).toHaveLength(2);
    expect(childDividers[0]?.querySelector('.timeline-tree-elbow')).not.toBeNull();
    expect(childDividers[0]?.querySelector('.timeline-tree-parent-line-continues')).not.toBeNull();
    expect(childDividers[1]?.querySelector('.timeline-tree-parent-line-continues')).toBeNull();

    for (const sessionId of ['s2', 's3']) {
      const thread = document
        .querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`)
        ?.closest<HTMLElement>('.timeline-thread');
      expect(thread?.classList.contains('timeline-session-depth-1')).toBe(true);
      expect(thread?.classList.contains('timeline-session-depth-2')).toBe(false);
      expect(thread?.classList.contains('timeline-thread-railed')).toBe(false);
    }
    expect(
      document
        .querySelector<HTMLElement>('[data-session-id="s2"]')
        ?.closest<HTMLElement>('.timeline-thread')
        ?.querySelector('.timeline-tree-guide-thread.timeline-tree-guide-up-1'),
    ).not.toBeNull();
    expect(
      document
        .querySelector<HTMLElement>('[data-session-id="s3"]')
        ?.closest<HTMLElement>('.timeline-thread')
        ?.querySelector('.timeline-tree-guide-thread.timeline-tree-guide-up-1'),
    ).toBeNull();
  });

  it('leaves chronological order alone when the active thread went cold', async () => {
    const stale = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();
    renderTimeline('s1', [
      message({ sessionId: 's1', content: 'last week', at: stale }),
      message({ sessionId: 's2', gezelId: 'g2', content: 'a task talking', at: minutesAgo(1) }),
    ]);
    await waitFor(() => expect(renderedSessionOrder().length).toBe(2));
    expect(renderedSessionOrder()).toEqual(['s1', 's2']);
  });
});
