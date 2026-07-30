import type { GezelSummary, Task, TaskNote } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

// The Squisq markdown editor doesn't load in jsdom — replace it with a
// tiny stand-in that exposes the initial content + an emit-change
// trigger so we can drive state without Monaco.
vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    initialMarkdown,
    onChange,
    readOnly,
    toolbarSlotAfterActions,
  }: {
    initialMarkdown: string;
    onChange?: (s: string) => void;
    readOnly?: boolean;
    toolbarSlotAfterActions?: React.ReactNode;
  }) => (
    <div data-testid="editor" data-readonly={readOnly ? 'true' : 'false'}>
      <div data-testid="editor-initial">{initialMarkdown}</div>
      <button type="button" data-testid="editor-emit" onClick={() => onChange?.('drafted text')}>
        emit
      </button>
      {toolbarSlotAfterActions}
    </div>
  ),
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

vi.mock('../components/AiToolbarButtons.js', () => ({
  AiToolbarButtons: () => null,
}));
vi.mock('../components/PromoteToTabButton.js', () => ({
  PromoteToTabButton: () => <span data-testid="promote">promote</span>,
}));
vi.mock('../components/PromptDialog.js', () => ({
  PromptDialog: () => null,
}));
vi.mock('../components/TaskChatPane.js', () => ({
  TaskChatPane: () => <div data-testid="task-chat-pane">chat-pane</div>,
}));
vi.mock('../components/TaskStepPanel.js', () => ({
  TaskStepPanel: () => <div data-testid="task-step-panel">step-panel</div>,
}));
vi.mock('../components/TaskStepTracker.js', () => ({
  TaskStepTracker: () => <div data-testid="task-step-tracker">tracker</div>,
}));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

const { TaskDetail } = await import('./TaskDetail.js');
const { api } = await import('../api.js');

const TASK: Task = {
  projectId: 'pj-alpha',
  num: 42,
  ref: 'pj-alpha/42',
  title: 'Bake bread',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'gz-maya' },
  description: 'Existing description body.',
  craftbook: {
    id: 'cb',
    name: 'cb',
    steps: [{ id: 's1', name: 'Main', createdAt: '2025-01-01T00:00:00Z' }],
    entryStepId: 's1',
    activeStepId: 's1',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  activeStepId: 's1',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  createdBy: { kind: 'user' },
} as unknown as Task;

const GEZELS: GezelSummary[] = [
  { id: 'gz-maya', name: 'Maya' } as GezelSummary,
  { id: 'noor', name: 'Noor', role: 'Boekwachter' } as GezelSummary,
];

const NOTE: TaskNote = {
  id: 'note-1',
  text: 'Initial findings.',
  at: new Date().toISOString(),
  author: { kind: 'user' },
} as TaskNote;

