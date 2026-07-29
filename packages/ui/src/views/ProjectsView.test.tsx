import type { Project } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    initialMarkdown,
    onChange,
  }: {
    initialMarkdown?: string;
    onChange?: (source: string) => void;
  }) => (
    <div data-testid="editor" data-initial={initialMarkdown}>
      {onChange && (
        <button type="button" data-testid="editor-emit" onClick={() => onChange('edited content')}>
          edit
        </button>
      )}
    </div>
  ),
  JsonEditor: ({
    onChange,
  }: {
    onChange: (next: Record<string, unknown>) => void;
  }) => (
    <div data-testid="json-editor">
      <button type="button" onClick={() => onChange({ language: 'French' })}>
        Use French
      </button>
      <button type="button" onClick={() => onChange({ language: 'Japanese' })}>
        Use Japanese
      </button>
    </div>
  ),
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

// Same Export-stack stub as in DocumentDetail.test — keeps jsdom from
// loading the real format converters + standalone player bundle.
vi.mock('../components/DocumentExport/index.js', () => ({
  ExportToolbarControls: () => null,
}));
vi.mock('../components/SquisqIntegration/index.js', () => ({
  createDocumentsContentContainer: () => ({}),
  createArtifactsContentContainer: () => ({}),
  createDocumentLinkProvider: () => async () => [],
  deriveContainerScope: (p: string) => ({
    root: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '',
    primaryDocumentFilename: p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p,
  }),
}));

