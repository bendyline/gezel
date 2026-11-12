import type { ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const bubbleRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* () {},
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));
// Count the bubble's own renders behind the same comparator the app uses.
vi.mock('./chat-bubbles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-bubbles.js')>();
  const React = await import('react');
  const real = actual.MessageBubble as unknown as {
    type: React.FC<Record<string, unknown>>;
    compare: (a: Record<string, unknown>, b: Record<string, unknown>) => boolean;
  };
  function CountingBubble(props: Record<string, unknown>) {
    bubbleRenders.count += 1;
    return React.createElement(real.type, props);
  }
  return { ...actual, MessageBubble: React.memo(CountingBubble, real.compare) };
});

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function message(index: number): TimelineMessage {
  const at = new Date(Date.UTC(2026, 10, 11, 10, 0, index * 10)).toISOString();
  return {
    sessionId: `s${index}`,
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: `Thread ${index}`,
    sessionCreatedAt: at,
    sessionLastActivityAt: at,
    sessionProviderName: 'llama-cpp',
    role: 'assistant',
    content: `Answer number ${index}.`,
    at,
  };
}

const messages = Array.from({ length: 20 }, (_, index) => message(index));

describe('ChatTimelineView — bubble renders', () => {
  beforeEach(() => {
    bubbleRenders.count = 0;
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listInflightTurns).mockResolvedValue({ inflight: [] } as never);
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {},
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      at: '',
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'g1', name: 'Ada', role: 'Developer' }],
    } as never);
  });

  it('leaves unchanged bubbles alone when the timeline renders again', async () => {
    const loadTimeline = vi.fn(async () => ({ messages, hasMore: false }) as ListTimelineResponse);
    const props = {
      scopeKey: 'project:p1',
      activeSessionId: undefined,
      loadTimeline,
      streamUrl: () => 'https://example.invalid/events',
      inflightScope: { projectId: 'p1' },
    };
    const { rerender } = render(
      <ChatTimelineView {...props} onArtifactReference={() => undefined} />,
    );
    await screen.findByText('Answer number 19.');
    await waitFor(() => expect(loadTimeline.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(api.listGezels).toHaveBeenCalled());
    await act(async () => Promise.resolve());
    const settled = bubbleRenders.count;
    expect(settled).toBeGreaterThan(0);

    // New handler identities, same data: the timeline renders, its bubbles do not.
    rerender(<ChatTimelineView {...props} onArtifactReference={() => undefined} />);
    rerender(<ChatTimelineView {...props} onArtifactReference={() => undefined} />);
    await act(async () => Promise.resolve());
    expect(bubbleRenders.count).toBe(settled);
  });
});
