import type { Task } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

// Mock the api singleton (used by the view's useEffect).
vi.mock('../api.js', () => ({ api: createMockApi() }));

// Mock the TaskDetail child so this test asserts on TaskTabContent's
// own responsibility — fetch (task, gezels, projects), pass to child,
// surface loading + error states. TaskDetail has its own future test.
vi.mock('./TaskDetail.js', () => ({
  TaskDetail: (props: {
    task: Task;
    projectName: string;
  }) => (
    <div data-testid="task-detail">
      <span data-testid="task-ref">{props.task.ref}</span>
      <span data-testid="project-name">{props.projectName}</span>
    </div>
  ),
}));

const { TaskTabContent } = await import('./TaskTabContent.js');
const { api } = await import('../api.js');

const FAKE_TASK = {
  projectId: 'pj-alpha',
  num: 42,
  ref: 'PROJ-42',
  title: 'Bake bread',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'gz-maya' },
  craftbook: {
    id: 'cb',
    name: 'Test',
    steps: [{ id: 's1', title: 'Step 1', createdAt: new Date().toISOString() }],
    entryStepId: 's1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: { kind: 'user' },
} as unknown as Task;

describe('TaskTabContent', () => {
  beforeEach(() => {
    // Sensible defaults for the parallel fetches the view fires on
    // mount; individual tests override `getTaskByRef`.
    vi.mocked(api.getTaskByRef).mockResolvedValue(FAKE_TASK);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] } as never);
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [] } as never);
  });

  it('shows a loading placeholder before the task arrives', async () => {
    let resolveTask!: (t: Task) => void;
    vi.mocked(api.getTaskByRef).mockReturnValue(
      new Promise<Task>((r) => {
        resolveTask = r;
      }),
    );

    render(<TaskTabContent taskRef="PROJ-42" />);

    expect(screen.getByText(/Loading task/)).toBeInTheDocument();

    // Drain so the cleanup tick doesn't warn about unfulfilled promises.
    resolveTask(FAKE_TASK);
  });

  it('renders TaskDetail with the loaded task once getTaskByRef resolves', async () => {
    vi.mocked(api.getTaskByRef).mockResolvedValue(FAKE_TASK);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'gz-maya', name: 'Maya' }] as never,
    });
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'pj-alpha', name: 'Alpha' }] as never,
    });

    render(<TaskTabContent taskRef="PROJ-42" />);

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });
    expect(screen.getByTestId('task-ref')).toHaveTextContent('PROJ-42');
    expect(screen.getByTestId('project-name')).toHaveTextContent('Alpha');
    expect(api.getTaskByRef).toHaveBeenCalledWith('PROJ-42');
  });

  it('shows an error placeholder when getTaskByRef rejects', async () => {
    vi.mocked(api.getTaskByRef).mockRejectedValue(new Error('not found: PROJ-99'));

    render(<TaskTabContent taskRef="PROJ-99" />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load task/)).toBeInTheDocument();
    });
    expect(screen.getByText(/not found: PROJ-99/)).toBeInTheDocument();
    // The taskRef should be rendered inside a <code> for clarity.
    expect(screen.getByText('PROJ-99').tagName).toBe('CODE');
  });

  it('uses the empty string for projectName when the task lives in a project the response does not list', async () => {
    vi.mocked(api.getTaskByRef).mockResolvedValue({
      ...FAKE_TASK,
      projectId: 'pj-orphan',
    } as Task);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'pj-alpha', name: 'Alpha' }] as never,
    });

    render(<TaskTabContent taskRef="PROJ-42" />);

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });
    expect(screen.getByTestId('project-name')).toHaveTextContent('');
  });

  it('refetches when taskRef changes', async () => {
    vi.mocked(api.getTaskByRef).mockResolvedValue(FAKE_TASK);
    const { rerender } = render(<TaskTabContent taskRef="PROJ-42" />);

    await waitFor(() => {
      expect(api.getTaskByRef).toHaveBeenCalledWith('PROJ-42');
    });

    vi.mocked(api.getTaskByRef).mockResolvedValue({ ...FAKE_TASK, ref: 'PROJ-99' } as Task);
    rerender(<TaskTabContent taskRef="PROJ-99" />);

    await waitFor(() => {
      expect(api.getTaskByRef).toHaveBeenCalledWith('PROJ-99');
    });
  });
});
