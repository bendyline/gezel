import type {
  ChatEventEnvelope,
  ChatSessionSummary,
  GezelSummary,
  ProjectDetail,
  Task,
} from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import * as primitivesMock from '../test-utils/primitivesMock.js';

/**
 * The task pill is the one path in this feature where several mechanisms
 * have to agree: the rail focus, the gezel switch, the `focusedSessionRef`
 * hand-off through the reset effect, and the task scope reaching
 * `SessionSwitcher` before its auto-pick runs. `SessionSwitcher` is left
 * REAL here on purpose — stubbing it would hide the exact stomp these
 * tests exist to catch.
 */

const stream = vi.hoisted(() => ({
  async *consume(): AsyncGenerator<ChatEventEnvelope> {
    await new Promise<void>(() => {});
  },
}));

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: () => stream.consume(),
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));
vi.mock('../views/tasks/NewTaskDialog.js', () => ({
  NewTaskDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-task-dialog" /> : null,
}));
vi.mock('./ProjectTimeline.js', () => ({ ProjectTimeline: () => <div data-testid="timeline" /> }));
vi.mock('./TerminalComposer.js', () => ({
  TerminalComposer: () => <div data-testid="terminal" />,
  queueTerminalCommand: vi.fn(),
}));
// Pass-through rail: hand both render props no-op callbacks and record the
// task refs they were asked to focus. `banner` carries the pill row, so a
// mock that only rendered `children` would drop every pill under test.
const railFocusCalls = vi.hoisted(() => [] as Array<{ ref: string; focus?: boolean }>);
vi.mock('./ChatReferences.js', () => ({
  ChatReferences: ({
    banner,
    children,
  }: {
    banner?: (api: Record<string, unknown>) => ReactNode;
    children: (api: Record<string, unknown>) => ReactNode;
  }) => {
    const api = {
      onToolActivity: vi.fn(),
      onArtifactReference: vi.fn(),
      onWorkspaceReference: vi.fn(),
      onTaskReference: (ref: string, opts?: { focus?: boolean }) => {
        railFocusCalls.push({ ref, ...(opts ?? {}) });
      },
    };
    return (
      <div>
        {banner?.(api)}
        {children(api)}
      </div>
    );
  },
}));
// Surface the scope props so a test can assert what the composer would send.
vi.mock('./ChatComposer.js', () => ({
  ChatComposer: ({
    gezelId,
    sessionId,
    taskRef,
    belowAddressLine,
  }: {
    gezelId: string;
    sessionId?: string;
    taskRef?: string;
    belowAddressLine?: ReactNode;
  }) => (
    <div
      data-testid="composer"
      data-gezel={gezelId}
      data-session={sessionId ?? ''}
      data-task={taskRef ?? ''}
    >
      {belowAddressLine}
    </div>
  ),
}));

const { ProjectChat } = await import('./ProjectChat.js');
const { api } = await import('../api.js');

const PROJECT = {
  id: 'p1',
  name: 'Helicopter game',
  voormanGezelId: 'g1',
  gezelIds: ['g1', 'g2'],
} as unknown as ProjectDetail;

const GEZELS = [
  { id: 'g1', name: 'Esra' },
  { id: 'g2', name: 'Wren' },
] as unknown as GezelSummary[];

function session(
  id: string,
  gezelId: string,
  overrides: Partial<ChatSessionSummary> = {},
): ChatSessionSummary {
  return {
    id,
    gezelId,
    projectId: 'p1',
    providerName: 'openai',
    title: `Thread ${id}`,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  } as ChatSessionSummary;
}

const TASK = {
  projectId: 'p1',
  num: 4,
  ref: 'p1/4',
  title: 'Ship the game',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'g2' },
  activeStepId: 'step-1',
} as unknown as Task;

beforeEach(() => {
  railFocusCalls.length = 0;
  vi.mocked(api.listGezels).mockResolvedValue({ gezels: GEZELS });
  vi.mocked(api.listInflightTurns).mockResolvedValue({ inflight: [] });
  vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] });
  vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(api.listTaskSessions).mockResolvedValue({ sessions: [] });
});

