import type { ChatEventEnvelope } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import * as primitivesMock from '../test-utils/primitivesMock.js';

const stream = vi.hoisted(() => {
  interface Consumer {
    pending: ChatEventEnvelope[];
    wake: (() => void) | null;
  }
  const consumers = new Set<Consumer>();
  return {
    push(envelope: ChatEventEnvelope) {
      for (const consumer of consumers) {
        consumer.pending.push(envelope);
        consumer.wake?.();
        consumer.wake = null;
      }
    },
    reset() {
      consumers.clear();
    },
    async *consume(): AsyncGenerator<ChatEventEnvelope> {
      const consumer: Consumer = { pending: [], wake: null };
      consumers.add(consumer);
      try {
        while (true) {
          while (consumer.pending.length > 0) {
            yield consumer.pending.shift() as ChatEventEnvelope;
          }
          await new Promise<void>((resolve) => {
            consumer.wake = resolve;
          });
        }
      } finally {
        consumers.delete(consumer);
      }
    },
  };
});

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: () => stream.consume(),
}));

const { SessionSwitcher } = await import('./SessionSwitcher.js');
const { resetComposerDrafts, writeDraftText } = await import('./composer-drafts.js');
const { api } = await import('../api.js');

function mockSessions(sessions: unknown[]) {
  vi.mocked(api.listChatSessions).mockResolvedValue({ sessions } as never);
}

