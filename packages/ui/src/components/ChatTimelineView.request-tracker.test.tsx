import type {
  ListTimelineResponse,
  RequestTrack,
  TimelineMessage,
  ToolCallCard,
} from '@bendyline/gezel';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* () {},
  streamSharedAllChatEvents: async function* () {},
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

const ASKED_AT = '2026-10-23T09:00:00.000Z';

function card(reused: boolean): ToolCallCard {
  return {
    kind: 'craftbook-start',
    craftbookId: 'invoice-run',
    craftbookName: 'Invoice run',
    taskRef: 'bakery/1',
    projectId: 'bakery',
    status: 'active',
    activeStepId: 'draft',
    steps: [{ id: 'draft', name: 'Draft the invoices', status: 'active' }],
    ...(reused ? { reused: true } : {}),
  };
}
const invoke = (reused: boolean) => ({
  name: 'invoke_craftbook',
  durationMs: 300,
  success: true,
  card: card(reused),
});

const BASE = {
  sessionId: 'mees-thread',
  gezelId: 'mees',
  projectId: 'default',
  sessionTitle: 'Invoices',
  sessionCreatedAt: ASKED_AT,
  sessionLastActivityAt: '2026-10-23T09:30:00.000Z',
  sessionProviderName: 'mock',
};

// The bakery's first request as its thread recorded it.
const MESSAGES = [
  { ...BASE, id: 'm1', role: 'user', content: 'Make my October invoices', at: ASKED_AT },
  {
    ...BASE,
    role: 'assistant',
    content: 'Dejan is on it.',
    at: '2026-10-23T09:02:00.000Z',
    toolCalls: [invoke(false), invoke(true), invoke(true)],
  },
  {
    ...BASE,
    role: 'assistant',
    content: 'Aditya joined the crew.',
    at: '2026-10-23T09:05:00.000Z',
    synthetic: 'crew-introduction',
    crewIntroduction: {
      taskRef: 'bakery/1',
      moment: 'joined',
      members: [{ gezelId: 'aditya', name: 'Aditya', role: 'Bookkeeper' }],
    },
  },
  {
    ...BASE,
    role: 'assistant',
    content: 'Your PDF for **October invoices** is ready.',
    at: '2026-10-23T09:28:00.000Z',
    synthetic: 'task-wrapup',
    referencedTasks: ['bakery/1'],
    deliverable: { kind: 'artifact', path: 'tasks/1/invoices.pdf', projectId: 'bakery' },
    makerGezelId: 'aditya',
  },
] as TimelineMessage[];

const TRACK: RequestTrack = {
  key: `mees-thread@${ASKED_AT}`,
  sessionId: 'mees-thread',
  projectId: 'default',
  at: ASKED_AT,
  messageId: 'm1',
  summary: 'Make my October invoices',
  kind: 'work',
  leadGezelId: 'dejan',
  stop: 'ready',
  state: 'ready',
  actual: { taskRef: 'bakery/1', gezelId: 'aditya', stepId: 'finish', stepName: 'Finish' },
  taskRefs: ['bakery/1'],
  liveSessionIds: [],
  crew: ['aditya'],
  deliverable: { kind: 'artifact', path: 'tasks/1/invoices.pdf', projectId: 'bakery' },
  makerGezelId: 'aditya',
  questionIds: [],
};

function renderTimeline() {
  return render(
    <ChatTimelineView
      scopeKey="gezel:mees"
      activeSessionId={undefined}
      loadTimeline={async () => ({ messages: MESSAGES, hasMore: false }) as ListTimelineResponse}
      streamUrl={() => 'https://example.invalid/events'}
    />,
  );
}

describe('ChatTimelineView — one request, one tracker', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'mees', name: 'Mees', role: 'Meester' },
        { id: 'dejan', name: 'Dejan', role: 'Kantoormeester' },
        { id: 'aditya', name: 'Aditya', role: 'Bookkeeper' },
      ],
    } as never);
    vi.mocked(api.listRequests).mockResolvedValue({ requests: [TRACK], at: ASKED_AT } as never);
  });

  it('shows the tracker and keeps the work it speaks for out of the thread', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock' } as never);
    const { container } = renderTimeline();
    const tracker = await screen.findByTestId('request-tracker');
    expect(screen.getAllByTestId('request-tracker')).toHaveLength(1);
    expect(within(tracker).getByText('Ready')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('.msg-tool-card')).toHaveLength(0));
    expect(screen.queryByTestId('crew-intro')).not.toBeInTheDocument();
    // The finished card lives in the tracker, credited to the lead.
    expect(container.querySelectorAll('.deliverable-card')).toHaveLength(1);
    expect(tracker.querySelector('.deliverable-card')).not.toBeNull();
    expect(within(tracker).getByText("Who's helping?")).toBeInTheDocument();
    // The wrap-up's words stay; only its card moved.
    expect(container.textContent).toContain('Your PDF for');
    // The thread's order: the ask, the replies, then its tracker.
    const ask = screen.getByText('Make my October invoices');
    expect(ask.compareDocumentPosition(tracker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows everything in debug mode, the tracker with who really did it', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock', debugMode: true } as never);
    const { container } = renderTimeline();
    const tracker = await screen.findByTestId('request-tracker');
    await waitFor(() => expect(container.querySelectorAll('.msg-tool-card')).toHaveLength(3));
    expect(screen.getByTestId('crew-intro')).toBeInTheDocument();
    expect(container.querySelectorAll('.deliverable-card')).toHaveLength(2);
    expect(within(tracker).getByText('Aditya · Finish · bakery/1')).toBeInTheDocument();
  });
});
