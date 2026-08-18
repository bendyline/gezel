import type { GezelSummary, Project, RecentTab } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
// Keep the avatar trivial so the gezel name only appears once in the row.
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));
// FileTree's menu mechanics are exercised by its own tests; expose its action
// callbacks here so this suite can verify the sidebar wiring and dialogs.
vi.mock('./FileTree.js', () => ({
  FileTree: ({
    entries,
    onRename,
    onDelete,
  }: {
    entries: Array<{ name: string; path: string; isDirectory: boolean }>;
    onRename?: (entry: { name: string; path: string; isDirectory: boolean }) => void;
    onDelete?: (entry: { name: string; path: string; isDirectory: boolean }) => void;
  }) => (
    <div data-testid="file-tree">
      {entries.length} docs
      {entries.map((entry) => (
        <span key={entry.path}>
          <button type="button" onClick={() => onRename?.(entry)}>
            Rename {entry.name}
          </button>
          <button type="button" onClick={() => onDelete?.(entry)}>
            Delete {entry.name}
          </button>
        </span>
      ))}
    </div>
  ),
}));

const { Sidebar } = await import('./Sidebar.js');
const { api } = await import('../api.js');
const { resetUpdateStateForTests } = await import('../update-state.js');
const { consumeFocusSessionError } = await import('./pending-focus-session-error.js');

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Alpha' } as Project,
  { id: 'p2', name: 'Beta' } as Project,
];
const GEZELS: GezelSummary[] = [{ id: 'g1', name: 'Maya', role: 'Researcher' } as GezelSummary];

