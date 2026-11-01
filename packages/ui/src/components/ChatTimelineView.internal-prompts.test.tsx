import type { ChatEventEnvelope, TimelineMessage } from '@bendyline/gezel';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const stream = vi.hoisted(() => {
  const pending: ChatEventEnvelope[] = [];
  let wake: (() => void) | undefined;
  return {
    push(event: ChatEventEnvelope['event']) {
      pending.push({ sessionId: 's1', gezelId: 'g1', projectId: 'p1', event });
      wake?.();
    },
    reset() {
      pending.length = 0;
      wake = undefined;
    },
    async *consume(): AsyncGenerator<ChatEventEnvelope> {
      while (true) {
        while (pending.length) yield pending.shift()!;
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
}));
vi.mock('./GezelIcon.js', () => ({ GezelIcon: () => <span /> }));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function message(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  return {
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: 'Checkers',
    sessionCreatedAt: '2026-10-31T10:00:00Z',
    sessionLastActivityAt: '2026-10-31T10:01:00Z',
    sessionProviderName: 'copilot',
    role: 'user',
    content: 'Let’s play checkers',
    at: '2026-10-31T10:00:00Z',
    ...overrides,
  };
}

function renderTimeline(messages: TimelineMessage[]) {
  return render(
    <ChatTimelineView
      scopeKey="project:p1"
      activeSessionId={undefined}
      loadTimeline={async () => ({ messages, hasMore: false })}
      streamUrl={() => 'https://example.invalid/events'}
      inflightScope={{ projectId: 'p1' }}
    />,
  );
}

function debugMode(enabled: boolean) {
  act(() =>
    window.dispatchEvent(
      new CustomEvent('gezel:config-updated', {
        detail: { debugMode: enabled },
      }),
    ),
  );
}

describe('ChatTimelineView internal prompts', () => {
  beforeEach(() => {
    stream.reset();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock', debugMode: false } as never);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [{ id: 'g1', name: 'Mira' }] } as never);
    vi.mocked(api.listInflightTurns).mockResolvedValue({ inflight: [] } as never);
    vi.mocked(api.getQueueStatus).mockResolvedValue({ sessions: [] } as never);
  });

  it('hides saved internal prompts, keeps human messages and replies, and follows debug changes', async () => {
    renderTimeline([
      message(),
      message({
        origin: 'system',
        content: 'Internal task instructions',
        at: '2026-10-31T10:00:01Z',
      }),
      message({ hidden: true, content: 'Hidden retry instructions', at: '2026-10-31T10:00:02Z' }),
      message({ role: 'assistant', content: 'Your move!', at: '2026-10-31T10:00:03Z' }),
      message({ content: '[Checkers page]: I typed this myself', at: '2026-10-31T10:00:04Z' }),
    ]);
    await screen.findByText('Your move!');
    expect(screen.getByText('Let’s play checkers')).toBeInTheDocument();
    expect(screen.getByText('[Checkers page]: I typed this myself')).toBeInTheDocument();
    expect(screen.queryByText('Internal task instructions')).toBeNull();
    expect(screen.queryByText('Hidden retry instructions')).toBeNull();
    debugMode(true);
    expect(await screen.findByText('Internal task instructions')).toBeInTheDocument();
    expect(screen.getByText('Hidden retry instructions')).toBeInTheDocument();
    debugMode(false);
    expect(screen.queryByText('Internal task instructions')).toBeNull();
    expect(screen.queryByText('Hidden retry instructions')).toBeNull();
  });

  it.each([false, true])(
    'keeps live system prompts hidden (existing chat: %s)',
    async (existing) => {
      renderTimeline(existing ? [message()] : []);
      await waitFor(() => expect(api.getQueueStatus).toHaveBeenCalled());
      stream.push({
        type: 'user_message',
        message: {
          role: 'user',
          content: 'Internal board state',
          origin: 'system',
          hidden: true,
          at: '2026-10-31T10:00:05Z',
        },
      });
      stream.push({ type: 'delta', content: 'Nice move!' });
      await screen.findByText('Nice move!');
      expect(screen.queryByText('Internal board state')).toBeNull();
      debugMode(true);
      expect(await screen.findByText('Internal board state')).toBeInTheDocument();
    },
  );

  it.each(['snapshot', 'stream'] as const)('honors queue visibility from %s', async (source) => {
    const entries = [
      { queueId: 'internal', preview: 'Queued board instructions', origin: 'system' as const },
      { queueId: 'hidden', preview: 'Queued retry instructions', hidden: true },
      { queueId: 'human', preview: 'Can you explain that move?' },
    ].map((entry) => ({ ...entry, enqueuedAt: '2026-10-31T10:00:06Z' }));
    if (source === 'snapshot') {
      vi.mocked(api.getQueueStatus).mockResolvedValue({
        sessions: [{ sessionId: 's1', entries }],
      } as never);
    }
    renderTimeline([message()]);
    await screen.findByText('Let’s play checkers');
    await waitFor(() => expect(api.getQueueStatus).toHaveBeenCalled());
    stream.push({ type: 'delta', content: 'Thinking about the board' });
    if (source === 'stream') {
      for (const entry of entries) stream.push({ type: 'queue_enqueued', ...entry });
    }
    await screen.findByText('Can you explain that move?');
    expect(screen.queryByText('Queued board instructions')).toBeNull();
    expect(screen.queryByText('Queued retry instructions')).toBeNull();
    debugMode(true);
    expect(await screen.findByText('Queued board instructions')).toBeInTheDocument();
    expect(screen.getByText('Queued retry instructions')).toBeInTheDocument();
    debugMode(false);
    expect(screen.queryByText('Queued board instructions')).toBeNull();
    expect(screen.queryByText('Queued retry instructions')).toBeNull();
  });
});
