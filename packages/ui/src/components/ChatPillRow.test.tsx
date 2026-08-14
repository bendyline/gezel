import type {
  ChatEventEnvelope,
  ChatSessionSummary,
  GezelSummary,
  Task,
  TerminalThreadSummary,
} from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

/**
 * Fan-out stream stub. The real `subscribeShared` multiplexes one upstream
 * to every subscriber, and this component mounts two of them (threads and
 * tasks) — so each consumer needs its own queue. A single shared queue
 * would let whichever hook polled first swallow the envelope.
 */
const stream = vi.hoisted(() => {
  interface Consumer {
    pending: ChatEventEnvelope[];
    wake: (() => void) | null;
  }
  const consumers = new Set<Consumer>();
  return {
    push(envelope: ChatEventEnvelope) {
      for (const c of consumers) {
        c.pending.push(envelope);
        c.wake?.();
        c.wake = null;
      }
    },
    reset() {
      consumers.clear();
    },
    async *consume(): AsyncGenerator<ChatEventEnvelope> {
      const self: Consumer = { pending: [], wake: null };
      consumers.add(self);
      try {
        while (true) {
          while (self.pending.length > 0) yield self.pending.shift() as ChatEventEnvelope;
          await new Promise<void>((resolve) => {
            self.wake = resolve;
          });
        }
      } finally {
        consumers.delete(self);
      }
    },
  };
});

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: () => stream.consume(),
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatPillRow } = await import('./ChatPillRow.js');
const { api } = await import('../api.js');

const GEZELS = [
  { id: 'g1', name: 'Esra', role: 'Developer' },
  { id: 'g2', name: 'Wren', role: 'Designer' },
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

function envelope(sessionId: string, event: ChatEventEnvelope['event']): ChatEventEnvelope {
  return { sessionId, gezelId: 'g1', projectId: 'p1', event };
}

function userMessage(content: string): ChatEventEnvelope['event'] {
  return {
    type: 'user_message',
    message: { role: 'user', content, at: new Date().toISOString() },
  };
}

function task(ref: string, title: string): Task {
  const [projectId, num] = ref.split('/');
  return {
    projectId,
    num: Number(num),
    ref,
    title,
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'g1' },
  } as unknown as Task;
}

function renderRow(props: Partial<Parameters<typeof ChatPillRow>[0]> = {}) {
  const onFocusThread = vi.fn();
  const onFocusTask = vi.fn();
  const onFocusTerminal = vi.fn();
  const onNewTask = vi.fn();
  const utils = render(
    <ChatPillRow
      projectId="p1"
      gezels={GEZELS}
      onFocusThread={onFocusThread}
      onFocusTask={onFocusTask}
      onFocusTerminal={onFocusTerminal}
      onNewTask={onNewTask}
      {...props}
    />,
  );
  return { ...utils, onFocusThread, onFocusTask, onFocusTerminal, onNewTask };
}

beforeEach(() => {
  stream.reset();
  vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(api.listInflightTurns).mockResolvedValue({ inflight: [] });
  vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] });
  vi.mocked(api.listTerminalThreads).mockResolvedValue({ threads: [] });
});

