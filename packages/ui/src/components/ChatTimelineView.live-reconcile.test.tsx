import type { ChatEventEnvelope, ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
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
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function message(overrides: Partial<TimelineMessage>): TimelineMessage {
  return {
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: 'Space war game',
    sessionCreatedAt: '2026-08-05T10:00:00.000Z',
    sessionLastActivityAt: '2026-08-05T10:00:00.000Z',
    sessionProviderName: 'llama-cpp',
    role: 'user',
    content: 'Build a space war game',
    at: '2026-08-05T10:00:00.000Z',
    ...overrides,
  } as TimelineMessage;
}

const userMessage = message({});
const assistantMessage = message({
  role: 'assistant',
  content: 'The playable space war game is ready.',
  at: '2026-08-05T10:12:00.000Z',
});
const streamUrl = () => 'https://example.invalid/events/chat/project?project=p1';

function renderTimeline(
  loadTimeline: (opts: { limit: number }) => Promise<ListTimelineResponse>,
  onArtifactSeen?: (path: string, projectId?: string) => void,
) {
  render(
    <ChatTimelineView
      scopeKey="project:p1"
      activeSessionId={undefined}
      loadTimeline={loadTimeline}
      streamUrl={streamUrl}
      inflightScope={{ projectId: 'p1' }}
      onArtifactSeen={onArtifactSeen}
    />,
  );
}

describe('ChatTimelineView — canonical completion reconciliation', () => {
  beforeEach(() => {
    stream.reset();
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
  });

  it('closes the initial snapshot-to-subscription race with a trailing canonical read', async () => {
    let call = 0;
    const loadTimeline = vi.fn(async (): Promise<ListTimelineResponse> => {
      call += 1;
      return {
        messages: call === 1 ? [userMessage] : [userMessage, assistantMessage],
        hasMore: false,
      } as ListTimelineResponse;
    });

    renderTimeline(loadTimeline);

    await screen.findByText('The playable space war game is ready.');
    expect(loadTimeline).toHaveBeenCalledTimes(2);
  });

  it('registers a persisted file once across canonical timeline reconciliations', async () => {
    const onArtifactSeen = vi.fn();
    const referencedReply = message({
      role: 'assistant',
      content: 'The report is ready.',
      at: '2026-08-05T10:11:00.000Z',
      referencedFiles: [{ kind: 'artifact', path: 'reports/status.md' }],
    });
    const loadTimeline = vi.fn(
      async (): Promise<ListTimelineResponse> =>
        ({ messages: [userMessage, referencedReply], hasMore: false }) as ListTimelineResponse,
    );

    renderTimeline(loadTimeline, onArtifactSeen);

    await waitFor(() => expect(loadTimeline).toHaveBeenCalledTimes(2));
    expect(onArtifactSeen).toHaveBeenCalledTimes(1);
    expect(onArtifactSeen).toHaveBeenCalledWith('reports/status.md', 'p1');
  });

  it('refreshes the durable row on done when the complete envelope was missed', async () => {
    let durable = false;
    const loadTimeline = vi.fn(
      async (): Promise<ListTimelineResponse> =>
        ({
          messages: durable ? [userMessage, assistantMessage] : [userMessage],
          hasMore: false,
        }) as ListTimelineResponse,
    );
    renderTimeline(loadTimeline);
    await screen.findByText('Build a space war game');
    await waitFor(() => expect(loadTimeline).toHaveBeenCalledTimes(2));

    durable = true;
    stream.push({
      sessionId: 's1',
      gezelId: 'g1',
      projectId: 'p1',
      event: { type: 'done' },
    } as ChatEventEnvelope);

    await screen.findByText('The playable space war game is ready.');
    expect(loadTimeline).toHaveBeenCalledTimes(3);
  });
});
