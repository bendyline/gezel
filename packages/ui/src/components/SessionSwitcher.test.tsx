import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import * as primitivesMock from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { SessionSwitcher } = await import('./SessionSwitcher.js');
const { api } = await import('../api.js');

function mockSessions(sessions: unknown[]) {
  vi.mocked(api.listChatSessions).mockResolvedValue({ sessions } as never);
}

describe('SessionSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