describe('ProjectChat task pill focus', () => {
  it("lands on the task's own thread even when it belongs to another gezel", async () => {
    // Esra's lobby thread is the newest ordinary thread — the one the
    // switcher would auto-pick if the task scope failed to reach it.
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [TASK] });
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [session('lobby-g2', 'g2'), session('lobby-g1', 'g1')],
    });
    vi.mocked(api.listTaskSessions).mockResolvedValue({
      sessions: [session('task-thread', 'g2', { taskRef: 'p1/4' })],
    });

    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);

    await user.click(await screen.findByRole('button', { name: 'Task p1/4: Ship the game' }));

    await waitFor(
      () => {
        const composer = screen.getByTestId('composer');
        expect(composer.getAttribute('data-gezel')).toBe('g2');
        expect(composer.getAttribute('data-session')).toBe('task-thread');
      },
      { timeout: 2000 },
    );

    // And it stays there — the switcher's auto-pick gets a chance to run
    // on every settle, so a late stomp would show up as a flip to the lobby.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('composer')).toHaveAttribute('data-session', 'task-thread');
  });

  it('scopes the composer and the switcher to the task', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [TASK] });
    vi.mocked(api.listTaskSessions).mockResolvedValue({
      sessions: [session('task-thread', 'g2', { taskRef: 'p1/4' })],
    });

    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);
    await user.click(await screen.findByRole('button', { name: 'Task p1/4: Ship the game' }));

    await waitFor(() => {
      expect(screen.getByTestId('composer')).toHaveAttribute('data-task', 'p1/4');
    });
    // The switcher lists the task's threads, not the gezel's lobby ones.
    await waitFor(() => {
      expect(vi.mocked(api.listTaskSessions)).toHaveBeenCalledWith('p1', 4);
    });
  });

  it('opens the task in the rail as well as the composer', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [TASK] });
    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);

    await user.click(await screen.findByRole('button', { name: 'Task p1/4: Ship the game' }));
    expect(railFocusCalls).toContainEqual({ ref: 'p1/4', focus: true });
  });

  it('leaves the composer unscoped when a task has no thread yet', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [TASK] });
    vi.mocked(api.listTaskSessions).mockResolvedValue({ sessions: [] });

    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);
    await user.click(await screen.findByRole('button', { name: 'Task p1/4: Ship the game' }));

    await waitFor(() => {
      const composer = screen.getByTestId('composer');
      // Pointed at the assignee with the scope set, but no thread minted —
      // ChatComposer lazy-creates on first send.
      expect(composer).toHaveAttribute('data-gezel', 'g2');
      expect(composer).toHaveAttribute('data-task', 'p1/4');
    });
    expect(vi.mocked(api.createChatSession)).not.toHaveBeenCalled();
  });

  it('clears the task scope when an ordinary thread pill is focused', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [TASK] });
    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('lobby-g1', 'g1')] });
    vi.mocked(api.listTaskSessions).mockResolvedValue({
      sessions: [session('task-thread', 'g2', { taskRef: 'p1/4' })],
    });

    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);

    await user.click(await screen.findByRole('button', { name: 'Task p1/4: Ship the game' }));
    await waitFor(() => {
      expect(screen.getByTestId('composer')).toHaveAttribute('data-task', 'p1/4');
    });

    await user.click(screen.getByRole('button', { name: /^Esra: Thread lobby-g1\./ }));
    await waitFor(() => {
      const composer = screen.getByTestId('composer');
      expect(composer).toHaveAttribute('data-task', '');
      expect(composer).toHaveAttribute('data-session', 'lobby-g1');
    });
  });

  it('opens the new-task dialog from the + button', async () => {
    const user = userEvent.setup();
    render(<ProjectChat project={PROJECT} />);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    expect(screen.getByTestId('new-task-dialog')).toBeVisible();
  });
});