describe('Sidebar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.listProjects).mockResolvedValue({ projects: PROJECTS } as never);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: GEZELS } as never);
    vi.mocked(api.listDocuments).mockResolvedValue({ files: [] } as never);
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock' } as never);
  });

  it('renders Home, groups, and area links', async () => {
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    expect(screen.getByTestId('sidebar-meester')).toHaveClass('app-sidebar-home');
    expect(screen.getByTestId('sidebar-group-projects')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-group-documents')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-group-gezels')).toBeInTheDocument();
    // Tasks / History are top-level links per the nav design.
    // Benchmarks is intentionally NOT here — it lives behind the
    // debug-gated "Benchmarks" tab in Settings (see AREA_LINKS in Sidebar.tsx).
    // Scripts is gated behind the "Show advanced features" flag (off here).
    expect(screen.getByTestId('sidebar-area-tasks')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-area-history')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-area-benchmarks')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar-area-settings')).toBeInTheDocument();
  });

  it('omits document folders that contain no visible files', async () => {
    window.localStorage.setItem('gezel:nav:groups', JSON.stringify({ documents: true }));
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [
        { name: 'empty', path: 'empty', isDirectory: true },
        { name: 'nested-empty', path: 'nested-empty', isDirectory: true },
        { name: 'child', path: 'nested-empty/child', isDirectory: true },
        { name: 'kept', path: 'kept', isDirectory: true },
        { name: 'notes.md', path: 'kept/notes.md', isDirectory: false },
      ],
    } as never);

    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('file-tree')).toHaveTextContent('2 docs'));
    expect(screen.queryByRole('button', { name: 'Rename empty' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename nested-empty' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename child' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename kept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename notes.md' })).toBeInTheDocument();
  });

  it('shows a per-row actions menu for each gezel', async () => {
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    fireEvent.click(screen.getByTestId('sidebar-group-toggle-gezels'));
    expect(await screen.findByRole('button', { name: 'Actions for Maya' })).toBeInTheDocument();
  });

  it('shows a working indicator on an active gezel and opens that gezel from it', async () => {
    window.localStorage.setItem('gezel:nav:groups', JSON.stringify({ gezels: true }));
    const onSelect = vi.fn();
    const preferWorking = vi.fn();
    window.addEventListener('gezel:prefer-working-project', preferWorking);
    render(
      <Sidebar
        selection={null}
        onSelect={onSelect}
        onOpenArea={vi.fn()}
        activeGezelIds={new Set(['g1'])}
      />,
    );

    const working = await screen.findByRole('button', {
      name: 'Maya is working. Open gezel.',
    });
    expect(working.querySelectorAll('.project-row-thinking-dot')).toHaveLength(3);

    fireEvent.click(working);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gezel', id: 'g1' }));
    expect(preferWorking).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { gezelId: 'g1' } }),
    );
    window.removeEventListener('gezel:prefer-working-project', preferWorking);
  });

  it('labels Home with the configured Meester name', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'g1',
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-meester')).toHaveTextContent('Home · Maya'),
    );
  });

  it('updates the Home label when the configured Meester changes', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'g1',
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [...GEZELS, { id: 'g2', name: 'Sofiya', role: 'Meester' } as GezelSummary],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-meester')).toHaveTextContent('Home · Maya'),
    );

    fireEvent(
      window,
      new CustomEvent('gezel:config-updated', {
        detail: { provider: 'mock', meesterGezelId: 'g2' },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-meester')).toHaveTextContent('Home · Sofiya'),
    );
  });

  it('labels the home tab "Get started" during first run (on-device provider, no model yet)', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'llama-cpp' } as never);
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({ models: [] } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-meester')).toHaveTextContent('Get started'),
    );
  });

  it('labels the home tab "Home" once an on-device model is installed', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'llama-cpp' } as never);
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [{ name: 'qwen3.6-27b-q4' }],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('sidebar-meester')).toHaveTextContent('Home'));
  });

  it('hides the Scripts area link unless advanced features are on', async () => {
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    // Config (showAdvancedFeatures unset) resolves async; wait for the
    // sidebar to settle, then confirm Scripts is absent.
    await screen.findByTestId('sidebar-area-tasks');
    expect(screen.queryByTestId('sidebar-area-scripts')).not.toBeInTheDocument();
  });

  it('shows the Scripts area link when advanced features are on', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      showAdvancedFeatures: true,
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    expect(await screen.findByTestId('sidebar-area-scripts')).toBeInTheDocument();
  });

  it('hides the built-in "Default" project from the list', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'default', name: 'Default' } as Project, ...PROJECTS],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    // User-created projects still show…
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    // …but the built-in scratchpad does not.
    expect(screen.queryByText('Default')).not.toBeInTheDocument();
  });

  it('shows the empty state when only the Default project exists', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'default', name: 'Default' } as Project],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
  });

  it('keeps the current Default project visible and selected after restore', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'default', name: 'Default' } as Project],
    } as never);
    const selection: RecentTab = { kind: 'project', id: 'default', at: 0, order: 0 };
    render(<Sidebar selection={selection} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    const currentProject = await screen.findByRole('button', { name: 'Default' });
    expect(currentProject).toHaveClass('active');
    expect(currentProject).toHaveAttribute('aria-current', 'page');
    expect(currentProject.closest('li')).toHaveClass('app-sidebar-proj-row', 'active');
    expect(screen.queryByText('No projects yet.')).not.toBeInTheDocument();
  });

  /**
   * Scripts is hidden unless "show advanced features" is on, but the Home
   * "Save a routine" tip navigates there regardless. The rail derives its
   * active row by matching the selection against the rendered roster, so a
   * hidden destination matched nothing and the rail showed no active row at
   * all — silently disagreeing with the canvas.
   */
  it('surfaces a hidden area as a transient row while it is the destination', async () => {
    const selection: RecentTab = { kind: 'area', area: 'scripts', at: 0, order: 0 };
    render(<Sidebar selection={selection} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    const row = await screen.findByRole('button', { name: 'Scripts' });
    expect(row).toHaveClass('active');
  });

  it('does not add a transient row for an area that already has a group header', async () => {
    const selection: RecentTab = { kind: 'area', area: 'documents', at: 0, order: 0 };
    render(<Sidebar selection={selection} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    // The group header is the destination indicator; a transient plain link
    // would render a second control with the same name.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Documents$/i })).toHaveLength(1);
    });
  });

  it('hides archived projects from the primary navigation list', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'p1', name: 'Alpha' } as Project,
        { id: 'p2', name: 'Buried', archived: true, status: 'inactive' } as Project,
      ],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Buried')).not.toBeInTheDocument();
  });

  it('hides the current project from primary navigation once it is archived', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'p1', name: 'Alpha' } as Project,
        { id: 'p2', name: 'Buried', archived: true, status: 'inactive' } as Project,
      ],
    } as never);
    const selection: RecentTab = { kind: 'project', id: 'p2', at: 0, order: 0 };
    render(<Sidebar selection={selection} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Buried')).not.toBeInTheDocument();
  });

  it('lists projects (group expanded by default) and selects one on click', async () => {
    const onSelect = vi.fn();
    render(<Sidebar selection={null} onSelect={onSelect} onOpenArea={vi.fn()} />);
    const alpha = await screen.findByText('Alpha');
    fireEvent.click(alpha);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'project', id: 'p1' }));
  });

  it('marks the selected entity active', async () => {
    const selection: RecentTab = { kind: 'project', id: 'p2', at: 0, order: 0 };
    render(<Sidebar selection={selection} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    const beta = await screen.findByText('Beta');
    expect(beta.closest('button')?.className).toContain('active');
    expect(beta.closest('button')).toHaveAttribute('aria-current', 'page');
    expect(beta.closest('li')).toHaveClass('app-sidebar-proj-row', 'active');
  });

  it('shows the per-project signal by precedence: intervene > poisoned > thinking > status', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'p1', name: 'Alpha' } as Project,
        { id: 'p2', name: 'Beta' } as Project,
        { id: 'p3', name: 'Gamma', status: 'stable' } as Project,
        { id: 'p4', name: 'Delta' } as Project,
      ],
    } as never);
    render(
      <Sidebar
        selection={null}
        onSelect={vi.fn()}
        onOpenArea={vi.fn()}
        activeProjectIds={new Set(['p1', 'p2', 'p4'])}
        pendingByProject={new Map([['p1', 2]])}
        poisonedProjects={
          new Map([
            ['p1', { sessionId: 's1', gezelId: 'g1', error: 'boom' }],
            ['p4', { sessionId: 's4', gezelId: 'g1', error: 'context overflow' }],
          ])
        }
      />,
    );
    await screen.findByText('Alpha');
    const alphaActions = screen.getByRole('button', { name: 'Actions for Alpha' });
    expect(alphaActions.nextElementSibling).toHaveClass('app-sidebar-proj-signal');
    // p1 is pending + poisoned + active → intervene (pending) wins.
    expect(
      screen.getByRole('button', { name: /Resolve 2 pending questions in Alpha/ }),
    ).toBeInTheDocument();
    // p4 is poisoned + active → poisoned beats working.
    expect(
      screen.getByRole('button', { name: /Delta: last turn failed — go to it in the chat/ }),
    ).toBeInTheDocument();
    // p2 is only working → animated thinking indicator.
    expect(screen.getByRole('button', { name: /Beta: a gezel is working/ })).toBeInTheDocument();
    // p3 is idle with a non-default status → the status dot.
    const gammaRow = screen.getByText('Gamma').closest('li');
    const stableStatus = gammaRow?.querySelector('.project-row-status-stable');
    expect(stableStatus).toHaveAttribute(
      'aria-label',
      'Gamma: Stable — work is at rest because its tasks are finished or canceled; new or resumed tasks reactivate it.',
    );
    expect(stableStatus).toHaveAttribute('type', 'button');
  });

  it.each([
    ['active', 'Active — automatic project work can run, including scheduled tasks and handoffs.'],
    ['readonly', 'Read-only — automatic project work is paused for review; chat still works.'],
    [
      'inactive',
      'Inactive — automatic project work is paused; chat still works. Archived projects are hidden from this list.',
    ],
  ] as const)('explains the %s project status', async (status, description) => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'p1', name: 'Alpha', status } as Project],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    expect(
      await screen.findByRole('button', { name: `Alpha: ${description}` }),
    ).toBeInTheDocument();
  });

  it('opens the resolution dialog when the intervene button is clicked', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'p1', name: 'Alpha' } as Project],
    } as never);
    vi.mocked(api.listQuestions).mockResolvedValue({ questions: [] } as never);
    render(
      <Sidebar
        selection={null}
        onSelect={vi.fn()}
        onOpenArea={vi.fn()}
        pendingByProject={new Map([['p1', 1]])}
      />,
    );
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByRole('button', { name: /Resolve 1 pending question in Alpha/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('jumps to the failed turn when the error indicator is clicked', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'p1', name: 'Alpha' } as Project],
    } as never);
    const onSelect = vi.fn();
    const onOpenProject = vi.fn();
    const onFocusError = vi.fn();
    window.addEventListener('gezel:open-project', onOpenProject);
    window.addEventListener('gezel:focus-session-error', onFocusError);
    render(
      <Sidebar
        selection={null}
        onSelect={onSelect}
        onOpenArea={vi.fn()}
        poisonedProjects={new Map([['p1', { sessionId: 's1', gezelId: 'g1', error: 'boom' }]])}
      />,
    );
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: /Alpha: last turn failed/ }));

    // Selects the project, flips it to the Chat tab, and points the
    // timeline at the session whose turn failed.
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'project', id: 'p1' }));
    expect(onOpenProject).toHaveBeenCalled();
    const focus = onFocusError.mock.calls[0]?.[0] as CustomEvent<{
      projectId: string;
      sessionId: string;
    }>;
    expect(focus.detail).toEqual({ projectId: 'p1', sessionId: 's1' });
    // The queued intent covers the case where the project's timeline
    // isn't mounted yet to hear that event.
    expect(consumeFocusSessionError('p1')).toEqual({ projectId: 'p1', sessionId: 's1' });

    window.removeEventListener('gezel:open-project', onOpenProject);
    window.removeEventListener('gezel:focus-session-error', onFocusError);
  });

  it('offers "Clear error indicator" only for a project carrying a failed turn', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'p1', name: 'Alpha' } as Project, { id: 'p2', name: 'Beta' } as Project],
    } as never);
    render(
      <Sidebar
        selection={null}
        onSelect={vi.fn()}
        onOpenArea={vi.fn()}
        poisonedProjects={new Map([['p1', { sessionId: 's1', gezelId: 'g1', error: 'boom' }]])}
      />,
    );
    await screen.findByText('Alpha');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Alpha' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      await screen.findByRole('menuitem', { name: 'Clear error indicator' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: 'Clear error indicator' })).toBeNull(),
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Beta' }), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByRole('menuitem', { name: 'Delete project…' });
    expect(screen.queryByRole('menuitem', { name: 'Clear error indicator' })).toBeNull();
  });

  it('opens an area via the top-level link', async () => {
    const onOpenArea = vi.fn();
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={onOpenArea} />);
    fireEvent.click(screen.getByTestId('sidebar-area-settings'));
    expect(onOpenArea).toHaveBeenCalledWith('settings');
  });

  it('toggles a group via the caret and persists the expanded state', async () => {
    const onOpenArea = vi.fn();
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={onOpenArea} />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByTestId('sidebar-group-toggle-projects'));
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    const stored = JSON.parse(window.localStorage.getItem('gezel:nav:groups') ?? '{}');
    expect(stored.projects).toBe(false);
    // The caret only toggles — it must not navigate to the area screen.
    expect(onOpenArea).not.toHaveBeenCalled();
  });

  it('opens the area screen when the group title is clicked (no toggle)', async () => {
    const onOpenArea = vi.fn();
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={onOpenArea} />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByTestId('sidebar-group-projects'));
    expect(onOpenArea).toHaveBeenCalledWith('projects');
    // Clicking the title opens the screen; it must not collapse the list.
    expect(screen.queryByText('Alpha')).toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem('gezel:nav:groups') ?? '{}');
    expect(stored.projects).not.toBe(false);
  });

  it('opens the area screen from the collapsed icon rail (no expand-only toggle)', async () => {
    window.localStorage.setItem('gezel:nav:sidebar-collapsed', '1');
    const onOpenArea = vi.fn();
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={onOpenArea} />);
    fireEvent.click(screen.getByTestId('sidebar-group-projects'));
    // Collapsed icon navigates like the expanded title rather than just
    // expanding the rail + inline list.
    expect(onOpenArea).toHaveBeenCalledWith('projects');
    const stored = JSON.parse(window.localStorage.getItem('gezel:nav:groups') ?? '{}');
    expect(stored.projects).not.toBe(true);
  });

  it('fires the create event when the "+" is clicked', async () => {
    const onOpenArea = vi.fn();
    const handler = vi.fn();
    window.addEventListener('gezel:new-project', handler);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={onOpenArea} />);
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByLabelText('New project'));
    expect(onOpenArea).toHaveBeenCalledWith('projects');
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('gezel:new-project', handler);
  });

  it('document "+" opens a dialog in place (no navigation) and selects the created doc', async () => {
    const onSelect = vi.fn();
    const onOpenArea = vi.fn();
    const created = vi.fn();
    window.addEventListener('gezel:document-created', created);
    vi.mocked(api.writeDocument).mockResolvedValue({ ok: true } as never);
    render(<Sidebar selection={null} onSelect={onSelect} onOpenArea={onOpenArea} />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByLabelText('New document'));
    // The "+" must NOT navigate to the full Documents pane.
    expect(onOpenArea).not.toHaveBeenCalled();

    const pathInput = await screen.findByPlaceholderText('e.g. guidelines/coding');
    expect(screen.getByText('.md')).toBeInTheDocument();
    fireEvent.change(pathInput, { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(api.writeDocument).toHaveBeenCalledWith('notes.md', '');
    });
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'document', path: 'notes.md' }),
      );
    });
    expect(created).toHaveBeenCalled();
    window.removeEventListener('gezel:document-created', created);
  });

  it('renames a document from the sidebar row menu and broadcasts the new path', async () => {
    window.localStorage.setItem('gezel:nav:groups', JSON.stringify({ documents: true }));
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [{ name: 'notes.md', path: 'notes.md', isDirectory: false }],
    } as never);
    vi.mocked(api.renameDocument).mockResolvedValue({ ok: true } as never);
    const renamed = vi.fn();
    window.addEventListener('gezel:document-renamed', renamed);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rename notes.md' }));
    const nameInput = await screen.findByPlaceholderText('New name');
    fireEvent.change(nameInput, { target: { value: 'meeting-notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(api.renameDocument).toHaveBeenCalledWith('notes.md', 'meeting-notes.md');
    });
    expect(renamed).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ fromPath: 'notes.md', toPath: 'meeting-notes.md' }),
      }),
    );
    window.removeEventListener('gezel:document-renamed', renamed);
  });

  it('confirms before deleting a document from the sidebar row menu', async () => {
    window.localStorage.setItem('gezel:nav:groups', JSON.stringify({ documents: true }));
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [{ name: 'notes.md', path: 'notes.md', isDirectory: false }],
    } as never);
    vi.mocked(api.deleteDocument).mockResolvedValue({ ok: true } as never);
    const deleted = vi.fn();
    window.addEventListener('gezel:document-deleted', deleted);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete notes.md' }));
    expect(await screen.findByText('Delete document?')).toBeInTheDocument();
    expect(api.deleteDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith('notes.md'));
    expect(deleted).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ path: 'notes.md' }) }),
    );
    window.removeEventListener('gezel:document-deleted', deleted);
  });

  it('folds in a new project live on the gezel:project-created event (e.g. a start_project macro)', async () => {
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    await screen.findByText('Alpha');
    // A project created elsewhere — the dialog, or a gezel running
    // start_project mid-chat — isn't in the list yet.
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();

    // Next refresh returns the new project; App's global SSE bridge
    // fires the window event the sidebar listens to.
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [...PROJECTS, { id: 'p3', name: 'Gamma' } as Project],
    } as never);
    fireEvent(
      window,
      new CustomEvent('gezel:project-created', { detail: { id: 'p3', name: 'Gamma' } }),
    );

    expect(await screen.findByText('Gamma')).toBeInTheDocument();
  });

  it('folds in a newly created gezel when the roster-change signal fires', async () => {
    window.localStorage.setItem('gezel:nav:groups', JSON.stringify({ gezels: true }));
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    await screen.findByText('Maya');
    expect(screen.queryByText('Sofiya')).not.toBeInTheDocument();

    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [...GEZELS, { id: 'g2', name: 'Sofiya', role: 'Language Trainer' } as GezelSummary],
    } as never);
    fireEvent(window, new CustomEvent('gezel:gezel-updated'));

    expect(await screen.findByText('Sofiya')).toBeInTheDocument();
    expect(screen.getByText('Language Trainer')).toBeInTheDocument();
  });

  it('collapses to icon-only mode (group children removed from the DOM)', async () => {
    window.localStorage.setItem('gezel:nav:sidebar-collapsed', '1');
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    // Top-level entries still render; group items do not.
    expect(screen.getByTestId('app-sidebar').className).toContain('collapsed');
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled());
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('grows the default right sidebar when its grip is dragged left', () => {
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    const grip = screen.getByRole('separator', { name: 'Resize sidebar' });

    fireEvent.mouseDown(grip, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 460 });
    fireEvent.mouseUp(window);

    expect(screen.getByTestId('app-sidebar')).toHaveStyle({ width: '280px' });
    expect(window.localStorage.getItem('gezel:nav:sidebar-width')).toBe('280');
  });

  it('grows a left sidebar when its grip is dragged right', () => {
    window.localStorage.setItem('gezel:sidebar-side', 'left');
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    const grip = screen.getByRole('separator', { name: 'Resize sidebar' });

    fireEvent.mouseDown(grip, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 540 });
    fireEvent.mouseUp(window);

    expect(screen.getByTestId('app-sidebar')).toHaveStyle({ width: '280px' });
    expect(window.localStorage.getItem('gezel:nav:sidebar-width')).toBe('280');
  });

  it('shows the Dutch role description as the subtitle in boring mode', async () => {
    // Gezels group is collapsed by default — expand it so the rows render.
    window.localStorage.setItem('gezel:nav:groups', JSON.stringify({ gezels: true }));
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      roleBasedNameOnlyMode: true,
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'g1', name: 'Maya', role: 'Klerk', roleBasedName: 'klerk' } as GezelSummary],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    // The label is the role-based name…
    expect(await screen.findByText('klerk')).toBeInTheDocument();
    // …and the subtitle is the plain-language description, not the role word.
    expect(await screen.findByText('Writing and editing')).toBeInTheDocument();
  });

  it('puts the role description in the tooltip when regular names are used', async () => {
    window.localStorage.setItem('gezel:nav:groups', JSON.stringify({ gezels: true }));
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'g1', name: 'Maya', role: 'Voorman', roleBasedName: 'voorman' } as GezelSummary,
      ],
    } as never);
    render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
    const label = await screen.findByText('Maya');
    expect(label.closest('button')?.getAttribute('title')).toBe(
      'Maya — Voorman · Manages projects',
    );
  });

  // Install-health notices moved off the Home screen into the rail. They are
  // the quietest thing here: one muted line under Settings that opens the
  // page explaining it.
  describe('install-health notices', () => {
    function setShell(fields: Record<string, unknown>) {
      const g = window as unknown as { __GEZEL__: Record<string, unknown> };
      g.__GEZEL__ = { ...g.__GEZEL__, ...fields };
    }

    function updateBridge(initial: unknown) {
      let listener: ((state: unknown) => void) | null = null;
      return {
        state: vi.fn().mockResolvedValue(initial),
        install: vi.fn().mockResolvedValue({ ok: true }),
        onStateChanged: vi.fn((callback: (state: unknown) => void) => {
          listener = callback;
        }),
        emit(state: unknown) {
          listener?.(state);
        },
      };
    }

    beforeEach(() => {
      setShell({ fallbackReason: null, fallbackCode: null, update: undefined });
      resetUpdateStateForTests();
    });

    it('stays out of the rail on a healthy launch', () => {
      render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);
      expect(screen.queryByTestId('sidebar-notice-service-unavailable')).not.toBeInTheDocument();
    });

    it('shows one quiet line when the background service did not start', () => {
      setShell({
        fallbackReason: 'System service was unavailable: SCM stopped',
        fallbackCode: 'system-service-unhealthy',
      });
      render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

      const notice = screen.getByTestId('sidebar-notice-service-unavailable');
      expect(notice).toHaveTextContent('Background work is off');
      expect(notice.getAttribute('title')).toMatch(/will not start again by itself/);
    });

    it('shows live download progress and the install-on-quit handoff in the rail', async () => {
      const update = updateBridge({
        kind: 'downloading',
        version: '1.26224.48',
        percent: 37,
      });
      setShell({ platform: 'win32', update });
      render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={vi.fn()} />);

      const progress = await screen.findByTestId('sidebar-notice-update-downloading');
      expect(progress).toHaveTextContent('Downloading update · 37%');
      expect(progress).toHaveAttribute('data-tone', 'progress');

      update.emit({ kind: 'ready', version: '1.26224.48' });
      const ready = await screen.findByTestId('sidebar-notice-update-ready');
      expect(ready).toHaveTextContent('Update ready — quit to install');
      expect(ready.getAttribute('title')).toMatch(/system tray/i);
      expect(ready).toHaveAttribute('data-tone', 'success');
    });

    it('opens Settings → About when clicked', () => {
      setShell({ fallbackReason: 'down', fallbackCode: 'system-service-unhealthy' });
      const onOpenArea = vi.fn();
      const navigated: unknown[] = [];
      const onNav = (e: Event) => navigated.push((e as CustomEvent).detail);
      window.addEventListener('gezel:navigate', onNav);

      render(<Sidebar selection={null} onSelect={vi.fn()} onOpenArea={onOpenArea} />);
      fireEvent.click(screen.getByTestId('sidebar-notice-service-unavailable'));
      window.removeEventListener('gezel:navigate', onNav);

      expect(onOpenArea).toHaveBeenCalledWith('settings');
      expect(navigated).toContainEqual({ view: 'settings', section: 'about' });
    });
  });
});
