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
