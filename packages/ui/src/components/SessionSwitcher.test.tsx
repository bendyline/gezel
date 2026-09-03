import type { ChatEventEnvelope } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('requests composer focus after creating and selecting a fresh thread', async () => {
    mockSessions([]);
    vi.mocked(api.createChatSession).mockResolvedValue({ id: 's-new' } as never);
    const onSessionIdChange = vi.fn();
    const onNewSessionCreated = vi.fn();

    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={onSessionIdChange}
        onNewSessionCreated={onNewSessionCreated}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '+ New' }));

    await waitFor(() => {
      expect(onSessionIdChange).toHaveBeenCalledWith('s-new');
      expect(onNewSessionCreated).toHaveBeenCalledWith('s-new');
    });
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
  });

  function mockDrafts(byScope: { fresh?: unknown[]; onThread?: unknown[] }) {
    vi.mocked(api.listPromptDrafts).mockImplementation(async (_projectId, filter) => {
      if (filter?.sessionId === null) return { drafts: byScope.fresh ?? [] } as never;
      return { drafts: byScope.onThread ?? [] } as never;
    });
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
    mockSessions([]);
    mockDrafts({ fresh: [draft()] });
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
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
