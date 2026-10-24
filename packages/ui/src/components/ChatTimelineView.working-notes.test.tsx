import type { ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* () {},
  streamSharedAllChatEvents: async function* () {},
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function message(overrides: Partial<TimelineMessage>): TimelineMessage {
  return {
    sessionId: 'meester-thread',
    gezelId: 'florian',
    projectId: 'default',
    sessionTitle: 'Trip',
    sessionCreatedAt: '2026-10-11T10:00:00.000Z',
    sessionLastActivityAt: '2026-10-11T10:10:00.000Z',
    sessionProviderName: 'mock',
    role: 'user',
    content: 'Plan a family trip to Portugal',
    at: '2026-10-11T10:00:00.000Z',
    ...overrides,
  } as TimelineMessage;
}

/** The meester's ask, the worker's nested session, and the wrap-up. */
const MESSAGES: TimelineMessage[] = [
  message({}),
  message({ role: 'assistant', content: 'Mira is on it.', at: '2026-10-11T10:00:30.000Z' }),
  message({
    sessionId: 'worker',
    gezelId: 'mira',
    role: 'user',
    origin: 'system',
    content: "You've been assigned task default/1",
    at: '2026-10-11T10:01:00.000Z',
    taskRef: 'default/1',
    parentSession: { sessionId: 'meester-thread', gezelId: 'florian', kind: 'task-entry' },
  }),
  message({
    sessionId: 'worker',
    gezelId: 'mira',
    role: 'assistant',
    content: 'Drafted ten days: Lisbon first, then the Algarve.',
    at: '2026-10-11T10:05:00.000Z',
    taskRef: 'default/1',
    parentSession: { sessionId: 'meester-thread', gezelId: 'florian', kind: 'task-entry' },
  }),
  message({
    role: 'assistant',
    synthetic: 'task-wrapup',
    content: 'Mira finished your trip plan.',
    at: '2026-10-11T10:10:00.000Z',
  }),
];

function renderTimeline(foldWorkingNotes: boolean) {
  render(
    <ChatTimelineView
      scopeKey="global"
      activeSessionId={undefined}
      loadTimeline={async () => ({ messages: MESSAGES, hasMore: false }) as ListTimelineResponse}
      streamUrl={() => 'https://example.invalid/events'}
      foldWorkingNotes={foldWorkingNotes}
    />,
  );
}

describe('ChatTimelineView — Working notes', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock' } as never);
    vi.mocked(api.listQuestions).mockResolvedValue({ questions: [] });
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'florian', name: 'Florian', role: 'Meester' },
        { id: 'mira', name: 'Mira', role: 'Reisleider' },
      ],
    } as never);
  });

  // The person's first conversation used to fill with the worker's
  // thinking and tool errors, with the finished work above all of it.
  it('folds the worker under one line and puts the wrap-up last', async () => {
    renderTimeline(true);
    const fold = await screen.findByTestId('working-notes');
    await waitFor(() => expect(fold).toHaveTextContent("Mira's working notes"));
    expect(fold).not.toHaveAttribute('open');
    // The worker's words are inside the fold, not loose in the thread.
    expect(fold).toHaveTextContent('Drafted ten days');
    const wrapUp = screen.getByText('Mira finished your trip plan.');
    expect(fold.compareDocumentPosition(wrapUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('unfolds the crew when debug mode turns on, without reopening the view', async () => {
    renderTimeline(true);
    await screen.findByTestId('working-notes');
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('gezel:config-updated', { detail: { provider: 'mock', debugMode: true } }),
      );
    });
    await waitFor(() => expect(screen.queryByTestId('working-notes')).not.toBeInTheDocument());
    expect(
      screen.getByText('Drafted ten days: Lisbon first, then the Algarve.'),
    ).toBeInTheDocument();
  });

  // A project chat used to show the crew's whole transcript: a bakery
  // owner's invoice request filled with five workers' hand-offs and steps.
  it('folds by default, in every conversation', async () => {
    render(
      <ChatTimelineView
        scopeKey="project:default"
        activeSessionId={undefined}
        loadTimeline={async () => ({ messages: MESSAGES, hasMore: false }) as ListTimelineResponse}
        streamUrl={() => 'https://example.invalid/events'}
      />,
    );
    const fold = await screen.findByTestId('working-notes');
    expect(fold).not.toHaveAttribute('open');
    expect(fold).toHaveTextContent('Drafted ten days');
  });

  it('shows the full tree when debug mode is already on', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock', debugMode: true } as never);
    renderTimeline(true);
    await screen.findByText('Drafted ten days: Lisbon first, then the Algarve.');
    await waitFor(() => expect(screen.queryByTestId('working-notes')).not.toBeInTheDocument());
  });

  // Folding everywhere must not park a question where nobody reads it.
  it('opens on a folded worker that is waiting for the person', async () => {
    vi.mocked(api.listQuestions).mockResolvedValue({
      questions: [
        {
          id: 'q-dates',
          projectId: 'default',
          gezelId: 'mira',
          sessionId: 'worker',
          prompt: 'Which week in May works for you?',
          createdAt: '2026-10-11T10:04:00.000Z',
        },
      ],
    } as never);
    renderTimeline(true);
    const fold = await screen.findByTestId('working-notes');
    await waitFor(() => expect(fold).toHaveTextContent('Mira has a question for you'));
    expect(fold).toHaveAttribute('open');
    expect(fold).toHaveAttribute('data-working-notes-state', 'needs-you');
  });

  it('stays closed for a question the person already answered', async () => {
    vi.mocked(api.listQuestions).mockResolvedValue({
      questions: [
        {
          id: 'q-dates',
          projectId: 'default',
          gezelId: 'mira',
          sessionId: 'worker',
          prompt: 'Which week in May works for you?',
          createdAt: '2026-10-11T10:04:00.000Z',
          answer: { text: 'The second week', answeredAt: '2026-10-11T10:04:30.000Z' },
        },
      ],
    } as never);
    renderTimeline(true);
    const fold = await screen.findByTestId('working-notes');
    await waitFor(() => expect(fold).toHaveTextContent("Mira's working notes"));
    expect(fold).not.toHaveAttribute('open');
  });

  it('keeps the full tree elsewhere', async () => {
    renderTimeline(false);
    await screen.findByText('Drafted ten days: Lisbon first, then the Algarve.');
    expect(screen.queryByTestId('working-notes')).not.toBeInTheDocument();
  });
});