describe('TaskDetail', () => {
  beforeEach(() => {
    vi.mocked(api.listTaskNotes).mockResolvedValue({ notes: [NOTE] } as never);
    vi.mocked(api.listTaskSessions).mockResolvedValue({ sessions: [] } as never);
    vi.mocked(api.listTaskChildren).mockResolvedValue({ tasks: [] } as never);
    vi.mocked(api.appendTaskNote).mockImplementation(
      async (_pid, _num, body) =>
        ({
          note: {
            id: `note-${Math.random().toString(16).slice(2, 8)}`,
            text: body.text,
            at: new Date().toISOString(),
            author: { kind: 'user' },
          },
        }) as never,
    );
    vi.mocked(api.deleteTaskNote).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.setTaskStatus).mockImplementation(
      async (_pid, _num, status) => ({ ...TASK, status }) as never,
    );
    vi.mocked(api.updateTask).mockImplementation(
      async (_pid, _num, patch) => ({ ...TASK, ...patch }) as never,
    );
  });

  it('renders the header with ref, project name, and title', async () => {
    render(<TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} />);
    expect(screen.getByText('pj-alpha/42')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Bake bread' })).toBeInTheDocument();
  });

  it('loads notes/sessions/children on mount', async () => {
    render(<TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} />);
    await waitFor(() => {
      expect(api.listTaskNotes).toHaveBeenCalledWith('pj-alpha', 42);
    });
    expect(api.listTaskSessions).toHaveBeenCalledWith('pj-alpha', 42);
    // listTaskChildren only fires when spawnsCraftbook is set; not for this fixture.
    expect(api.listTaskChildren).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('Initial findings.')).toBeInTheDocument();
    });
  });

  it('changing the status select calls setTaskStatus and propagates via onChanged', async () => {
    const onChanged = vi.fn();
    render(<TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={onChanged} />);

    // Two Select dropdowns — status (first) + assignee (second).
    const selects = screen.getAllByTestId('mock-select');
    const statusSelect = selects.find(
      (el) => within(el).queryByText('paused') !== null,
    ) as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'paused' } });

    await waitFor(() => {
      expect(api.setTaskStatus).toHaveBeenCalledWith('pj-alpha', 42, 'paused');
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('reassigning to user dispatches setTaskAssignee with kind:user', async () => {
    vi.mocked(api.setTaskAssignee).mockResolvedValue({ ...TASK } as never);
    render(<TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} />);

    const selects = screen.getAllByTestId('mock-select');
    const assigneeSelect = selects.find(
      (el) => within(el).queryByText(/→ You/) !== null,
    ) as HTMLSelectElement;
    fireEvent.change(assigneeSelect, { target: { value: '__user' } });

    await waitFor(() => {
      expect(api.setTaskAssignee).toHaveBeenCalledWith('pj-alpha', 42, { kind: 'user' });
    });
  });

  it('shows a system job as managed by its real gezel without a reassignment control', () => {
    const systemTask = {
      ...TASK,
      assignee: { kind: 'user' },
      origin: {
        kind: 'system-job',
        jobId: 'boekwachter-indexing',
        managedByGezelId: 'noor',
      },
    } as Task;
    render(
      <TaskDetail task={systemTask} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} />,
    );

    expect(screen.getByText('Noor')).toBeInTheDocument();
    expect(screen.getByText('· system-run')).toBeInTheDocument();
    expect(screen.queryByText('→ You')).not.toBeInTheDocument();
  });

  it('Post note calls appendTaskNote with the editor draft and current step id', async () => {
    render(<TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Initial findings.')).toBeInTheDocument();
    });

    // Emit a change in the composer (the first editor in the document).
    const editors = screen.getAllByTestId('editor-emit');
    // [0] is the description editor, [1] is the composer, [2..] are notes.
    // Both description and composer would call onChange — we want the composer.
    // Click the composer's emit button (it's the second editor).
    fireEvent.click(editors[1]!);

    fireEvent.click(screen.getByRole('button', { name: /Post note/ }));

    await waitFor(() => {
      expect(api.appendTaskNote).toHaveBeenCalledWith(
        'pj-alpha',
        42,
        expect.objectContaining({ text: 'drafted text', stepId: 's1' }),
      );
    });
  });

  it('saving the description bubbles dirty → saving → updateTask', async () => {
    const onChanged = vi.fn();
    render(<TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={onChanged} />);

    // Description Save button starts disabled.
    const saveBtn = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement;
    expect(saveBtn).toBeDisabled();

    // Emit a change in the description editor (first editor).
    const editors = screen.getAllByTestId('editor-emit');
    fireEvent.click(editors[0]!);

    await waitFor(() => {
      expect(saveBtn).toBeEnabled();
    });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.updateTask).toHaveBeenCalledWith(
        'pj-alpha',
        42,
        expect.objectContaining({ description: 'drafted text' }),
      );
    });
  });

  it('switching to the Chat tab mounts the chat pane', async () => {
    render(<TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} />);
    expect(screen.queryByTestId('task-chat-pane')).not.toBeInTheDocument();

    // The Task/Chat view switch is two role=tab buttons left of the bench.
    const chatTab = screen.getByRole('tab', { name: /^Chat/ });
    fireEvent.click(chatTab);

    await waitFor(() => {
      expect(screen.getByTestId('task-chat-pane')).toBeInTheDocument();
    });
  });

  it('hides the promote-to-tab button in standalone mode', async () => {
    render(
      <TaskDetail task={TASK} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} standalone />,
    );
    expect(screen.queryByTestId('promote')).not.toBeInTheDocument();
  });

  it('a catalog-craftbook draft shows the Fire button without plan guardrails', async () => {
    const draft = {
      ...TASK,
      status: 'draft',
      sourceCraftbookIds: [{ role: 'main', catalogId: 'code-review', sourceId: 'bundled' }],
    } as unknown as Task;
    vi.mocked(api.activateTask).mockResolvedValue({ ...draft, status: 'active' } as never);
    const onChanged = vi.fn();
    render(<TaskDetail task={draft} gezels={GEZELS} projectName="Alpha" onChanged={onChanged} />);

    expect(screen.getByText('ready')).toBeInTheDocument();
    const fire = screen.getByRole('button', { name: 'Fire task' });
    // Curated recipes skip the readiness warnings a hand-authored plan gets.
    expect(fire).not.toHaveAttribute('title');
    fireEvent.click(fire);
    await waitFor(() => {
      expect(api.activateTask).toHaveBeenCalledWith('pj-alpha', 42, false);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('a hand-authored draft keeps the guardrail warnings on its fire button', async () => {
    const draft = { ...TASK, status: 'draft' } as unknown as Task;
    render(<TaskDetail task={draft} gezels={GEZELS} projectName="Alpha" onChanged={vi.fn()} />);

    expect(screen.getByText('draft')).toBeInTheDocument();
    // The thin one-step fixture trips guardrails → the "anyway" label + hint.
    const fire = screen.getByRole('button', { name: 'Fire anyway' });
    expect(fire).toHaveAttribute('title', expect.stringContaining('Before running'));
  });
});
