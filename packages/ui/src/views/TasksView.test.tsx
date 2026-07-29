import type { GezelSummary, Project, Task } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

vi.mock('./TaskTabContent.js', () => ({
  TaskTabContent: ({ taskRef }: { taskRef: string }) => (
    <div data-testid="task-tab-content">{taskRef}</div>
  ),
}));

// The dialog's own behavior (gallery, craftbooks, create requests) is
// covered in tasks/NewTaskDialog.test.tsx — here it's stubbed down to
// its open/created/close contract.
vi.mock('./tasks/NewTaskDialog.js', () => ({
  NewTaskDialog: ({
    open,
    creationMode,
    defaultProjectId,
    onCreated,
  }: {
    open: boolean;
    creationMode: string;
    defaultProjectId: string;
    onCreated: (t: unknown) => void;
  }) =>
    open ? (
      <div data-testid="new-task-dialog" data-project={defaultProjectId} data-mode={creationMode}>
        <button
          type="button"
          data-testid="dialog-create"
          onClick={() =>
            onCreated({ ref: `${defaultProjectId}/9`, projectId: defaultProjectId, num: 9 })
          }
        >
          create
        </button>
      </div>
    ) : null,
}));

const { TasksView } = await import('./TasksView.js');
const { api } = await import('../api.js');

const PROJECTS: Project[] = [{ id: 'pj-alpha', name: 'Alpha' } as Project];
const GEZELS: GezelSummary[] = [
  { id: 'gz-maya', name: 'Maya', role: 'Researcher' } as GezelSummary,
];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    projectId: 'pj-alpha',
    num: 1,
    ref: 'pj-alpha/1',
    title: 'Bake bread',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'gz-maya' },
    craftbook: {
      id: 'cb',
      name: 'cb',
      steps: [{ id: 's1', name: 'Main', createdAt: '2025-01-01T00:00:00Z' }],
      entryStepId: 's1',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    createdBy: { kind: 'user' },
    ...overrides,
  } as Task;
}