describe('ChatTimelineView — content held for a finished task', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] } as never);
  });

  // The folder invitation follows the first thing the crew made.
  it('shows the trailing invitation only once a task has wrapped up', async () => {
    const withoutWrapUp = MESSAGES.filter((m) => m.synthetic !== 'task-wrapup');
    const { unmount } = render(
      <ChatTimelineView
        scopeKey="global"
        activeSessionId={undefined}
        loadTimeline={async () =>
          ({ messages: withoutWrapUp, hasMore: false }) as ListTimelineResponse
        }
        streamUrl={() => 'https://example.invalid/events'}
        trailingContent={<p>Want me to look after a folder?</p>}
        trailingContentAfterWrapUp
      />,
    );
    await screen.findByText('Plan a family trip to Portugal');
    expect(screen.queryByText('Want me to look after a folder?')).not.toBeInTheDocument();
    unmount();

    render(
      <ChatTimelineView
        scopeKey="global"
        activeSessionId={undefined}
        loadTimeline={async () => ({ messages: MESSAGES, hasMore: false }) as ListTimelineResponse}
        streamUrl={() => 'https://example.invalid/events'}
        trailingContent={<p>Want me to look after a folder?</p>}
        trailingContentAfterWrapUp
      />,
    );
    expect(await screen.findByText('Want me to look after a folder?')).toBeInTheDocument();
  });
});
