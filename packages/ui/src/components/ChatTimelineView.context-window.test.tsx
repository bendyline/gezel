import type { ChatEventEnvelope, ListTimelineResponse } from '@bendyline/gezel';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* ({ signal }: { signal?: AbortSignal }) {
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    return undefined as unknown as ChatEventEnvelope;
  },
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

describe('ChatTimelineView context-window visibility', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'dina', name: 'Dina', role: 'Planner' }],
    } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'history', name: 'History' }],
    } as never);
  });

  it('restores the effective window and compaction count from persisted history', async () => {
    const timeline: ListTimelineResponse = {
      hasMore: false,
      messages: [
        {
          sessionId: 's1',
          gezelId: 'dina',
          projectId: 'history',
          sessionTitle: 'Russo-Japanese War',
          sessionCreatedAt: '2026-09-01T20:00:00.000Z',
          sessionLastActivityAt: '2026-09-01T20:10:00.000Z',
          sessionProviderName: 'llama-cpp',
          sessionModel: 'large-local',
          sessionContextWindow: 40_960,
          sessionContextAutoCompactRatio: 0.7,
          sessionCompactionCount: 2,
          sessionLastCompactedAt: '2026-09-01T20:09:00.000Z',
          role: 'assistant',
          content: '[Earlier in this conversation: retained facts]',
          at: '2026-09-01T20:09:00.000Z',
          synthetic: 'compaction-summary',
          contextCompaction: {
            removedCount: 14,
            contextWindow: 40_960,
            estimatedTokensBefore: 29_100,
            compactionCount: 2,
            autoCompactRatio: 0.7,
          },
        },
      ],
    };

    render(
      <ChatTimelineView
        scopeKey="history"
        activeSessionId="s1"
        loadTimeline={async () => timeline}
        streamUrl={() => 'https://example.invalid/events'}
      />,
    );

    const marker = await screen.findByRole('complementary', {
      name: 'Automatic context compaction',
    });
    expect(within(marker).getByText(/14 earlier messages summarized/)).toHaveTextContent(
      '40K-token window · compaction #2',
    );
    expect(document.querySelector('.chat-context-banner')).toHaveTextContent(
      'Context auto-compacted · 14 earlier messages summarized · 40K-token window · compaction #2',
    );
  });
});
