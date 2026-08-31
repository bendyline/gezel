import type { ChatEventEnvelope, ListTimelineResponse } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

/**
 * Local engines interleave two kinds of `engine_phase` event during a long
 * prefill: real progress parsed from the engine's own `Prefill:` lines, and a
 * bare liveness heartbeat that keeps the engine pill's label and clock alive
 * through the silent stretches between them.
 *
 * Treating the heartbeat as "progress is over" made the bar and its token
 * count blink out every few seconds for the whole prefill — minutes of
 * flicker on a 61K-token prompt. A heartbeat for the phase already showing a
 * bar must leave it alone; a genuine phase change must still clear it.
 */
const events: ChatEventEnvelope[] = [];

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));

vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* ({ signal }: { signal?: AbortSignal }) {
    for (const envelope of events) yield envelope;
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
  },
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function phase(event: Record<string, unknown>): ChatEventEnvelope {
  return {
    sessionId: 'one-shot:review-batch',
    gezelId: 'koray',
    projectId: 'gezel',
    event: { type: 'engine_phase', provider: 'mlx', ...event },
  } as ChatEventEnvelope;
}

const WITH_PROGRESS = phase({
  phase: 'prefill',
  progress: 0.96,
  detail: '59,392 / 61,523 tokens · 242 tok/s',
});
const HEARTBEAT = phase({ phase: 'prefill', detail: 'Processing prompt' });

function renderTimeline() {
  return render(
    <ChatTimelineView
      scopeKey="global"
      activeSessionId={undefined}
      loadTimeline={async () => ({ messages: [], hasMore: false }) as ListTimelineResponse}
      streamUrl={() => 'https://example.invalid/events'}
      showProjectName
    />,
  );
}

describe('ChatTimelineView — prefill progress vs liveness heartbeat', () => {
  beforeEach(() => {
    events.length = 0;
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'koray', name: 'Koray', role: 'Reviewer' }],
    } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'gezel', name: 'Gezel' }],
    } as never);
  });

  it('keeps the bar when a progress-less heartbeat lands mid-prefill', async () => {
    events.push(WITH_PROGRESS, HEARTBEAT);
    renderTimeline();

    const bar = await waitFor(() => screen.getAllByRole('progressbar')[0]);
    expect(bar).toBeDefined();
    // Still the last real reading, not reset or dropped.
    expect(bar).toHaveAttribute('aria-valuenow', '96');
    // The heartbeat's label still lands — only the bar is protected.
    expect(screen.getAllByTitle('Processing prompt').length).toBeGreaterThan(0);
  });

  it('clears the bar when the phase actually changes', async () => {
    events.push(WITH_PROGRESS, phase({ phase: 'generating', detail: 'Generating' }));
    renderTimeline();

    await waitFor(() => {
      if (!document.querySelector('.msg-live-status')) throw new Error('no live status line yet');
    });
    await waitFor(() => {
      expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    });
  });
});