describe('SessionSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stream.reset();
  });

  it('scopes the empty state to the gezel when a name is provided', async () => {
    mockSessions([]);
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        gezelName="Metehan"
        onSessionIdChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText('No threads with Metehan yet — a message starts one'),
      ).toBeInTheDocument();
    });
  });

  it('falls back to the generic empty label without a name', async () => {
    mockSessions([]);
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('No threads yet')).toBeInTheDocument();
    });
  });

  it('auto-picks the most recent thread when the scope has sessions', async () => {
    mockSessions([
      {
        id: 's-new',
        gezelId: 'g1',
        title: 'Landing page plan',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
      {
        id: 's-old',
        gezelId: 'g1',
        title: 'Older thread',
        lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    const onSessionIdChange = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        gezelName="Ada Lovelace"
        onSessionIdChange={onSessionIdChange}
      />,
    );
    await waitFor(() => {
      expect(onSessionIdChange).toHaveBeenCalledWith('s-new');
    });
    expect(screen.getByText(/Landing page plan/)).toBeInTheDocument();
  });

  it('holds the composer on a fresh thread when auto-pick is off', async () => {
    mockSessions([
      {
        id: 's-old',
        gezelId: 'g1',
        title: 'Landing page plan',
        lastActivityAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    const onSessionIdChange = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        gezelName="Ada Lovelace"
        autoPickNewest={false}
        onSessionIdChange={onSessionIdChange}
      />,
    );
    // The thread is still listed — only the automatic pick is withheld.
    await waitFor(() => {
      expect(screen.getByText(/Landing page plan/)).toBeInTheDocument();
    });
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('names the destination when nothing is picked but threads exist', async () => {
    mockSessions([
      {
        id: 's-old',
        gezelId: 'g1',
        title: 'Landing page plan',
        lastActivityAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        gezelName="Ada Lovelace"
        autoPickNewest={false}
        onSessionIdChange={vi.fn()}
      />,
    );
    // A blank trigger reads as a control the user forgot to set. The picker
    // has to say where the next message goes.
    await waitFor(() => {
      expect(screen.getAllByText('New thread').length).toBeGreaterThan(0);
    });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  });

  it('offers a new-thread row alongside existing threads', async () => {
    mockSessions([
      {
        id: 's-old',
        gezelId: 'g1',
        title: 'Landing page plan',
        lastActivityAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    const onSessionIdChange = vi.fn();
    const onDraftSelect = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-old"
        onSessionIdChange={onSessionIdChange}
        onDraftSelect={onDraftSelect}
      />,
    );
    await screen.findByRole('option', { name: /Landing page plan/ });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__NEW__' } });

    // Leaving a thread for a fresh one clears both the thread and any draft
    // the composer had open.
    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(onDraftSelect).toHaveBeenCalledWith(undefined);
  });

  it('keeps task and night-shift sessions out of ordinary chat', async () => {
    mockSessions([
      {
        id: 'night-shift',
        gezelId: 'g1',
        title: 'Night-shift oversight',
        taskRef: 'p1/7',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
      {
        id: 'ordinary',
        gezelId: 'g1',
        title: 'Morning chat',
        lastActivityAt: new Date(Date.now() - 1_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    const onSessionIdChange = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={onSessionIdChange}
      />,
    );

    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('ordinary'));
    expect(screen.queryByText(/Night-shift oversight/)).not.toBeInTheDocument();
  });

  it('labels and reports a read-only thread mirrored from Pi', async () => {
    mockSessions([
      {
        id: 'external-pi-1',
        gezelId: 'g1',
        projectId: 'p1',
        title: 'Build a racing game',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        providerName: 'mlx',
        archived: false,
        source: {
          kind: 'external',
          appId: 'pi',
          appName: 'Pi',
          externalConversationId: 'pi-session-1',
          readOnly: true,
        },
      },
    ]);
    const onActiveSessionChange = vi.fn();

    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="external-pi-1"
        onSessionIdChange={vi.fn()}
        onActiveSessionChange={onActiveSessionChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/From Pi · read-only/)).toBeInTheDocument();
      expect(onActiveSessionChange).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'external-pi-1',
          source: expect.objectContaining({ appId: 'pi' }),
        }),
      );
    });
  });

  it('adds an externally-created thread when its first live event arrives', async () => {
    const prior = {
      id: 'external-pi-1',
      gezelId: 'g1',
      projectId: 'p1',
      title: 'Build a racing game',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
      providerName: 'mlx',
      archived: false,
      source: {
        kind: 'external',
        appId: 'pi',
        appName: 'Pi',
        externalConversationId: 'pi-session-1',
        readOnly: true,
      },
    };
    mockSessions([prior]);

    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="external-pi-1"
        onSessionIdChange={vi.fn()}
      />,
    );
    await screen.findByText(/Build a racing game/);
    const callsAfterMount = vi.mocked(api.listChatSessions).mock.calls.length;

    const flight = {
      ...prior,
      id: 'external-opencode-1',
      title: 'Create a flight simulator',
      source: {
        kind: 'external',
        appId: 'opencode',
        appName: 'OpenCode',
        externalConversationId: 'opencode-session-1',
        readOnly: true,
      },
    };
    mockSessions([flight, prior]);
    stream.push({
      sessionId: flight.id,
      gezelId: 'g1',
      projectId: 'p1',
      sessionSource: flight.source,
      event: {
        type: 'user_message',
        message: {
          role: 'user',
          content: 'Can you create a basic 3d flight simulator for the web?',
          at: new Date().toISOString(),
        },
      },
    } as ChatEventEnvelope);

    expect(await screen.findByText(/Create a flight simulator/)).toBeInTheDocument();
    expect(screen.getByText(/From OpenCode · read-only/)).toBeInTheDocument();
    expect(vi.mocked(api.listChatSessions).mock.calls.length).toBeGreaterThan(callsAfterMount);
    // A live external thread joins the choices without hijacking the current
    // Pi selection; the parent can opt into it when the user clicks the row.
    expect(screen.getByRole('combobox')).toHaveValue('external-pi-1');
  });

  it('does not auto-pick from the previous scope while the new scope loads', async () => {
    // The regression: a scope change (here, gaining a taskRef) used to let
    // the auto-pick run against the OLD scope's list, because clearing
    // `sessions` and reading it happen in the same effect flush. It would
    // stomp the caller's just-focused task thread with the lobby thread.
    mockSessions([
      {
        id: 'lobby',
        gezelId: 'g1',
        title: 'Lobby chat',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    let resolveTaskSessions: (v: unknown) => void = () => {};
    vi.mocked(api.listTaskSessions).mockReturnValue(
      new Promise((resolve) => {
        resolveTaskSessions = resolve;
      }) as never,
    );

    const onSessionIdChange = vi.fn();
    const { rerender } = render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={onSessionIdChange}
      />,
    );
    await waitFor(() => expect(onSessionIdChange).toHaveBeenCalledWith('lobby'));
    onSessionIdChange.mockClear();

    // Focus a task thread: the parent sets both the session and the scope.
    rerender(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="task-thread"
        taskRef="p1/4"
        onSessionIdChange={onSessionIdChange}
      />,
    );

    // While the task list is still in flight, nothing may be picked.
    await new Promise((r) => setTimeout(r, 20));
    expect(onSessionIdChange).not.toHaveBeenCalled();

    resolveTaskSessions({
      sessions: [
        {
          id: 'task-thread',
          gezelId: 'g1',
          title: 'Task thread',
          taskRef: 'p1/4',
          lastActivityAt: new Date().toISOString(),
          providerName: 'mock',
          archived: false,
        },
      ],
    });

    await waitFor(() => expect(screen.getByText(/Task thread/)).toBeInTheDocument());
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('requests composer focus when the user picks a fresh thread', async () => {
    mockSessions([
      {
        id: 's-old',
        gezelId: 'g1',
        title: 'Landing page plan',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    const onSessionIdChange = vi.fn();
    const onFreshThread = vi.fn();

    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-old"
        onSessionIdChange={onSessionIdChange}
        onFreshThread={onFreshThread}
      />,
    );

    await screen.findByRole('option', { name: /Landing page plan/ });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__NEW__' } });

    // No session is minted for a thread nobody has written into yet — the
    // composer's own send does that — so the cursor is all this hands back.
    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(onFreshThread).toHaveBeenCalled();
    expect(api.createChatSession).not.toHaveBeenCalled();
  });

  it('meters the active thread against its own context window', async () => {
    mockSessions([
      {
        id: 's1',
        gezelId: 'g1',
        title: 'Deck for the offsite',
        lastActivityAt: new Date().toISOString(),
        providerName: 'llama-cpp',
        model: 'large-local',
        archived: false,
        contextWindow: 40_960,
        contextAutoCompactRatio: 0.7,
        contextEstimatedTokens: 10_240,
      },
    ]);
    render(
      <SessionSwitcher gezelId="g1" projectId="p1" sessionId="s1" onSessionIdChange={vi.fn()} />,
    );

    const meter = await screen.findByRole('button', { name: /Thread context/ });
    expect(meter).toHaveTextContent('25%');
    expect(meter).toHaveAccessibleName(
      'Thread context: This thread fills about 25% of its 40K-token context',
    );

    // A running turn republishes the window; the ring must follow it without
    // waiting for the debounced session-list refresh.
    stream.push({
      sessionId: 's1',
      gezelId: 'g1',
      projectId: 'p1',
      event: {
        type: 'context_window',
        numCtx: 40_960,
        model: 'large-local',
        autoCompactRatio: 0.7,
        estimatedTokens: 30_720,
      },
    } as never);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Thread context/ })).toHaveTextContent('75%');
    });
  });

  it('falls back to the transcript tally before any turn has been measured', async () => {
    mockSessions([
      {
        id: 's1',
        gezelId: 'g1',
        title: 'Legacy thread',
        lastActivityAt: new Date().toISOString(),
        providerName: 'llama-cpp',
        model: 'large-local',
        archived: false,
        contextWindow: 40_960,
        contextAutoCompactRatio: 0.7,
        // No `contextEstimatedTokens`: this thread last ran before the
        // daemon started recording the measurement.
        transcriptTokens: 4_096,
      },
    ]);
    render(
      <SessionSwitcher gezelId="g1" projectId="p1" sessionId="s1" onSessionIdChange={vi.fn()} />,
    );

    const meter = await screen.findByRole('button', { name: /Thread context/ });
    expect(meter).toHaveTextContent('10%');
    expect(meter).toHaveAccessibleName(/at least 10%/);
  });

  it('compacts the active thread on demand', async () => {
    mockSessions([
      {
        id: 's1',
        gezelId: 'g1',
        title: 'Long thread',
        lastActivityAt: new Date().toISOString(),
        providerName: 'llama-cpp',
        model: 'large-local',
        archived: false,
        contextWindow: 40_960,
        contextAutoCompactRatio: 0.7,
        contextEstimatedTokens: 30_000,
      },
    ]);
    render(
      <SessionSwitcher gezelId="g1" projectId="p1" sessionId="s1" onSessionIdChange={vi.fn()} />,
    );

    await screen.findByRole('button', { name: /Thread context/ });
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }));

    await waitFor(() => {
      expect(api.compactChatSession).toHaveBeenCalledWith('s1');
    });
  });

  it('surfaces the daemon reason when a manual compaction is refused', async () => {
    mockSessions([
      {
        id: 's1',
        gezelId: 'g1',
        title: 'Short thread',
        lastActivityAt: new Date().toISOString(),
        providerName: 'llama-cpp',
        archived: false,
        contextWindow: 40_960,
        transcriptTokens: 200,
      },
    ]);
    vi.mocked(api.compactChatSession).mockRejectedValue(
      new GezelApiError('Gezel API error 409 on POST /api/sessions/s1/compact', 409, {
        error: 'This thread is too short to compact; there is nothing older to summarize yet.',
        code: 'too-short',
      }),
    );
    render(
      <SessionSwitcher gezelId="g1" projectId="p1" sessionId="s1" onSessionIdChange={vi.fn()} />,
    );

    await screen.findByRole('button', { name: /Thread context/ });
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }));

    expect(await screen.findByText(/too short to compact/)).toBeInTheDocument();
  });

  it('shows no meter for a provider that reports no context window', async () => {
    mockSessions([
      {
        id: 's1',
        gezelId: 'g1',
        title: 'Cloud thread',
        lastActivityAt: new Date().toISOString(),
        providerName: 'copilot',
        archived: false,
      },
    ]);
    render(
      <SessionSwitcher gezelId="g1" projectId="p1" sessionId="s1" onSessionIdChange={vi.fn()} />,
    );

    await screen.findByText(/Cloud thread/);
    expect(screen.queryByRole('button', { name: /Thread context/ })).toBeNull();
  });
});