describe('ChatPillRow', () => {
  it('shows an empty state and still offers the Do + button', async () => {
    renderRow();
    expect(await screen.findByText('No recent threads')).toBeVisible();
    expect(screen.getByRole('button', { name: 'New task' })).toHaveTextContent('Do +');
  });

  it('hides the Do + button when the surface cannot create tasks', async () => {
    renderRow({ onNewTask: undefined });
    await screen.findByText('No recent threads');
    expect(screen.queryByRole('button', { name: 'New task' })).toBeNull();
  });

  it('shows a rounded three-line summary with bounded title and message previews', async () => {
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [
        session('s1', 'g1', {
          title: '1234567890123456789012345678901234567890more',
          lastMessagePreview: 'abcdefghijklmnopqrstuvwxyz1234567890',
          involvedGezelIds: ['g1', 'g2'],
          lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        }),
      ],
    });
    renderRow();

    const pill = await screen.findByRole('button', {
      name: /^Esra, Wren: .*Updated 2 minutes ago\. Ready$/,
    });
    expect(pill.querySelector('.chat-pill-thread-title')).toHaveTextContent(
      '123456789012345678901234567890123456789…',
    );
    expect(pill.querySelector('.chat-pill-participants')).toHaveTextContent('Esra, Wren');
    expect(pill.querySelector('.chat-pill-message-preview')).toHaveTextContent(
      'abcdefghijklmnopqrstuvwxyz123…',
    );
    expect(pill.querySelector('.chat-pill-thread-update')).toHaveTextContent(
      'Updated 2 minutes ago',
    );
    expect(pill.querySelector('.chat-pill-thread-status')).toHaveTextContent('Ready');
  });

  it('flips a pill to streaming from a live event with no refetch, then clears it', async () => {
    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('s1', 'g1')] });
    renderRow();

    const pill = await screen.findByRole('button', { name: /^Esra: Thread s1\..*Ready$/ });
    expect(pill).toBeVisible();
    const callsAfterMount = vi.mocked(api.listChatSessions).mock.calls.length;

    stream.push(envelope('s1', userMessage('go')));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Esra: Thread s1\..*Working$/ })).toBeVisible();
    });
    expect(pill.querySelector('.chat-pill-message-preview')).toHaveTextContent('go');
    expect(vi.mocked(api.listChatSessions).mock.calls.length).toBe(callsAfterMount);

    stream.push(
      envelope('s1', {
        type: 'complete',
        message: {
          role: 'assistant',
          content: 'Finished the latest reply.',
          at: new Date().toISOString(),
        },
      }),
    );
    await waitFor(() => {
      expect(pill.querySelector('.chat-pill-message-preview')).toHaveTextContent(
        'Finished the latest reply.',
      );
    });

    stream.push(envelope('s1', { type: 'done' } as never));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Esra: Thread s1\..*Ready$/ })).toBeVisible();
    });
  });

  it('reconciles a newly-created thread when its first live event arrives', async () => {
    renderRow();
    await screen.findByText('No recent threads');
    const callsAfterMount = vi.mocked(api.listChatSessions).mock.calls.length;

    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('s-new', 'g1')] });
    stream.push(envelope('s-new', userMessage('go')));

    expect(
      await screen.findByRole('button', { name: /^Esra: Thread s-new\..*Working$/ }),
    ).toBeVisible();
    expect(vi.mocked(api.listChatSessions).mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it('re-reads sessions when a just-created thread becomes active', async () => {
    const row = renderRow();
    await screen.findByText('No recent threads');

    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('s-new', 'g1')] });
    row.rerender(
      <ChatPillRow
        projectId="p1"
        gezels={GEZELS}
        activeSessionId="s-new"
        onFocusThread={row.onFocusThread}
        onFocusTask={row.onFocusTask}
        onNewTask={row.onNewTask}
      />,
    );

    const pill = await screen.findByRole('button', { name: /^Esra: Thread s-new\..*Ready$/ });
    expect(pill).toBeVisible();
    expect(pill).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks a pill errored optimistically on a live error event', async () => {
    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('s1', 'g1')] });
    renderRow();
    await screen.findByRole('button', { name: /^Esra: Thread s1\..*Ready$/ });

    stream.push(envelope('s1', { type: 'error', error: 'provider timeout' } as never));
    const failed = await screen.findByRole('button', {
      name: /^Esra: Thread s1\..*Needs attention$/,
    });
    expect(failed).toHaveAttribute('title', expect.stringContaining('provider timeout'));
  });

  it('seeds streaming state from the in-flight snapshot at mount', async () => {
    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('s1', 'g1')] });
    vi.mocked(api.listInflightTurns).mockResolvedValue({
      inflight: [{ sessionId: 's1' }],
    } as never);
    renderRow();
    expect(
      await screen.findByRole('button', { name: /^Esra: Thread s1\..*Working$/ }),
    ).toBeVisible();
  });

  it('focuses a thread on click and marks the active one pressed', async () => {
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [session('s1', 'g1'), session('s2', 'g2')],
    });
    const user = userEvent.setup();
    const { onFocusThread } = renderRow({ activeSessionId: 's2' });

    const pill = await screen.findByRole('button', { name: /^Esra: Thread s1\..*Ready$/ });
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^Wren: Thread s2\..*Ready$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(pill);
    expect(onFocusThread).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', gezelId: 'g1' }),
    );
  });

  it('shows a recent terminal window and restores it from its task-bar chip', async () => {
    const terminal: TerminalThreadSummary = {
      id: 'packages-ui',
      projectId: 'p1',
      workingDir: 'packages/ui',
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      lastCommand: 'ls',
    };
    vi.mocked(api.listTerminalThreads).mockResolvedValue({ threads: [terminal] });
    const user = userEvent.setup();
    const { onFocusTerminal } = renderRow({ activeTerminalThreadId: terminal.id });

    const chip = await screen.findByRole('button', {
      name: 'Terminal /packages/ui. Last command: ls. Updated 2 minutes ago',
    });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveTextContent('Terminal');
    expect(chip).toHaveTextContent('/packages/ui');
    expect(chip).toHaveTextContent('ls');

    await user.click(chip);
    expect(onFocusTerminal).toHaveBeenCalledWith(terminal);
  });

  it('routes overflow menu items through the same thread-focus handler', async () => {
    const now = Date.now();
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: Array.from({ length: 8 }, (_, i) =>
        session(`s${i}`, 'g1', {
          lastActivityAt: new Date(now - (i + 1) * 60_000).toISOString(),
          title: `Thread ${i}`,
        }),
      ),
    });
    const user = userEvent.setup();
    const { onFocusThread } = renderRow();

    const trigger = await screen.findByRole('button', { name: '+2 more' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: /Thread 7/ }));

    expect(onFocusThread).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's7' }));
  });

  it('renders active tasks and focuses one on click', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [task('p1/4', 'Ship the game')] });
    const user = userEvent.setup();
    const { onFocusTask } = renderRow({ activeTaskRef: 'p1/4' });

    const pill = await screen.findByRole('button', {
      name: 'Task p1/4: Ship the game. No chat yet. Assigned to Esra. Active',
    });
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    expect(pill.querySelector('.chat-pill-task-icon')).not.toBeNull();
    expect(pill.querySelector('.chat-pill-task-number')).toHaveTextContent('#4');
    expect(pill).toHaveTextContent('Ship the game');
    expect(pill.querySelector('.chat-pill-participants')).toHaveTextContent('Esra');
    expect(pill.querySelector('.chat-pill-message-preview')).toHaveTextContent('No chat yet');
    expect(pill.querySelector('.chat-pill-thread-updated-at')).toHaveTextContent('p1/4');
    expect(pill.querySelector('.chat-pill-thread-status')).toHaveTextContent('Active');
    await user.click(pill);
    expect(onFocusTask).toHaveBeenCalledWith(expect.objectContaining({ ref: 'p1/4' }));
  });

  it('keeps active tasks before recent threads in the horizontal strip', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [task('p1/9', 'New work')] });
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [session('recent-thread', 'g1')],
    });
    renderRow();

    const taskPill = await screen.findByRole('button', {
      name: /^Task p1\/9: New work\./,
    });
    const threadPill = screen.getByRole('button', {
      name: /^Esra: Thread recent-thread\./,
    });
    expect(
      taskPill.compareDocumentPosition(threadPill) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('unifies an active task with its latest chat instead of rendering a second pill', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [task('p1/4', 'Ship the game')] });
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [
        session('latest', 'g2', {
          taskRef: 'p1/4',
          title: 'Implementation handoff',
          lastMessagePreview: 'The final polish is ready.',
          lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        }),
        session('older', 'g1', {
          taskRef: 'p1/4',
          lastActivityAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        }),
      ],
    });
    renderRow();

    const pill = await screen.findByRole('button', {
      name: /^Task p1\/4: Ship the game\. Latest chat with Wren: Implementation handoff\./,
    });
    expect(pill.querySelector('.chat-pill-task-icon')).not.toBeNull();
    expect(pill.querySelector('.chat-pill-task-number')).toHaveTextContent('#4');
    expect(pill.querySelector('.chat-pill-participants')).toHaveTextContent('Wren');
    expect(pill.querySelector('.chat-pill-message-preview')).toHaveTextContent(
      'The final polish is ready.',
    );
    expect(pill.querySelector('.chat-pill-thread-updated-at')).toHaveTextContent(
      'Updated 2 minutes ago',
    );
    expect(pill.querySelector('.chat-pill-thread-status')).toHaveTextContent('Ready');
    expect(screen.queryByRole('button', { name: /^Wren: Implementation handoff\./ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Esra: Thread older\./ })).toBeNull();
  });

  it('carries live chat state on the unified task pill', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [task('p1/4', 'Ship the game')] });
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [session('task-thread', 'g1', { taskRef: 'p1/4' })],
    });
    vi.mocked(api.listInflightTurns).mockResolvedValue({
      inflight: [{ sessionId: 'task-thread' }],
    } as never);
    renderRow();

    const pill = await screen.findByRole('button', {
      name: /^Task p1\/4: Ship the game\..*Working$/,
    });
    expect(pill).toHaveTextContent('Working');
    expect(screen.queryByRole('button', { name: /^Esra: Thread task-thread\./ })).toBeNull();
  });

  it('re-reads tasks when a task_event lands on the stream', async () => {
    renderRow();
    await screen.findByText('No recent threads');
    const before = vi.mocked(api.listProjectTasks).mock.calls.length;

    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [task('p1/9', 'New work')] });
    stream.push(
      envelope('s1', {
        type: 'task_event',
        eventId: 'e1',
        kind: 'task.created',
        summary: 'created',
        at: new Date().toISOString(),
      } as never),
    );

    // The re-read is debounced, so give it more than the default 1s window.
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /^Task p1\/9: New work\. No chat yet\./ }),
        ).toBeVisible();
      },
      { timeout: 3000 },
    );
    expect(vi.mocked(api.listProjectTasks).mock.calls.length).toBeGreaterThan(before);
  });

  describe('overflow bar', () => {
    // jsdom reports every scroll metric as 0, so the strip can never look
    // overflowed on its own.
    function stubScrollMetrics(scrollWidth: number, clientWidth: number) {
      const scrollWidthDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'scrollWidth',
      );
      const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'clientWidth',
      );
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get() {
          return (this as HTMLElement).classList.contains('chat-pill-row-scroll')
            ? scrollWidth
            : (scrollWidthDescriptor?.get?.call(this) ?? 0);
        },
      });
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get() {
          return (this as HTMLElement).classList.contains('chat-pill-row-scroll')
            ? clientWidth
            : (clientWidthDescriptor?.get?.call(this) ?? 0);
        },
      });
      return () => {
        if (scrollWidthDescriptor)
          Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidthDescriptor);
        if (clientWidthDescriptor)
          Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor);
      };
    }

    it('sizes a thumb to the visible fraction when the pills overflow', async () => {
      const restore = stubScrollMetrics(1000, 250);
      try {
        vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('s1', 'g1')] });
        const { container } = renderRow();
        await screen.findByRole('button', { name: /^Esra: Thread s1\./ });

        const thumb = await waitFor(() => {
          const found = container.querySelector<HTMLElement>('.chat-pill-row-bar-thumb');
          expect(found).not.toBeNull();
          return found as HTMLElement;
        });
        expect(thumb.style.width).toBe('25%');
        expect(thumb.style.left).toBe('0%');
      } finally {
        restore();
      }
    });

    it('stays out of the band while every pill fits', async () => {
      const restore = stubScrollMetrics(250, 250);
      try {
        vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [session('s1', 'g1')] });
        const { container } = renderRow();
        await screen.findByRole('button', { name: /^Esra: Thread s1\./ });

        expect(container.querySelector('.chat-pill-row-bar')).toBeNull();
      } finally {
        restore();
      }
    });
  });
});
