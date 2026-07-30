import type { Task } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_RAIL_MIN_SPLIT_PX, ChatReferences } from './ChatReferences.js';

const apiMocks = vi.hoisted(() => ({
  getTaskByRef: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMocks }));

vi.mock('./CommandsPanel.js', () => ({
  CommandsPanel: () => <div data-testid="commands-panel" />,
}));

let activeWidth = 0;

beforeEach(() => {
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
});
