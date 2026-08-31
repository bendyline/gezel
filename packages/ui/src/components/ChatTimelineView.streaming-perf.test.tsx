import type { ChatEventEnvelope, ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const renderCounts = vi.hoisted(() => ({ persisted: 0, streaming: 0 }));
const stream = vi.hoisted(() => {
  const pending: ChatEventEnvelope[] = [];
  let consumed = 0;
  let wake: (() => void) | null = null;
  return {
    push(envelope: ChatEventEnvelope) {
      pending.push(envelope);
      wake?.();
      wake = null;
    },
    reset() {
      pending.length = 0;
      consumed = 0;
      wake = null;
    },
    consumed: () => consumed,
    async *consume(): AsyncGenerator<ChatEventEnvelope> {
      while (true) {
        while (pending.length > 0) {
          consumed += 1;
          yield pending.shift() as ChatEventEnvelope;
        }
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
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));
vi.mock('./chat-bubbles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-bubbles.js')>();
  const React = await import('react');
  return {
    ...actual,
    MessageBubble(props: React.ComponentProps<typeof actual.MessageBubble>) {
      renderCounts.persisted += 1;
      return React.createElement(actual.MessageBubble, props);
    },
    StreamingBubble({
      segments,
    }: {
      segments: Array<{ kind: string; content?: string }>;
    }) {
      renderCounts.streaming += 1;
      return (
        <div data-testid="streaming-bubble">
          {segments.map((segment) => (segment.kind === 'text' ? segment.content : '')).join('')}
        </div>
      );
    },
  };
});

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

const messages: TimelineMessage[] = [
  {
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: 'Streaming performance',
    sessionCreatedAt: '2026-08-26T10:00:00.000Z',
    sessionLastActivityAt: '2026-08-26T10:00:01.000Z',
    sessionProviderName: 'llama-cpp',
    role: 'user',
    content: 'Give me the long answer.',
    at: '2026-08-26T10:00:00.000Z',
  },
  {
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: 'Streaming performance',
    sessionCreatedAt: '2026-08-26T10:00:00.000Z',
    sessionLastActivityAt: '2026-08-26T10:00:01.000Z',
    sessionProviderName: 'llama-cpp',
    role: 'assistant',
    content: 'Persisted rich answer.',
    at: '2026-08-26T10:00:01.000Z',
  },
];

describe('ChatTimelineView — streaming invalidation boundary', () => {
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  async function flushFrames(): Promise<void> {
    await act(async () => {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      for (const callback of callbacks) callback(performance.now());
    });
  }

  beforeEach(() => {
    stream.reset();
    renderCounts.persisted = 0;
    renderCounts.streaming = 0;
    frameCallbacks = new Map();
    nextFrame = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const handle = nextFrame++;
        frameCallbacks.set(handle, callback);
        return handle;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((handle: number) => frameCallbacks.delete(handle)),
    );
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

  it('coalesces token bursts without rerendering persisted bubbles or measuring sticky rows', async () => {
    const loadTimeline = vi.fn(async () => ({ messages, hasMore: false }) as ListTimelineResponse);
    render(
      <ChatTimelineView
        scopeKey="project:p1"
        activeSessionId="s1"
        loadTimeline={loadTimeline}
        streamUrl={() => 'https://example.invalid/events'}
        inflightScope={{ projectId: 'p1' }}
      />,
    );

    await screen.findByText('Persisted rich answer.');
    await waitFor(() => expect(loadTimeline.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(api.listQuestions).toHaveBeenCalled());
    await waitFor(() => expect(api.listGezels).toHaveBeenCalled());
    await act(async () => Promise.resolve());
    await flushFrames();
    await flushFrames();

    stream.push({
      sessionId: 's1',
      gezelId: 'g1',
      projectId: 'p1',
      event: { type: 'delta', content: 'start:' },
    } as ChatEventEnvelope);
    await waitFor(() => expect(stream.consumed()).toBe(1));
    await flushFrames();
    expect(await screen.findByTestId('streaming-bubble')).toHaveTextContent('start:');
    await flushFrames();

    renderCounts.persisted = 0;
    renderCounts.streaming = 0;
    const queryAll = vi.spyOn(Element.prototype, 'querySelectorAll');
    for (let i = 0; i < 100; i += 1) {
      stream.push({
        sessionId: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        event: { type: 'delta', content: String(i % 10) },
      } as ChatEventEnvelope);
    }
    await waitFor(() => expect(stream.consumed()).toBe(101));

    // Every fragment is already in the mutable buffer, but React has one
    // scheduled live-session notification for the whole burst.
    expect(renderCounts.persisted).toBe(0);
    expect(renderCounts.streaming).toBe(0);
    await flushFrames();

    expect(screen.getByTestId('streaming-bubble')).toHaveTextContent(
      `start:${Array.from({ length: 100 }, (_, i) => String(i % 10)).join('')}`,
    );
    expect(renderCounts.streaming).toBe(1);
    expect(renderCounts.persisted).toBe(0);

    // The follow-to-bottom frame may read scrollHeight, but it must not run
    // the sticky header's all-message DOM scan on token arrival.
    await flushFrames();
    expect(queryAll.mock.calls.filter(([selector]) => selector === '[data-msg-id]')).toHaveLength(
      0,
    );
  });
});