/**
 * Unsent thread starters. A draft with no thread is still somewhere the user
 * left off, so it has to be visible in the same place they look for threads.
 */
describe('SessionSwitcher prompt drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stream.reset();
    resetComposerDrafts();
  });

  // The picker reads every open draft for the gezel in one call and sorts
  // them by what they are addressed to, so the fixture hands back both kinds
  // together — thread starters carry `sessionId: null`.
  function mockDrafts(byScope: { fresh?: unknown[]; onThread?: unknown[] }) {
    vi.mocked(api.listPromptDrafts).mockResolvedValue({
      drafts: [...(byScope.fresh ?? []), ...(byScope.onThread ?? [])],
    } as never);
  }

  const draft = (over: Record<string, unknown> = {}) => ({
    id: '2026-09-03-0001',
    projectId: 'p1',
    gezelId: 'g1',
    sessionId: null,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
    status: 'draft',
    title: 'The PRD',
    hasFiles: false,
    fileCount: 0,
    ...over,
  });

  it('lists an unsent thread starter above the threads, marked as a draft', async () => {
    mockSessions([]);
    mockDrafts({ fresh: [draft()] });
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    const option = await screen.findByRole('option', { name: /The PRD/ });
    expect(option).toHaveValue('draft:2026-09-03-0001');
    // The row says what it is before the user commits to it.
    expect(option.textContent).toContain('draft');
  });

  it('clears the thread before handing the draft over, never both at once', async () => {
    const onSessionIdChange = vi.fn();
    const onDraftSelect = vi.fn();
    mockSessions([
      {
        id: 's-current',
        gezelId: 'g1',
        title: 'Current thread',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({ fresh: [draft()] });
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-current"
        onSessionIdChange={onSessionIdChange}
        onDraftSelect={onDraftSelect}
      />,
    );
    await screen.findByRole('option', { name: /The PRD/ });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'draft:2026-09-03-0001' },
    });

    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(onDraftSelect).toHaveBeenCalledWith('2026-09-03-0001');
    // Order matters: the composer must not see a draft arrive while it still
    // believes it is addressing a thread.
    expect(onSessionIdChange.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      onDraftSelect.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('names the draft the composer is writing before the list has it', async () => {
    mockSessions([]);
    // The list is deliberately not refetched while the user types, so the
    // draft they just started is not in it yet.
    mockDrafts({});
    writeDraftText('2026-09-03-0002', 'Rework the onboarding copy');
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        activeDraftId="2026-09-03-0002"
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    // Blank is what the trigger showed before: the picker held a value no row
    // carried, and Radix renders the matching row's text.
    const option = await screen.findByRole('option', { name: /Rework the onboarding copy/ });
    expect(option).toHaveValue('draft:2026-09-03-0002');

    // And it keeps up as the draft grows, off the same autosave that stores it.
    act(() => {
      writeDraftText('2026-09-03-0002', 'Rework the onboarding copy for new crews');
    });
    await screen.findByRole('option', { name: /for new crews/ });
  });

  it('follows the live text on a draft the list already knows', async () => {
    mockSessions([]);
    mockDrafts({ fresh: [draft()] });
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        activeDraftId="2026-09-03-0001"
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /The PRD/ });
    act(() => {
      writeDraftText('2026-09-03-0001', 'The PRD, second pass');
    });
    // The filed title is a snapshot; the editor is the live one.
    await screen.findByRole('option', { name: /The PRD, second pass/ });
  });

  it('lists a thread\u2019s own drafts under it, and keeps the thread when one is picked', async () => {
    mockSessions([
      {
        id: 's-1',
        gezelId: 'g1',
        title: 'Landing page plan',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({
      onThread: [draft({ id: '2026-09-03-0009', sessionId: 's-1', title: 'One more question' })],
    });
    const onSessionIdChange = vi.fn();
    const onDraftSelect = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-1"
        onSessionIdChange={onSessionIdChange}
        onDraftSelect={onDraftSelect}
      />,
    );
    const row = await screen.findByRole('option', { name: /One more question/ });
    // Tagged, so a message inside a thread never reads as a thread of its own.
    expect(row.textContent).toContain('draft');

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'draft:2026-09-03-0009' },
    });
    expect(onDraftSelect).toHaveBeenCalledWith('2026-09-03-0009');
    // The address is the thread; the draft is which message inside it.
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('names an unsent thread by its draft instead of a column of "New thread"', async () => {
    // The service only derives a thread title on the first SEND, so three
    // threads started from "+ New" all carry the same sentinel.
    mockSessions([
      {
        id: 's-1',
        gezelId: 'g1',
        title: 'New session',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
      {
        id: 's-2',
        gezelId: 'g1',
        title: 'New session',
        lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({
      onThread: [
        draft({ id: '2026-09-03-0011', sessionId: 's-1', title: 'Pricing for the new tier' }),
        draft({ id: '2026-09-03-0012', sessionId: 's-2', title: 'Onboarding copy rework' }),
      ],
    });
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-1"
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );

    // Each unsent thread wears its own draft's first line — including the one
    // that is not open, which is the whole point of telling them apart.
    const named = await screen.findByRole('option', { name: /Pricing for the new tier/ });
    expect(named).toHaveValue('s-1');
    expect(screen.getByRole('option', { name: /Onboarding copy rework/ })).toHaveValue('s-2');
    // The borrowed name replaces the sentinel rather than sitting beside it.
    // The only "New thread" left is the picker's own action row.
    expect(screen.getAllByRole('option', { name: 'New thread' })).toHaveLength(1);
  });

  it('floats the thread you are writing into to the top', async () => {
    // Writing a draft does not move a thread's lastActivityAt — nothing was
    // sent — so without this the thread you just typed into sits below older
    // ones under an identical name, which reads as "it is gone".
    mockSessions([
      {
        id: 's-recent',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
      {
        id: 's-older',
        gezelId: 'g1',
        title: 'New session',
        lastActivityAt: new Date(Date.now() - 29 * 60_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({
      onThread: [
        draft({
          id: '2026-09-03-0021',
          sessionId: 's-older',
          title: 'Ask about the invoice',
          updatedAt: new Date().toISOString(),
        }),
      ],
    });
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-older"
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    await screen.findByRole('option', { name: /Ask about the invoice/ });
    const threads = screen
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v.startsWith('s-'));
    expect(threads).toEqual(['s-older', 's-recent']);
  });

  it('files a thread nothing was sent to with the drafts, and claims no engine', async () => {
    // Whether a thread starter went through "+ New" (which mints a session up
    // front) or plain typing (which does not) is an implementation detail the
    // user never chose. Both leave them holding an unsent message, so both
    // belong on the same side of the line.
    mockSessions([
      {
        id: 's-unsent',
        gezelId: 'g1',
        title: 'New session',
        lastActivityAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        providerName: 'mlx',
        model: 'qwen3.8-27b-q4',
        archived: false,
      },
      {
        id: 's-sent',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
        providerName: 'mlx',
        model: 'qwen3.8-27b-q4',
        archived: false,
      },
    ]);
    mockDrafts({
      fresh: [draft({ id: '2026-09-03-0031', title: 'zxcz' })],
      onThread: [draft({ id: '2026-09-03-0032', sessionId: 's-unsent', title: 'Thread Charlie' })],
    });
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );

    const charlie = await screen.findByRole('option', { name: /Thread Charlie/ });
    // A session record carries a provider and model from creation, but this
    // thread has not run anything — saying which engine would be a guess
    // dressed as history.
    expect(charlie.textContent).not.toContain('qwen3.8-27b-q4');
    expect(screen.getByRole('option', { name: /Delivery failure planning/ }).textContent).toContain(
      'qwen3.8-27b-q4',
    );

    // Unsent things share one section, ordered together by when they were
    // last touched — the starter and the unsent thread sit side by side.
    const values = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values.indexOf('s-unsent')).toBeLessThan(values.indexOf('s-sent'));
    expect(values.indexOf('draft:2026-09-03-0031')).toBeLessThan(values.indexOf('s-sent'));
  });

  it('files "+ Draft" under the open thread, not as a new thread starter', async () => {
    mockSessions([
      {
        id: 's-1',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({});
    vi.mocked(api.createPromptDraft).mockResolvedValue(
      draft({
        id: '2026-09-03-0041',
        sessionId: 's-1',
        title: 'reply to delivery failure',
        content: 'reply to delivery failure',
      }) as never,
    );
    const onSessionIdChange = vi.fn();
    const onDraftSelect = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-1"
        onSessionIdChange={onSessionIdChange}
        onDraftSelect={onDraftSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Draft' }));

    // A second message in the conversation you are already in. Filing it as a
    // thread starter loses the address the user chose.
    await waitFor(() =>
      expect(api.createPromptDraft).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ sessionId: 's-1' }),
      ),
    );
    expect(onDraftSelect).toHaveBeenCalledWith('2026-09-03-0041');
    expect(onSessionIdChange).not.toHaveBeenCalled();
    // And it shows up where it belongs — under its thread.
    expect(await screen.findByRole('option', { name: /reply to delivery failure/ })).toHaveValue(
      'draft:2026-09-03-0041',
    );
  });

  it('offers "+ Draft" only on a thread, where it means something different', async () => {
    mockSessions([]);
    mockDrafts({});
    const { rerender } = render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    // Off a thread it would mean what the picker's fresh-thread row means.
    expect(screen.queryByRole('button', { name: '+ Draft' })).toBeNull();

    mockSessions([
      {
        id: 's-1',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    rerender(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-1"
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '+ Draft' })).toBeInTheDocument();
  });

  it('removes a draft from its own row, wherever that row sits', async () => {
    mockSessions([
      {
        id: 's-1',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({
      fresh: [draft({ id: '2026-09-03-0051', title: 'sdvs' })],
      onThread: [
        draft({ id: '2026-09-03-0052', sessionId: 's-1', title: 'reply to delivery failure' }),
      ],
    });
    vi.mocked(api.deletePromptDraft).mockResolvedValue({ ok: true, deleted: true } as never);
    const onDraftSelect = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-1"
        activeDraftId="2026-09-03-0052"
        onSessionIdChange={vi.fn()}
        onDraftSelect={onDraftSelect}
      />,
    );

    // A starter and a reply filed under a thread both carry the control.
    await screen.findByRole('button', { name: 'Delete draft sdvs' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft reply to delivery failure' }));

    await waitFor(() =>
      expect(api.deletePromptDraft).toHaveBeenCalledWith('p1', '2026-09-03-0052'),
    );
    // The composer was writing it, so it is handed back an empty sheet.
    expect(onDraftSelect).toHaveBeenCalledWith(undefined);
  });

  it('offers a recently sent message for reuse on the open thread', async () => {
    mockSessions([
      {
        id: 's-1',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    vi.mocked(api.listPromptDrafts).mockImplementation(async (_projectId, filter) => {
      if (filter?.status === 'sent') {
        return {
          drafts: [draft({ id: '2026-09-03-0061', sessionId: 's-1', title: 'the weekly ask' })],
        } as never;
      }
      return { drafts: [] } as never;
    });
    vi.mocked(api.duplicatePromptDraft).mockResolvedValue(
      draft({ id: '2026-09-03-0062', sessionId: 's-1', title: 'the weekly ask' }) as never,
    );
    const onDraftSelect = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-1"
        onSessionIdChange={vi.fn()}
        onDraftSelect={onDraftSelect}
      />,
    );

    // Sent drafts are read when the menu opens, not on every thread switch.
    await screen.findByRole('option', { name: /Delivery failure planning/ });
    fireEvent.focusIn(screen.getByRole('combobox'));
    const row = await screen.findByRole('option', { name: /the weekly ask/ });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: row.getAttribute('value') },
    });

    // Reuse copies rather than reopening: the sent one is history.
    await waitFor(() =>
      expect(api.duplicatePromptDraft).toHaveBeenCalledWith('p1', '2026-09-03-0061', {
        sessionId: 's-1',
      }),
    );
    expect(onDraftSelect).toHaveBeenCalledWith('2026-09-03-0062');
  });

  it('throws away an unsent thread with the message that named it', async () => {
    // The row wears its draft's name and reads exactly like the draft rows
    // around it, so it has to behave like them.
    mockSessions([
      {
        id: 's-unsent',
        gezelId: 'g1',
        title: 'New session',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({
      onThread: [draft({ id: '2026-09-03-0071', sessionId: 's-unsent', title: 'Thread Charlie' })],
    });
    vi.mocked(api.deletePromptDraft).mockResolvedValue({ ok: true, deleted: true } as never);
    vi.mocked(api.archiveChatSession).mockResolvedValue({ ok: true } as never);
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete draft Thread Charlie' }));

    await waitFor(() =>
      expect(api.deletePromptDraft).toHaveBeenCalledWith('p1', '2026-09-03-0071'),
    );
    // That was the thread's last unsent message and nothing was ever sent
    // there, so the nameless empty row goes with it rather than being left
    // behind for the user to puzzle over.
    expect(api.archiveChatSession).toHaveBeenCalledWith('s-unsent');
  });

  it('keeps a thread with history when one of its drafts is removed', async () => {
    mockSessions([
      {
        id: 's-sent',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({
      onThread: [draft({ id: '2026-09-03-0081', sessionId: 's-sent', title: 'reply in progress' })],
    });
    vi.mocked(api.deletePromptDraft).mockResolvedValue({ ok: true, deleted: true } as never);
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-sent"
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete draft reply in progress' }));

    await waitFor(() =>
      expect(api.deletePromptDraft).toHaveBeenCalledWith('p1', '2026-09-03-0081'),
    );
    // The conversation is not the message. Archiving it is a separate act.
    expect(api.archiveChatSession).not.toHaveBeenCalled();
  });

  it('archives from the row, moving the composer only off the thread it is in', async () => {
    mockSessions([
      {
        id: 's-open',
        gezelId: 'g1',
        title: 'Delivery failure planning',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
      {
        id: 's-other',
        gezelId: 'g1',
        title: 'Hi there',
        lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    mockDrafts({});
    vi.mocked(api.archiveChatSession).mockResolvedValue({ ok: true } as never);
    const onSessionIdChange = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId="s-open"
        onSessionIdChange={onSessionIdChange}
        onDraftSelect={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Archive thread Hi there' }));

    await waitFor(() => expect(api.archiveChatSession).toHaveBeenCalledWith('s-other'));
    // Putting away a thread you are not in must not move the composer.
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('leaves the drafts group out entirely when there are none', async () => {
    mockSessions([]);
    mockDrafts({});
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(api.listPromptDrafts).toHaveBeenCalled());
    expect(screen.queryByRole('option', { name: /draft/ })).not.toBeInTheDocument();
  });
});
