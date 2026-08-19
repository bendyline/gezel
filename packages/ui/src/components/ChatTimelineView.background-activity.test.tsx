import type { ChatEventEnvelope, ListTimelineResponse } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));

vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* ({
    signal,
  }: {
    signal?: AbortSignal;
  }) {
    yield {
      sessionId: 'one-shot:index-file',
      gezelId: 'mhairi',
      projectId: 'website',
      event: {
        type: 'engine_phase',
        provider: 'mlx',
        phase: 'generating',
        activity: 'Indexing foo.html',
        detail: 'Generating',
      },
    } satisfies ChatEventEnvelope;
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
  },
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

describe('ChatTimelineView — background one-shot activity', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'mhairi', name: 'Mhairi', role: 'Boekwachter' }],
    } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'website', name: 'Website' }],
    } as never);
  });

  it('names the activity instead of presenting the one-shot as a new chat thread', async () => {
    render(
      <ChatTimelineView
        scopeKey="global"
        activeSessionId={undefined}
        loadTimeline={async () => ({ messages: [], hasMore: false }) as ListTimelineResponse}
        streamUrl={() => 'https://example.invalid/events'}
        showProjectName
      />,
    );

    const divider = await waitFor(() => {
      const node = document.querySelector('.timeline-session-divider-activity');
      if (!node) throw new Error('background activity divider not rendered');
      return node;
    });
    expect(divider).toHaveTextContent('Mhairi · Indexing foo.html · in Website');
    expect(divider.tagName).toBe('OUTPUT');
    expect(screen.queryByText(/new thread with Mhairi/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Indexing foo\.html · Generating/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });
});
