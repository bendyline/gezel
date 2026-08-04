import type { Task } from '@bendyline/gezel';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_RAIL_MIN_SPLIT_PX, ChatReferences } from './ChatReferences.js';

const apiMocks = vi.hoisted(() => ({
  getTaskByRef: vi.fn(),
  listTaskNotes: vi.fn(),
  readProjectArtifact: vi.fn(),
  readDocument: vi.fn(),
  readProjectWorkspaceFile: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMocks }));

vi.mock('./CommandsPanel.js', () => ({
  CommandsPanel: () => <div data-testid="commands-panel" />,
}));

let activeWidth = 0;

beforeEach(() => {
  apiMocks.listTaskNotes.mockResolvedValue({ notes: [] });
  apiMocks.readProjectArtifact.mockImplementation(async (_projectId, path) => ({
    content: `# ${path}`,
  }));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => activeWidth,
  });
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(): void {
      queueMicrotask(() => this.cb([], this as unknown as ResizeObserver));
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
});

function renderProjectRail() {
  return render(
    <ChatReferences chatKey="project-1" projectId="project-1" commandsProjectId="project-1">
      {() => <div data-testid="chat-main" />}
    </ChatReferences>,
  );
}

function task(ref: string, title: string): Task {
  const [projectId, rawNum] = ref.split('/');
  return {
    projectId,
    num: Number(rawNum),
    ref,
    title,
    status: 'active',
    assignee: { kind: 'user' },
    craftbook: {
      id: `craftbook-${rawNum}`,
      name: 'Review',
      steps: [{ id: 'step-1', name: 'Inspect', createdAt: '2026-07-26T00:00:00.000Z' }],
      entryStepId: 'step-1',
      activeStepId: 'step-1',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    activeStepId: 'step-1',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    createdBy: { kind: 'user' },
  } as unknown as Task;
}

describe('ChatReferences responsive split', () => {
  it('drops the right pane before the chat would fall below its minimum width', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX - 1;
    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(container.querySelector('.chat-rail-body-compact')).not.toBeNull();
    });
    expect(container.querySelector('aside')).toBeNull();
    expect(screen.queryByTestId('commands-panel')).not.toBeInTheDocument();
  });

  it('keeps the right pane at the minimum viable split width', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(container.querySelector('.chat-rail-body-split')).not.toBeNull();
    });
    expect(container.querySelector('aside')).not.toBeNull();
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
  });
});

describe('ChatReferences task picker', () => {
  it('replaces legacy generated ISO titles with the craftbook name', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.getTaskByRef.mockResolvedValue(task('project-1/1', 'craftbook-1 — 2026-07-28T13:19'));

    render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onTaskReference }) => (
          <button type="button" onClick={() => onTaskReference('project-1/1')}>
            Add task reference
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Add task reference' }));

    expect(await screen.findByRole('heading', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByText('craftbook-1 — 2026-07-28T13:19')).not.toBeInTheDocument();
  });

  it('selects referenced tasks from a dropdown in the Tasks tab', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.getTaskByRef.mockImplementation(async (ref) =>
      ref === 'project-1/2'
        ? task('project-1/2', 'Second task')
        : task('project-1/1', 'First task'),
    );

    const { container } = render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onTaskReference }) => (
          <button
            type="button"
            onClick={() => {
              onTaskReference('project-1/1', { scoped: true });
              onTaskReference('project-1/2');
            }}
          >
            Add task references
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Add task references' }));

    const taskTab = await screen.findByRole('tab', { name: 'Tasks' });
    expect(taskTab).toHaveAttribute('aria-haspopup', 'menu');
    expect(container.querySelector('nav[aria-label="Tasks"]')).toBeNull();
    expect(await screen.findByText('First task')).toBeInTheDocument();

    await user.click(taskTab);
    await user.click(await screen.findByRole('menuitem', { name: 'project-1/2' }));

    expect(await screen.findByText('Second task')).toBeInTheDocument();
    expect(apiMocks.getTaskByRef).toHaveBeenLastCalledWith('project-1/2');
  });

  it('puts the full-task action at the top and shows notes newest first', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.getTaskByRef.mockResolvedValue(task('project-1/1', 'First task'));
    apiMocks.listTaskNotes.mockResolvedValue({
      notes: [
        {
          id: 'older',
          at: '2026-07-27T10:00:00.000Z',
          author: { kind: 'user' },
          text: 'Older note',
        },
        {
          id: 'newer',
          at: '2026-07-28T10:00:00.000Z',
          author: { kind: 'gezel', gezelId: 'maya', name: 'Maya' },
          stepId: 'step-1',
          text: 'Newest note',
        },
      ],
    });

    const { container } = render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onTaskReference }) => (
          <button type="button" onClick={() => onTaskReference('project-1/1')}>
            Add task reference
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Add task reference' }));

    expect(await screen.findByRole('heading', { name: 'History & notes' })).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.listTaskNotes).toHaveBeenCalledWith('project-1', 1);
    });

    const rail = container.querySelector('.chat-rail-task');
    const topbar = rail?.firstElementChild;
    expect(topbar).toHaveClass('chat-rail-task-topbar');
    expect(
      within(topbar as HTMLElement).getByRole('button', { name: 'Open full task' }),
    ).toBeVisible();

    const noteBodies = Array.from(container.querySelectorAll('.chat-rail-task-note'));
    expect(noteBodies).toHaveLength(2);
    expect(noteBodies[0]).toHaveTextContent('Newest note');
    expect(noteBodies[0]).toHaveTextContent('Maya');
    expect(noteBodies[0]).toHaveTextContent('Inspect');
    expect(noteBodies[1]).toHaveTextContent('Older note');
  });
});

describe('ChatReferences reference picker', () => {
  it('promotes a terminal workspace reference into the previewer', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.readProjectWorkspaceFile.mockRejectedValue(
      new Error('Preview unavailable in workspace-reference test'),
    );

    render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onWorkspaceReference }) => (
          <button type="button" onClick={() => onWorkspaceReference('battle-research.md')}>
            Open workspace reference
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Open workspace reference' }));

    await waitFor(() => {
      expect(apiMocks.readProjectWorkspaceFile).toHaveBeenCalledWith(
        'project-1',
        'battle-research.md',
      );
    });
  });

  it('selects files from a dropdown under the References tab', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    // Keep the viewer on its lightweight error path. This test exercises the
    // picker; rendering markdown would pull canvas/media behavior into jsdom
    // that belongs to the previewer's own coverage.
    apiMocks.readProjectArtifact.mockRejectedValue(new Error('Preview unavailable in picker test'));

    const { container } = render(
      <ChatReferences chatKey="project-1" projectId="project-1" commandsProjectId="project-1">
        {({ onToolActivity }) => (
          <button
            type="button"
            onClick={() => {
              onToolActivity({
                name: 'read_artifact',
                path: 'outline.md',
                success: true,
                durationMs: 1,
              });
              onToolActivity({
                name: 'read_artifact',
                path: 'design.md',
                success: true,
                durationMs: 1,
              });
            }}
          >
            Add references
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Add references' }));

    const referencesTab = await screen.findByRole('tab', { name: 'References' });
    expect(referencesTab).toHaveAttribute('aria-haspopup', 'menu');
    expect(container.querySelector('nav[aria-label="References"]')).toBeNull();

    await user.click(referencesTab);
    await user.click(await screen.findByRole('menuitem', { name: 'design.md' }));

    await waitFor(() => {
      expect(apiMocks.readProjectArtifact).toHaveBeenLastCalledWith('project-1', 'design.md');
    });
  });
});
