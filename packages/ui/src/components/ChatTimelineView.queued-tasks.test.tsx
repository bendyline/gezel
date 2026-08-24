import type {
  ChatEventEnvelope,
  ListTimelineResponse,
  Task,
  TaskWaitState,
  TimelineMessage,
} from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import type { QueuedTaskEntry } from './queued-task-entries.js';

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
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function entry(num: number, overrides: Partial<TaskWaitState> = {}): QueuedTaskEntry {
  const ref = `p1/${num}`;
  return {
    task: {
      num,
      ref,
      projectId: 'p1',
      title: `Task number ${num}`,
      status: 'active',
    } as unknown as Task,
    wait: {
      ref,
      reason: 'provider-busy',
      gezelId: 'g1',
      since: '2026-08-21T05:30:00.000Z',
      ...overrides,
    },
  };
}

const seedMessage = {
  sessionId: 's1',
  gezelId: 'g1',
  projectId: 'p1',
  sessionTitle: 'Pull request review',
  sessionCreatedAt: '2026-08-21T05:00:00.000Z',
  sessionLastActivityAt: '2026-08-21T05:00:00.000Z',
  sessionProviderName: 'llama-cpp',
  role: 'user',
  origin: 'system',
  taskRef: 'p1/6',
  content: 'Start the review.',
  at: '2026-08-21T05:00:00.000Z',
} as TimelineMessage;

function renderTimeline(opts: {
  messages?: TimelineMessage[];
  queuedTasks: QueuedTaskEntry[];
}) {
  render(
    <ChatTimelineView
      scopeKey="project:p1"
      activeSessionId={undefined}
      loadTimeline={async () =>
        ({ messages: opts.messages ?? [], hasMore: false }) as ListTimelineResponse
      }
      streamUrl={() => 'https://example.invalid/events'}
      inflightScope={{ projectId: 'p1' }}
      queuedTasks={opts.queuedTasks}
    />,
  );
}

describe('ChatTimelineView — queued task receipts', () => {
  beforeEach(() => {
    stream.reset();
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'g1', name: 'Koray', role: 'Reviewer' }],
    } as never);
  });

  it('shows a receipt in an otherwise empty conversation', async () => {
    // The case that motivated this: the task strip says "No chat yet"
    // and the transcript is blank, so starting the task looks like it
    // did nothing at all.
    renderTimeline({ queuedTasks: [entry(6)] });
    expect(await screen.findByText('Task number 6')).toBeInTheDocument();
    expect(screen.getByText('In the queue')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a free slot/i)).toBeInTheDocument();
  });

  it('keeps the receipt while the task has only settled history', async () => {
    renderTimeline({ messages: [seedMessage], queuedTasks: [entry(6)] });
    expect(await screen.findByText('Task number 6')).toBeInTheDocument();
  });

  it('drops the receipt once that task is streaming its turn', async () => {
    renderTimeline({ messages: [seedMessage], queuedTasks: [entry(6)] });
    await screen.findByText('Task number 6');

    stream.push({
      sessionId: 's1',
      gezelId: 'g1',
      projectId: 'p1',
      event: { type: 'delta', content: 'Reading the diff' },
    } as ChatEventEnvelope);

    await waitFor(() => {
      expect(screen.queryByText('Task number 6')).toBeNull();
    });
  });

  it('drops the receipt when the dispatch session speaks from a fresh session', async () => {
    // The regression: a handoff opens a session the timeline has never
    // seen, so neither the live slot nor the synthesized user row can
    // resolve a `taskRef` — and the "picking it up now" card sat beside
    // a visibly streaming bubble for the whole turn. The dispatch's own
    // session id is the correlation that survives.
    renderTimeline({
      queuedTasks: [entry(9, { reason: 'dispatching', sessionId: 's9' })],
    });
    await screen.findByText('Task number 9');

    stream.push({
      sessionId: 's9',
      gezelId: 'g1',
      projectId: 'p1',
      event: {
        type: 'user_message',
        message: {
          role: 'user',
          content: 'Continue with the harvest step.',
          at: '2026-08-21T05:31:00.000Z',
          origin: 'system',
        },
      },
    } as ChatEventEnvelope);

    await waitFor(() => {
      expect(screen.queryByText('Task number 9')).toBeNull();
    });
  });

  it('counts the remainder rather than drawing a card per batch shard', async () => {
    renderTimeline({ queuedTasks: [6, 7, 8, 9, 10, 11].map((n) => entry(n)) });
    expect(await screen.findByText('Task number 6')).toBeInTheDocument();
    expect(screen.queryByText('Task number 10')).toBeNull();
    expect(screen.getByText(/\+ 2 more tasks waiting in the queue\./)).toBeInTheDocument();
  });
});