// ProjectsView's many heavy children — mock them out to focused stand-ins.
vi.mock('../components/AiToolbarButtons.js', () => ({ AiToolbarButtons: () => null }));
vi.mock('../components/CatalogBrowser.js', () => ({
  CatalogBrowser: () => <div data-testid="catalog-browser" />,
}));
vi.mock('../components/ConfirmDialog.js', () => ({ ConfirmDialog: () => null }));
vi.mock('../components/FileTree.js', () => ({ FileTree: () => null }));
vi.mock('../components/HtmlPreviewFrame.js', () => ({ HtmlPreviewFrame: () => null }));
vi.mock('../components/ProjectChat.js', () => ({
  ProjectChat: ({ compact }: { compact?: boolean }) => (
    <div data-testid="project-chat" data-compact={compact ? 'true' : 'false'}>
      project-chat
    </div>
  ),
}));
vi.mock('../components/ProjectTimeline.js', () => ({ ProjectTimeline: () => null }));
vi.mock('../components/PromoteToTabButton.js', () => ({ PromoteToTabButton: () => null }));
vi.mock('../components/PromptDialog.js', () => ({ PromptDialog: () => null }));
vi.mock('../components/ToolsetsEditor.js', () => ({
  ToolsetsEditor: () => <div data-testid="toolsets-editor" />,
}));
vi.mock('./HistoryView.js', () => ({ HistoryView: () => null }));
vi.mock('./ProjectGithubView.js', () => ({ ProjectGitHubView: () => null }));
vi.mock('./ScriptsView.js', () => ({ ScriptsView: () => null }));
vi.mock('./TasksView.js', () => ({ TasksView: () => null }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

const { ProjectsView } = await import('./ProjectsView.js');
const { api } = await import('../api.js');

const PROJECTS: Project[] = [
  { id: 'pj-alpha', name: 'Alpha' } as Project,
  { id: 'default', name: 'default' } as Project,
];

describe('ProjectsView', () => {
  beforeEach(() => {
    window.localStorage.removeItem('gezel.projectsSidebarCollapsed');
    window.localStorage.removeItem('gezel:project-output-fraction');
    window.localStorage.removeItem('gezel:project-output-fraction:v2');
    vi.mocked(api.listProjects).mockResolvedValue({ projects: PROJECTS } as never);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] } as never);
    vi.mocked(api.getProject).mockImplementation(
      async (id) =>
        ({
          id,
          name: id === 'pj-alpha' ? 'Alpha' : 'default',
          packages: [],
          allowGezelWrites: false,
        }) as never,
    );
    vi.mocked(api.listProjectWorkspace).mockResolvedValue({ files: [] } as never);
    vi.mocked(api.listProjectArtifacts).mockResolvedValue({ files: [] } as never);
  });

  it('lists projects on mount', async () => {
    render(<ProjectsView />);
    await waitFor(() => {
      expect(api.listProjects).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveClass('project-rail-name');
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('title', 'Alpha');
  });

  it('shows labeled creation keys when the project list is collapsed', async () => {
    render(<ProjectsView />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse project list' }));

    expect(screen.getByRole('button', { name: 'New Project' })).toHaveTextContent('+Project');
    expect(screen.getByRole('button', { name: 'New Job' })).toHaveTextContent('+Job');
    expect(screen.getByRole('button', { name: 'Expand project list' })).toBeInTheDocument();
  });

  it('also loads the gezels list (used for assignee pickers)', async () => {
    render(<ProjectsView />);
    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalled();
    });
  });

  it('with forceProjectId, loads that project directly via getProject', async () => {
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await waitFor(() => {
      expect(api.getProject).toHaveBeenCalledWith('pj-alpha');
    });
    // Project chat surface (mocked) should appear once the detail loads.
    await waitFor(() => {
      expect(screen.getByTestId('project-chat')).toBeInTheDocument();
    });
  });

  it('does not apply the collapsed project-list grid to a detail-only project tab', async () => {
    window.localStorage.setItem('gezel.projectsSidebarCollapsed', '1');

    render(<ProjectsView forceProjectId="pj-alpha" />);

    const projectChat = await screen.findByTestId('project-chat');
    const layout = projectChat.closest('.two-col');
    expect(layout).toHaveClass('detail-only');
    expect(layout).not.toHaveClass('sidebar-collapsed');
  });

  it('uses the bounded HTML-page search when opening a project', async () => {
    vi.mocked(api.listProjectWorkspaceHtmlPages).mockResolvedValue({
      files: [{ name: 'index.html', path: 'site/index.html', isDirectory: false }],
    });

    render(<ProjectsView forceProjectId="pj-alpha" />);

    await waitFor(() => {
      expect(api.listProjectWorkspaceHtmlPages).toHaveBeenCalledWith('pj-alpha');
    });
    expect(api.listProjectWorkspace).not.toHaveBeenCalled();
  });

  it('resizes the output pane with a valid percentage grid track', async () => {
    vi.mocked(api.listProjectWorkspaceHtmlPages).mockResolvedValue({
      files: [{ name: 'index.html', path: 'index.html', isDirectory: false }],
    });

    render(<ProjectsView forceProjectId="pj-alpha" />);

    const separator = await screen.findByRole('separator', { name: 'Resize output pane' });
    const projectBody = separator.closest('.project-body') as HTMLDivElement;
    Object.defineProperty(projectBody, 'clientWidth', { configurable: true, value: 1_000 });

    expect(projectBody.style.getPropertyValue('--project-output-width')).toBe('42.00%');

    fireEvent.mouseDown(separator, { clientX: 420 });
    fireEvent.mouseMove(window, { clientX: 520 });

    expect(projectBody.style.getPropertyValue('--project-output-width')).toBe('52.00%');
    expect(window.localStorage.getItem('gezel:project-output-fraction:v2')).toBe('0.5200');

    fireEvent.mouseUp(window);
  });

  it('indexes every section of the project About page', async () => {
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const toc = await screen.findByRole('navigation', { name: 'About sections' });
    const links = within(toc).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'About this project',
      'Mission objectives',
      'Connections',
      'History',
      'Toolsets',
      'Settings',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#project-about-overview',
      '#project-about-mission',
      '#project-about-connections',
      '#project-about-history',
      '#project-about-toolsets',
      '#project-about-settings',
    ]);
  });

  it('keeps a failed project-document edit dirty and retries it', async () => {
    const project = {
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      allowGezelWrites: false,
      about: 'Original about',
      missionObjectives: 'Original mission',
    };
    vi.mocked(api.getProject).mockResolvedValue(project as never);
    vi.mocked(api.updateProject)
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue({ ...project, about: 'edited content' } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const editors = await screen.findAllByTestId('editor-emit');
    fireEvent.click(editors[0]!);
    const failedChip = await screen.findByText('Save failed', {}, { timeout: 1800 });
    expect(failedChip).toHaveAttribute('title', 'write failed');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(2));
    expect(api.updateProject).toHaveBeenLastCalledWith('pj-alpha', { about: 'edited content' });
  });

  it('restores a failed project-document draft when the project view is reopened', async () => {
    const project = {
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      allowGezelWrites: false,
      about: 'Original about',
      missionObjectives: 'Original mission',
    };
    vi.mocked(api.getProject).mockResolvedValue(project as never);
    vi.mocked(api.updateProject).mockRejectedValue(new Error('still offline'));

    const firstView = render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    const firstEditors = await screen.findAllByTestId('editor-emit');
    fireEvent.click(firstEditors[0]!);
    const offlineChip = await screen.findByText('Save failed', {}, { timeout: 1800 });
    expect(offlineChip).toHaveAttribute('title', 'still offline');
    firstView.unmount();
    expect(api.updateProject).toHaveBeenCalledTimes(1);

    vi.mocked(api.updateProject).mockResolvedValue({
      ...project,
      about: 'edited content',
    } as never);
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    const restoredEditors = await screen.findAllByTestId('editor');
    expect(restoredEditors[0]).toHaveAttribute('data-initial', 'edited content');
    expect(screen.getByText('Save failed')).toHaveAttribute('title', 'still offline');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledTimes(2));
    expect(api.updateProject).toHaveBeenLastCalledWith('pj-alpha', { about: 'edited content' });
  });

  it('exempts a project from Meester check-ins without discarding cadence overrides', async () => {
    const project = {
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      allowGezelWrites: false,
      nudgeConfig: {
        enabled: false,
        slowIntervalMs: 21_600_000,
      },
    };
    vi.mocked(api.getProject).mockResolvedValue(project as never);
    vi.mocked(api.updateProject).mockResolvedValue({
      ...project,
      nudgeConfig: {
        ...project.nudgeConfig,
        enabled: true,
      },
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Exclude from Meester progress check-ins',
    });
    expect(checkbox).toBeChecked();
    expect(
      screen.getByText(/direct chats and the project’s own work continue/i),
    ).toBeInTheDocument();

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', {
        nudgeConfig: {
          enabled: true,
          slowIntervalMs: 21_600_000,
        },
      });
    });
    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: 'Exclude from Meester progress check-ins' }),
      ).not.toBeChecked();
    });
  });

  it('hides optional project tabs and lets Settings turn them back on', async () => {
    const focusedProject = {
      id: 'pj-alpha',
      name: 'Checkers',
      packages: [],
      allowGezelWrites: false,
      tabVisibility: {
        overview: false,
        tasks: false,
        approvals: false,
        workspace: false,
        artifacts: false,
        map: false,
      },
    };
    vi.mocked(api.getProject).mockResolvedValue(focusedProject as never);
    vi.mocked(api.updateProject).mockImplementation(
      async (_id, patch) => ({ ...focusedProject, tabVisibility: patch.tabVisibility }) as never,
    );

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');

    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    for (const name of ['Overview', 'Tasks', 'Approvals', 'Workspace', 'Artifacts', 'Village']) {
      expect(screen.queryByRole('tab', { name })).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByText(/Chat and Settings always stay available/i)).toBeInTheDocument();
    const tasksToggle = screen.getByRole('checkbox', { name: 'Tasks' });
    expect(tasksToggle).not.toBeChecked();
    fireEvent.click(tasksToggle);

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', {
        tabVisibility: {
          overview: false,
          tasks: true,
          approvals: false,
          workspace: false,
          artifacts: false,
          map: false,
        },
      });
    });
    expect(await screen.findByRole('tab', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('lets an explicit Map flag override the project-type-aware default', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Writing',
      packages: [],
      allowGezelWrites: false,
      projectTypeId: 'content-writing',
      tabVisibility: { map: true },
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');

    expect(screen.getByRole('tab', { name: 'Village' })).toBeInTheDocument();
  });

  it('shows an error message when listProjects rejects', async () => {
    vi.mocked(api.listProjects).mockRejectedValue(new Error('service down'));
    render(<ProjectsView />);
    await waitFor(() => {
      expect(screen.getByText(/service down/)).toBeInTheDocument();
    });
  });

  it('shows built-in and purpose-built project types in one searchable gallery', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        {
          sourceId: 'bundled',
          kind: 'project-type',
          manifest: {
            schemaVersion: 1,
            kind: 'project-type',
            id: 'design-scheme',
            name: 'Design Scheme',
            description: 'Explore color schemes and palettes with a designer.',
            tags: ['design', 'palette'],
            maintainer: { name: 'Gezel' },
            license: 'MIT',
            yankedVersions: [],
          },
        },
      ],
    } as never);

    render(<ProjectsView />);
    fireEvent.click(screen.getByRole('button', { name: '+ New Project' }));

    const gallery = await screen.findByRole('radiogroup', { name: 'Project type' });
    expect(within(gallery).getByRole('radio', { name: 'General' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const designType = await within(gallery).findByRole('radio', { name: 'Design Scheme' });
    expect(designType).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project types' }), {
      target: { value: 'palette' },
    });
    expect(within(gallery).queryByRole('radio', { name: 'General' })).not.toBeInTheDocument();
    expect(within(gallery).getByRole('radio', { name: 'Design Scheme' })).toBeInTheDocument();

    fireEvent.click(designType);
    expect(designType).toHaveAttribute('aria-checked', 'true');
  });

  it('filters the gallery by category from the rail', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        {
          sourceId: 'bundled',
          kind: 'project-type',
          manifest: {
            schemaVersion: 1,
            kind: 'project-type',
            id: 'language-trainer',
            name: 'Language Trainer',
            description: 'Practice a new language with a patient tutor.',
            tags: ['language', 'learning'],
            category: 'growth',
            maintainer: { name: 'Gezel' },
          },
        },
      ],
    } as never);

    render(<ProjectsView />);
    fireEvent.click(screen.getByRole('button', { name: '+ New Project' }));

    const gallery = await screen.findByRole('radiogroup', { name: 'Project type' });
    await within(gallery).findByRole('radio', { name: 'Language Trainer' });

    fireEvent.click(screen.getByRole('button', { name: /Personal Growth/ }));
    expect(within(gallery).queryByRole('radio', { name: 'General' })).not.toBeInTheDocument();
    expect(within(gallery).getByRole('radio', { name: 'Language Trainer' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(within(gallery).getByRole('radio', { name: 'General' })).toBeInTheDocument();
  });

  it('suggests a project name from type params without overwriting a user edit', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        {
          sourceId: 'bundled',
          kind: 'project-type',
          manifest: {
            schemaVersion: 1,
            kind: 'project-type',
            id: 'language-trainer',
            name: 'Language Trainer',
            description: 'Practice a new language with a patient tutor.',
            tags: ['language', 'learning'],
            maintainer: { name: 'Gezel' },
            version: '1.0.0',
            releasedAt: '2026-07-06T00:00:00Z',
            params: {
              type: 'object',
              properties: { language: { type: 'string', default: 'Spanish' } },
            },
            nameTemplate: '{{language}} Language Trainer',
          },
        },
      ],
    } as never);

    render(<ProjectsView />);
    fireEvent.click(screen.getByRole('button', { name: '+ New Project' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Language Trainer' }));

    const nameInput = screen.getByLabelText(/^Name/);
    expect(nameInput).toHaveValue('Spanish Language Trainer');
    expect(screen.getByText('Suggested from your choices — edit it anytime.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Use French' }));
    expect(nameInput).toHaveValue('French Language Trainer');

    fireEvent.change(nameInput, { target: { value: 'My conversation practice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use Japanese' }));
    expect(nameInput).toHaveValue('My conversation practice');
    expect(
      screen.queryByText('Suggested from your choices — edit it anytime.'),
    ).not.toBeInTheDocument();
  });

  it('refreshes the global gezel roster after a project type creates its crew', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        {
          sourceId: 'bundled',
          kind: 'project-type',
          manifest: {
            schemaVersion: 1,
            kind: 'project-type',
            id: 'language-trainer',
            name: 'Language Trainer',
            description: 'Practice a language with a patient tutor.',
            tags: ['language', 'tutor'],
            maintainer: { name: 'Gezel' },
            license: 'MIT',
            yankedVersions: [],
          },
        },
      ],
    } as never);
    vi.mocked(api.createTypedProject).mockResolvedValue({
      project: {
        id: 'pj-spanish',
        name: 'Spanish practice',
        packages: [],
        allowGezelWrites: false,
      },
      applied: {
        typeId: 'language-trainer',
        version: '1.0.0',
        source: 'bundled',
        gezelsCreated: [
          {
            id: 'gz-sofiya',
            name: 'Sofiya',
            templateId: 'language-trainer',
            voorman: true,
          },
        ],
        scriptsInstalled: [],
        workspaceSeeded: [],
        toolsetsInstalled: [],
        aboutRendered: true,
        missionRendered: true,
        deferred: { toolsets: [], craftbooks: [], tools: [], pages: true, schedules: 0 },
      },
    } as never);

    const rosterChanged = vi.fn();
    window.addEventListener('gezel:gezel-updated', rosterChanged);
    try {
      render(<ProjectsView />);
      fireEvent.click(screen.getByRole('button', { name: '+ New Project' }));
      fireEvent.click(await screen.findByRole('radio', { name: 'Language Trainer' }));
      fireEvent.change(screen.getByLabelText(/^Name/), {
        target: { value: 'Spanish practice' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        expect(api.createTypedProject).toHaveBeenCalledWith({
          name: 'Spanish practice',
          projectType: {
            typeId: 'language-trainer',
            params: {},
          },
        });
      });
      await waitFor(() => expect(rosterChanged).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener('gezel:gezel-updated', rosterChanged);
    }
  });

  describe('auto-compact (responsive)', () => {
    /**
     * Test seam: jsdom omits `ResizeObserver` and `clientWidth` defaults
     * to 0. Install a controllable RO that fires its callback the
     * moment a target is observed, AND a `clientWidth` shim that
     * returns whatever the test set. The hook reads `clientWidth`
     * synchronously on mount, so a single beforeEach plant covers
     * every assertion below.
     */
    let activeWidth = 0;
    const widthGetter = {
      configurable: true,
      get(): number {
        return activeWidth;
      },
    };

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthGetter);
      (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = class {
        constructor(private readonly cb: ResizeObserverCallback) {}
        observe(_target: Element): void {
          // Fire the initial callback after a microtask so React
          // commits the mount before the state update arrives.
          queueMicrotask(() => this.cb([], this as unknown as ResizeObserver));
        }
        unobserve(): void {}
        disconnect(): void {}
      } as unknown as typeof ResizeObserver;
    });

    it('passes compact=true to ProjectChat when the container is narrower than the threshold', async () => {
      activeWidth = 380; // VS Code sidebar / mobile portrait
      render(<ProjectsView forceProjectId="pj-alpha" />);
      const chat = await screen.findByTestId('project-chat');
      await waitFor(() => {
        expect(chat.getAttribute('data-compact')).toBe('true');
      });
    });

    it('passes compact=false at wide widths (desktop main column)', async () => {
      activeWidth = 1024;
      render(<ProjectsView forceProjectId="pj-alpha" />);
      const chat = await screen.findByTestId('project-chat');
      // The cold-mount initial state is `false`; we additionally
      // confirm the post-effect read at 1024 px keeps it `false`.
      expect(chat.getAttribute('data-compact')).toBe('false');
    });

    it('honors an explicit compact={true} prop even on a wide container (host override)', async () => {
      activeWidth = 1024;
      render(<ProjectsView forceProjectId="pj-alpha" compact />);
      const chat = await screen.findByTestId('project-chat');
      expect(chat.getAttribute('data-compact')).toBe('true');
    });
  });
});
