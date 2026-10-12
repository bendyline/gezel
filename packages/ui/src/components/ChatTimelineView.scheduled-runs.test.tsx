import type { ChatEventEnvelope, ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const stream = vi.hoisted(() => {
  const pending: ChatEventEnvelope[] = [];
  let wake: (() => void) | null = null;
  return {
    push(envelope: ChatEventEnvelope) {
      pending.push(envelope);
      wake?.();
      wake = null;
    },
    reset() {
      pending.length = 0;
      wake = null;
    },
    async *consume(): AsyncGenerator<ChatEventEnvelope> {
      while (true) {
        while (pending.length > 0) yield pending.shift() as ChatEventEnvelope;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
});

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: () => stream.consume(),
  streamSharedAllChatEvents: () => stream.consume(),
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

const seed: TimelineMessage = {
  sessionId: 'front-door',
  gezelId: 'meester',
  projectId: 'default',
  sessionTitle: 'Trip',
  sessionCreatedAt: '2026-10-11T22:40:00.000Z',
  sessionLastActivityAt: '2026-10-11T22:40:00.000Z',
  sessionProviderName: 'llama-cpp',
  role: 'user',
  content: 'Plan a trip to Lisbon',
  at: '2026-10-11T22:40:00.000Z',
} as TimelineMessage;

function userMessage(sessionId: string, content: string, at: string, scheduledRun?: true) {
  return {
    sessionId,
    gezelId: 'meester',
    projectId: 'default',
    ...(scheduledRun ? { scheduledRun } : {}),
    event: { type: 'user_message', message: { role: 'user', content, at } },
  } as ChatEventEnvelope;
}

function renderTimeline(hideScheduledRuns: boolean) {
  render(
    <ChatTimelineView
      scopeKey="global"
      activeSessionId={undefined}
      loadTimeline={async () => ({ messages: [seed], hasMore: false }) as ListTimelineResponse}
      streamUrl={() => 'https://example.invalid/events'}
      hideScheduledRuns={hideScheduledRuns}
    />,
  );
}

describe('ChatTimelineView — scheduled runs', () => {
  beforeEach(() => {
    stream.reset();
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'meester', name: 'Ulrike', role: 'Meester' }],
    } as never);
  });

  // A night-shift review that started while Home was open streamed into the
  // Meester's conversation, beside the welcome it had already replaced once.
  it('keeps a scheduled run out of Home as it streams', async () => {
    renderTimeline(true);
    await screen.findByText('Plan a trip to Lisbon');
    stream.push(userMessage('night', 'Review active projects', '2026-10-11T22:46:00.000Z', true));
    stream.push(userMessage('front-door', 'About a week', '2026-10-11T22:47:00.000Z'));
    expect(await screen.findByText('About a week')).toBeInTheDocument();
    expect(screen.queryByText('Review active projects')).not.toBeInTheDocument();
  });

  it('shows scheduled runs everywhere else', async () => {
    renderTimeline(false);
    await screen.findByText('Plan a trip to Lisbon');
    stream.push(userMessage('night', 'Review active projects', '2026-10-11T22:46:00.000Z', true));
    expect(await screen.findByText('Review active projects')).toBeInTheDocument();
  });
});