describe('TasksView', () => {
  beforeEach(() => {
    vi.mocked(api.listProjects).mockResolvedValue({ projects: PROJECTS } as never);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: GEZELS } as never);
    vi.mocked(api.listTasks).mockResolvedValue({ tasks: [] } as never);
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] } as never);
    window.localStorage.clear();
  });

  it('renders the empty-state when no tasks exist', async () => {
    render(<TasksView />);
    await waitFor(() => {
      expect(screen.getByText('No one-time tasks have been created yet.')).toBeInTheDocument();
    });
    expect(screen.getByText(/Click a task to view it here\./)).not.toBeVisible();
  });

  it('uses a filtered empty-state when no tasks match the active filters', async () => {
    render(<TasksView />);
    await waitFor(() => {
      expect(screen.getByText('No one-time tasks have been created yet.')).toBeInTheDocument();
    });

    const statusSelect = screen
      .getAllByTestId('mock-select')
      .find((el) => within(el).queryByText(/All statuses/)) as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'active' } });

    await waitFor(() => {
      expect(screen.getByText('No tasks match these filters.')).toBeInTheDocument();
    });
  });

  it('lists tasks from the API and auto-selects the first so the pane is never empty', async () => {
    vi.mocked(api.listTasks).mockResolvedValue({
      tasks: [makeTask({ ref: 'pj-alpha/1', title: 'Bake bread' })],
    } as never);
    render(<TasksView />);
    await waitFor(() => {
      expect(screen.getByText('Bake bread')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText(/Click a task to view it here\./)).not.toBeInTheDocument();
    });
  });

  it('clicking a task selects it and mounts TaskTabContent in the right pane', async () => {
    vi.mocked(api.listTasks).mockResolvedValue({
      tasks: [makeTask({ ref: 'pj-alpha/1', title: 'Bake bread' })],
    } as never);
    render(<TasksView />);
    await waitFor(() => {
      expect(screen.getByText('Bake bread')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Bake bread/ }));

    await waitFor(() => {
      expect(screen.getByTestId('task-tab-content')).toBeInTheDocument();
    });
    expect(screen.getByTestId('task-tab-content')).toHaveTextContent('pj-alpha/1');
    expect(window.localStorage.getItem('gezel:tasks:selectedRef')).toBe('pj-alpha/1');
  });

  it('parents with children render an expand toggle that reveals the child rows', async () => {
    vi.mocked(api.listTasks).mockResolvedValue({
      tasks: [
        makeTask({ ref: 'pj-alpha/parent', title: 'Parent task' }),
        makeTask({
          ref: 'pj-alpha/child-1',
          parentTaskRef: 'pj-alpha/parent',
          title: 'Child run',
        }),
      ],
    } as never);
    render(<TasksView />);
    await waitFor(() => {
      expect(screen.getByText('Parent task')).toBeInTheDocument();
    });

    // Child should be hidden until the toggle is clicked.
    expect(screen.queryByText('Child run')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Expand instances/ }));

    await waitFor(() => {
      expect(screen.getByText('Child run')).toBeInTheDocument();
    });
  });

  it('filters top-level tasks with radio-style task type keys', async () => {
    vi.mocked(api.listTasks).mockResolvedValue({
      tasks: [
        makeTask({ ref: 'pj-alpha/1', title: 'One-off task' }),
        makeTask({
          ref: 'pj-alpha/2',
          title: 'Weekly task',
          cron: { expression: '0 9 * * 1' },
        }),
        makeTask({
          ref: 'pj-alpha/3',
          title: 'Overnight task',
          nightShift: { enabled: true },
        }),
      ],
    } as never);
    render(<TasksView />);

    expect(await screen.findByText('One-off task')).toBeInTheDocument();
    expect(screen.queryByText('Weekly task')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Scheduled tasks' }));
    expect(await screen.findByText('Weekly task')).toBeInTheDocument();
    expect(screen.queryByText('One-off task')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Night Shift tasks' }));
    expect(await screen.findByText('Overnight task')).toBeInTheDocument();
    expect(screen.queryByText('Weekly task')).not.toBeInTheDocument();
  });

  it('changing the status filter triggers a refetch with that status', async () => {
    render(<TasksView />);
    await waitFor(() => {
      expect(api.listTasks).toHaveBeenCalled();
    });
    vi.mocked(api.listTasks).mockClear();

    const statusSelect = screen
      .getAllByTestId('mock-select')
      .find((el) => within(el).queryByText(/All statuses/)) as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'active' } });

    await waitFor(() => {
      expect(api.listTasks).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    });
  });

  it('+ New task opens the dialog scoped to the active project', async () => {
    render(<TasksView />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /\+ New task/ })).toBeEnabled();
    });
    expect(screen.queryByTestId('new-task-dialog')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /\+ New task/ }));

    const dialog = screen.getByTestId('new-task-dialog');
    expect(dialog).toHaveAttribute('data-project', 'pj-alpha');
    expect(dialog).toHaveAttribute('data-mode', 'one-time');
  });

  it('opens scheduled and Night Shift creation from the New task split menu', async () => {
    render(<TasksView />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('menuitem', { name: /New scheduled task/ }));
    expect(screen.getByTestId('new-task-dialog')).toHaveAttribute('data-mode', 'scheduled');

    // Close through the stub's successful create, then open the other variant.
    await user.click(screen.getByTestId('dialog-create'));
    await waitFor(() => expect(screen.queryByTestId('new-task-dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('menuitem', { name: /New Night Shift task/ }));
    expect(screen.getByTestId('new-task-dialog')).toHaveAttribute('data-mode', 'night-shift');
  });

  it('a created task closes the dialog, refreshes the list, and selects it', async () => {
    render(<TasksView />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /\+ New task/ })).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /\+ New task/ }));
    vi.mocked(api.listTasks).mockClear();
    await user.click(screen.getByTestId('dialog-create'));

    await waitFor(() => {
      expect(screen.queryByTestId('new-task-dialog')).not.toBeInTheDocument();
    });
    expect(api.listTasks).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('task-tab-content')).toHaveTextContent('pj-alpha/9');
    });
  });

  it('uses listProjectTasks (not listTasks) when projectId prop is given', async () => {
    render(<TasksView projectId="pj-alpha" />);
    await waitFor(() => {
      expect(api.listProjectTasks).toHaveBeenCalledWith('pj-alpha', expect.any(Object));
    });
    expect(api.listTasks).not.toHaveBeenCalled();
  });
});
