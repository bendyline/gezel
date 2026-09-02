import type { Project } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const chatComposerMocks = vi.hoisted(() => ({ queueComposerPrefill: vi.fn() }));
const documentContainerMocks = vi.hoisted(() => ({
  createArtifacts: vi.fn(() => ({})),
  createMedia: vi.fn(() => ({ dispose: vi.fn() })),
  createVersionCompatible: vi.fn((container: unknown) => container),
}));
vi.mock('../components/composer-prefill.js', () => ({
  queueComposerPrefill: chatComposerMocks.queueComposerPrefill,
}));

const editorMocks = vi.hoisted(() => ({
  setActiveView: vi.fn(),
  setSelection: vi.fn(),
  revealLineInCenter: vi.fn(),
  focus: vi.fn(),
  getLineCount: vi.fn(() => 20),
  getLineMaxColumn: vi.fn(() => 24),
}));

const trackedWorkspaceIssue = {
  id: 'issue-1',
  ref: 'BW-1',
  fingerprint: 'review-fingerprint',
  path: 'notes/audit.md',
  severity: 'minor' as const,
  category: 'clarity',
  message: 'The conclusion does not identify an owner.',
  line: 12,
  status: 'open' as const,
  seen: false,
  stale: false,
  createdAt: '2026-08-11T12:00:00.000Z',
  lastSeenAt: '2026-08-11T12:00:00.000Z',
};

vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    initialMarkdown,
    onChange,
    statusBarSlotRight,
    toolbarSlotRight,
  }: {
    initialMarkdown?: string;
    onChange?: (source: string) => void;
    statusBarSlotRight?: React.ReactNode;
    toolbarSlotRight?: React.ReactNode;
  }) => (
    <div data-testid="editor" data-initial={initialMarkdown}>
      <div data-testid="editor-toolbar-right">{toolbarSlotRight}</div>
      {onChange && (
        <button type="button" data-testid="editor-emit" onClick={() => onChange('edited content')}>
          edit
        </button>
      )}
      <div data-testid="editor-status-bar-right">{statusBarSlotRight}</div>
    </div>
  ),
  useEditorContext: () => ({
    activeView: 'raw',
    setActiveView: editorMocks.setActiveView,
    monacoEditor: {
      getModel: () => ({
        getLineCount: editorMocks.getLineCount,
        getLineMaxColumn: editorMocks.getLineMaxColumn,
      }),
      setSelection: editorMocks.setSelection,
      revealLineInCenter: editorMocks.revealLineInCenter,
      focus: editorMocks.focus,
    },
  }),
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
  createArtifactsContentContainer: documentContainerMocks.createArtifacts,
  createProjectContentContainer: () => ({}),
  createDocumentMediaProvider: documentContainerMocks.createMedia,
  createVersionCompatibleContentContainer: documentContainerMocks.createVersionCompatible,
  createDocumentLinkProvider: () => async () => [],
  chooseOutsideInSource: () => null,
  importOutsideInDocument: vi.fn(),
  isOutsideInMarkdownEditingEnabled: () => false,
  isOutsideInInternalPath: () => false,
  relativePath: (from: string, to: string) => `${from}:${to}`,
  renderOutsideInDocument: vi.fn(),
  resolveOutsideInLayout: () => null,
  runtimePathForTarget: () => '_squisq/squisq-player.js',
  withOutsideInMetadata: (source: string) => source,
  withOutsideInMarkdownEditing: (source: string) => source,
  deriveContainerScope: (p: string) => ({
    root: `${p.replace(/\.[^.]+$/, '')}_files`,
    parentDirectory: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '',
    companionName: `${p.replace(/^.*\//, '').replace(/\.[^.]+$/, '')}_files`,
    primaryDocumentFilename: p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p,
  }),
  documentVersionBasename: (p: string) =>
    (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p).replace(/\.[^.]+$/, ''),
}));

// ProjectsView's many heavy children — mock them out to focused stand-ins.
vi.mock('../components/transform/TransformToolbarButton.js', () => ({
  TransformToolbarButton: () => null,
}));
vi.mock('../components/DocumentNarration.js', () => ({
  DocumentNarration: () => null,
}));
vi.mock('../components/CatalogBrowser.js', () => ({
  CatalogBrowser: () => <div data-testid="catalog-browser" />,
}));
vi.mock('../components/ConfirmDialog.js', () => ({ ConfirmDialog: () => null }));
vi.mock('../components/FileTree.js', () => ({
  // FileFlatList (rendered unmocked) pulls its default icon from this
  // module; keep the export present so flat views render in these tests.
  defaultIconFor: () => null,
  FileTree: ({
    entries,
    onSelect,
    onRename,
    onDelete,
    trailingForEntry,
  }: {
    entries: Array<{ name: string; path: string; isDirectory: boolean }>;
    onSelect: (entry: { name: string; path: string; isDirectory: boolean }) => void;
    onRename?: (entry: { name: string; path: string; isDirectory: boolean }) => void;
    onDelete?: (entry: { name: string; path: string; isDirectory: boolean }) => void;
    trailingForEntry?: (entry: {
      name: string;
      path: string;
      isDirectory: boolean;
    }) => React.ReactNode;
  }) => (
    <div data-testid="file-tree">
      {entries.map((entry) => (
        <div key={entry.path}>
          <button type="button" onClick={() => onSelect(entry)}>
            {entry.name}
          </button>
          {onRename && (
            <button type="button" onClick={() => onRename(entry)}>
              rename {entry.name}
            </button>
          )}
          {onDelete && (
            <button type="button" onClick={() => onDelete(entry)}>
              delete {entry.name}
            </button>
          )}
          {trailingForEntry?.(entry)}
        </div>
      ))}
    </div>
  ),
}));
vi.mock('../components/HtmlPreviewFrame.js', () => ({ HtmlPreviewFrame: () => null }));
vi.mock('../components/ProjectChat.js', () => ({
  ProjectChat: ({ compact }: { compact?: boolean }) => (
    <div data-testid="project-chat" data-compact={compact ? 'true' : 'false'}>
      project-chat
    </div>
  ),
}));
vi.mock('../components/ProjectTimeline.js', () => ({ ProjectTimeline: () => null }));
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
    chatComposerMocks.queueComposerPrefill.mockClear();
    documentContainerMocks.createArtifacts.mockClear();
    documentContainerMocks.createMedia.mockClear();
    documentContainerMocks.createVersionCompatible.mockClear();
    editorMocks.setActiveView.mockClear();
    editorMocks.setSelection.mockClear();
    editorMocks.revealLineInCenter.mockClear();
    editorMocks.focus.mockClear();
    window.localStorage.removeItem('gezel.projectsSidebarCollapsed');
    window.localStorage.removeItem('gezel:project-output-fraction');
    window.localStorage.removeItem('gezel:project-output-fraction:v2');
    window.localStorage.removeItem('gezel.projectOutputVisible:pj-alpha');
    window.localStorage.removeItem('gezel.projectFilesView:pj-alpha:workspace');
    window.localStorage.removeItem('gezel.projectFilesView:pj-alpha:artifacts');
    window.localStorage.removeItem('gezel:project-file-tree-width:v1');
    window.localStorage.removeItem('gezel:project-file-tree-collapsed:v1');
    vi.mocked(api.listProjects).mockResolvedValue({ projects: PROJECTS } as never);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      showWorkInProgressFeatures: false,
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] } as never);
    vi.mocked(api.getProject).mockImplementation(
      async (id) =>
        ({
          id,
          name: id === 'pj-alpha' ? 'Alpha' : 'default',
          packages: [],
          managedWorkspaceWritePolicy: 'deny',
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

  it('does not show an open-in-own-tab button in project details', async () => {
    render(<ProjectsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));

    await screen.findByTestId('project-chat');
    expect(screen.queryByRole('button', { name: 'Open in own tab' })).not.toBeInTheDocument();
  });

  it('groups archived projects at the bottom of the full project list', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'pj-alpha', name: 'Alpha' } as Project,
        { id: 'pj-buried', name: 'Buried', archived: true, status: 'inactive' } as Project,
      ],
    } as never);

    render(<ProjectsView />);

    const heading = await screen.findByRole('heading', { name: 'Archived projects' });
    const archivedSection = heading.closest('section');
    expect(archivedSection).not.toBeNull();
    expect(within(archivedSection!).getByRole('button', { name: 'Buried' })).toBeInTheDocument();
    expect(within(archivedSection!).queryByRole('button', { name: 'Alpha' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Alpha' }).compareDocumentPosition(heading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('archives the open project from Project Settings and exposes Restore', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      status: 'active',
    } as never);
    vi.mocked(api.updateProject)
      .mockResolvedValueOnce({
        id: 'pj-alpha',
        name: 'Alpha',
        packages: [],
        archived: true,
        status: 'inactive',
      } as never)
      .mockResolvedValueOnce({
        id: 'pj-alpha',
        name: 'Alpha',
        packages: [],
        status: 'inactive',
      } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    expect(screen.queryByRole('button', { name: 'Archive project' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));

    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', { archived: true }),
    );
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore project' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Active' }).closest('select')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Restore project' }));
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenLastCalledWith('pj-alpha', { archived: false }),
    );
    await waitFor(() => expect(screen.queryByText('Archived')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Archive project' })).toBeInTheDocument();
  });

  it('shows labeled creation keys when the project list is collapsed', async () => {
    render(<ProjectsView />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse project list' }));

    expect(screen.getByRole('button', { name: 'New Project' })).toHaveTextContent('+Project');
    expect(screen.queryByRole('button', { name: /New Job/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand project list' })).toBeInTheDocument();
  });

  it('also loads the gezellen list (used for assignee pickers)', async () => {
    render(<ProjectsView />);
    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalled();
    });
  });

  it('shows the assigned project crew at the top of Settings', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        {
          id: 'tomas',
          name: 'Tomas',
          role: 'Meester',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
        {
          id: 'yusuf',
          name: 'Yusuf',
          role: 'Developer',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    } as never);
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      voormanGezelId: 'tomas',
      gezelIds: ['tomas', 'yusuf'],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    expect(screen.queryByText('More gezels…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const roster = await screen.findByRole('region', { name: 'Assigned gezellen' });
    expect(within(roster).getAllByRole('listitem')).toHaveLength(2);
    expect(within(roster).getByText('Tomas')).toBeInTheDocument();
    expect(within(roster).getByText('⭐ voorman')).toBeInTheDocument();
    expect(within(roster).getByText('Yusuf')).toBeInTheDocument();
    expect(within(roster).getByText('Developer')).toBeInTheDocument();
  });

  it('adds an existing workshop gezel from Project Settings', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        {
          id: 'tomas',
          name: 'Tomas',
          role: 'Meester',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
        {
          id: 'amira',
          name: 'Amira',
          role: 'Researcher',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    } as never);
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      gezelIds: ['tomas'],
    } as never);
    vi.mocked(api.addGezelToProject).mockResolvedValue({
      gezelIds: ['tomas', 'amira'],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Add Gezel' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Tomas')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Amira/ }));

    await waitFor(() => {
      expect(api.addGezelToProject).toHaveBeenCalledWith('pj-alpha', 'amira');
    });
    const roster = screen.getByRole('region', { name: 'Assigned gezellen' });
    expect(await within(roster).findByText('Amira')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers name and appearance customization for a new role', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        {
          id: 'tomas',
          name: 'Tomas',
          role: 'Meester',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    } as never);
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      gezelIds: ['tomas'],
    } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        {
          sourceId: 'gilde',
          manifest: {
            schemaVersion: 1,
            kind: 'gezel-template',
            id: 'meester',
            name: 'Meester',
            description: 'Guides the workshop.',
            tags: [],
            maintainer: { name: 'Gezel' },
            version: '1.0.0',
            releasedAt: '2026-07-30',
            role: 'Meester',
            about: 'about.md',
            suggestedTools: [],
            meesterCandidate: true,
            availableVersions: [],
          },
        },
        {
          sourceId: 'gilde',
          manifest: {
            schemaVersion: 1,
            kind: 'gezel-template',
            id: 'visual-designer',
            name: 'Visual Designer',
            description: 'Shapes clear and welcoming interfaces.',
            tags: ['design'],
            maintainer: { name: 'Gezel' },
            version: '1.0.0',
            releasedAt: '2026-07-30',
            role: 'Visual Designer',
            about: 'about.md',
            suggestedTools: [],
            meesterCandidate: false,
            availableVersions: [],
            nameSuggestions: ['Nia'],
          },
        },
      ],
    } as never);
    vi.mocked(api.createGezelFromTemplate).mockResolvedValue({
      id: 'nia',
      name: 'Nia',
      role: 'Visual Designer',
      templateId: 'visual-designer',
      updatedAt: '2026-07-30T00:00:00.000Z',
    } as never);
    vi.mocked(api.rerollGezelPoppetje).mockResolvedValue({ poppetje: undefined } as never);
    vi.mocked(api.addGezelToProject).mockResolvedValue({
      gezelIds: ['tomas', 'nia'],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Gezel' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /Meester/ })).not.toBeInTheDocument();
    fireEvent.click(
      await within(dialog).findByRole('button', {
        name: /Visual Designer.*Shapes clear and welcoming interfaces/,
      }),
    );

    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Nia');
    fireEvent.change(name, { target: { value: 'Anika' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reroll appearance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to project' }));

    await waitFor(() => {
      expect(api.createGezelFromTemplate).toHaveBeenCalledWith(
        'visual-designer',
        expect.objectContaining({ name: 'Anika' }),
      );
      expect(api.rerollGezelPoppetje).toHaveBeenCalledWith('nia', {
        seed: expect.any(Number),
      });
      expect(api.addGezelToProject).toHaveBeenCalledWith('pj-alpha', 'nia');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('creates a selected role immediately without customization in boring mode', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      roleBasedNameOnlyMode: true,
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        {
          id: 'tomas',
          name: 'Tomas',
          role: 'Developer',
          roleBasedName: 'developer',
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    } as never);
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      gezelIds: ['tomas'],
    } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        {
          sourceId: 'gilde',
          manifest: {
            schemaVersion: 1,
            kind: 'gezel-template',
            id: 'researcher',
            name: 'Researcher',
            description: 'Finds and checks evidence.',
            tags: [],
            maintainer: { name: 'Gezel' },
            version: '1.0.0',
            releasedAt: '2026-07-30',
            role: 'Researcher',
            about: 'about.md',
            suggestedTools: [],
            meesterCandidate: false,
            availableVersions: [],
          },
        },
      ],
    } as never);
    vi.mocked(api.createGezelFromTemplate).mockResolvedValue({
      id: 'researcher',
      name: 'Researcher',
      role: 'Researcher',
      roleBasedName: 'researcher',
      templateId: 'researcher',
      updatedAt: '2026-07-30T00:00:00.000Z',
    } as never);
    vi.mocked(api.addGezelToProject).mockResolvedValue({
      gezelIds: ['tomas', 'researcher'],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    // The crew roster and the voorman picker both render the role-based name
    // here, so there is deliberately more than one match.
    await screen.findAllByText('developer');
    fireEvent.click(screen.getByRole('button', { name: 'Add Gezel' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Researcher.*Finds and checks evidence/ }),
    );

    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(api.createGezelFromTemplate).toHaveBeenCalledWith('researcher', {
        name: 'Researcher',
      });
      expect(api.addGezelToProject).toHaveBeenCalledWith('pj-alpha', 'researcher');
    });
    expect(api.rerollGezelPoppetje).not.toHaveBeenCalled();
  });

  it('shows credential destinations without editable origin fields', async () => {
    vi.mocked(api.listAvailableCredentials).mockResolvedValue({
      credentials: [
        {
          name: 'github.token',
          label: 'GitHub personal access token',
          stored: true,
          allowedOrigins: ['https://api.github.com'],
          originSource: 'provider',
          defaultOrigins: ['https://api.github.com'],
        },
        {
          name: 'webhook.bearer',
          label: 'Webhook bearer token',
          stored: true,
          allowedOrigins: [],
          originSource: 'webhook',
          defaultOrigins: [],
        },
        {
          name: 'openai.key',
          label: 'OpenAI API key',
          stored: false,
          allowedOrigins: ['https://api.openai.com'],
          originSource: 'provider',
          defaultOrigins: ['https://api.openai.com'],
        },
      ],
    } as never);
    vi.mocked(api.updateProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      grantedCredentials: ['github.token'],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(await screen.findByText(/Restricted to api\.github\.com/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Granted credentials' })).toBeInTheDocument();
    expect(screen.queryByText('Allowed HTTPS origins')).not.toBeInTheDocument();
    expect(screen.queryByText('openai.key')).not.toBeInTheDocument();
    const webhookGrant = screen.getByRole('checkbox', { name: /webhook\.bearer/ });
    expect(webhookGrant).toBeDisabled();
    expect(
      screen.getByText(/Configure an HTTPS webhook URL in Settings → Channels first/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /github\.token/ }));
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', {
        grantedCredentials: ['github.token'],
      });
    });
  });

  it('hides credential grants when no credentials are configured', async () => {
    vi.mocked(api.listAvailableCredentials).mockResolvedValue({
      credentials: [
        {
          name: 'github.token',
          label: 'GitHub personal access token',
          stored: false,
          allowedOrigins: ['https://api.github.com'],
          originSource: 'provider',
          defaultOrigins: ['https://api.github.com'],
        },
      ],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await waitFor(() => expect(api.listAvailableCredentials).toHaveBeenCalled());

    expect(screen.queryByRole('heading', { name: 'Granted credentials' })).not.toBeInTheDocument();
    expect(screen.queryByText('github.token')).not.toBeInTheDocument();
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

  // Switching projects re-resolves `forceProjectId`, and the pane has no
  // project for that round-trip. It must hold the hydrated shape rather than
  // spend the window on a sentence that appears and leaves.
  it('keeps the pane shape while a detail-only project loads, with no loading copy', () => {
    vi.mocked(api.getProject).mockReturnValue(new Promise(() => {}) as never);

    const { container } = render(<ProjectsView forceProjectId="pj-alpha" />);

    expect(screen.queryByText('Loading project…')).not.toBeInTheDocument();
    // The tab strip holds its place with a real (hidden) trigger, so the
    // row's height comes from the same rule the labelled row uses.
    const strip = container.querySelector('.project-pane-placeholder-tabs');
    expect(strip).toBeTruthy();
    expect(strip?.querySelector('.gz-tabs-trigger')).toBeTruthy();
    expect(container.querySelector('.project-pane-placeholder-body')).toBeTruthy();
    // The wait is still announced, just not drawn.
    expect(screen.getByText(/Loading this project/)).toHaveClass('sr-only');
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

  // The pane's own close button, not the identically-labelled toggle in the
  // tab row — both fire the same handler, but the X is the one the user
  // reaches for. Its toolbar collapses to an overflow menu when it can't
  // measure a width, which can happen in jsdom.
  async function clickHideOutput(container: HTMLElement): Promise<void> {
    const pane = container.querySelector('.project-output-pane');
    if (!pane) throw new Error('output pane is not rendered');
    const scope = within(pane as HTMLElement);
    const inline = scope.queryByRole('button', { name: 'Hide output pane' });
    if (inline) {
      fireEvent.click(inline);
      return;
    }
    fireEvent.click(await scope.findByRole('button', { name: 'More output actions' }));
    fireEvent.click(await scope.findByRole('menuitem', { name: 'Hide output' }));
  }

  it('persists hiding the output pane onto the project, not just localStorage', async () => {
    vi.mocked(api.listProjectWorkspaceHtmlPages).mockResolvedValue({
      files: [{ name: 'index.html', path: 'index.html', isDirectory: false }],
    });
    vi.mocked(api.updateProject).mockImplementation(
      async (id, patch) => ({ id, name: 'Alpha', packages: [], ...patch }) as never,
    );

    const { container } = render(<ProjectsView forceProjectId="pj-alpha" />);

    await within(container).findByRole('separator', { name: 'Resize output pane' });
    await clickHideOutput(container);

    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', { outputPaneVisible: false }),
    );
    expect(container.querySelector('.project-output-pane')).toBeNull();
  });

  it('keeps the output pane hidden when the project says so, index.html or not', async () => {
    vi.mocked(api.listProjectWorkspaceHtmlPages).mockResolvedValue({
      files: [{ name: 'index.html', path: 'index.html', isDirectory: false }],
    });
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      outputPaneVisible: false,
    } as never);

    const { container } = render(<ProjectsView forceProjectId="pj-alpha" />);

    await within(container).findByTestId('project-chat');
    expect(container.querySelector('.project-output-pane')).toBeNull();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('adopts a pre-existing localStorage output choice onto the project once', async () => {
    window.localStorage.setItem('gezel.projectOutputVisible:pj-alpha', '0');
    vi.mocked(api.listProjectWorkspaceHtmlPages).mockResolvedValue({
      files: [{ name: 'index.html', path: 'index.html', isDirectory: false }],
    });
    vi.mocked(api.updateProject).mockImplementation(
      async (id, patch) => ({ id, name: 'Alpha', packages: [], ...patch }) as never,
    );

    const { container } = render(<ProjectsView forceProjectId="pj-alpha" />);

    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', { outputPaneVisible: false }),
    );
    expect(container.querySelector('.project-output-pane')).toBeNull();
    await waitFor(() =>
      expect(window.localStorage.getItem('gezel.projectOutputVisible:pj-alpha')).toBeNull(),
    );
  });

  it('orders and indexes every section of the project Settings page', async () => {
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const toc = await screen.findByRole('navigation', { name: 'About sections' });
    const settings = document.querySelector('#project-about-settings');
    const toolsets = document.querySelector('#project-about-toolsets');
    const history = document.querySelector('#project-about-history');
    expect(settings?.nextElementSibling).toBe(toolsets);
    expect(toolsets?.nextElementSibling).toBe(history);

    const links = within(toc).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Assigned gezellen',
      'About this project',
      'Mission objectives',
      'Project memories',
      'Settings',
      'Toolsets',
      'History',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#project-about-crew',
      '#project-about-overview',
      '#project-about-mission',
      '#project-about-memories',
      '#project-about-settings',
      '#project-about-toolsets',
      '#project-about-history',
    ]);
    expect(document.querySelector('#project-about-connections')).toBeNull();
  });

  it('reveals project connection settings while WIP features are on', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      showWorkInProgressFeatures: true,
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const toc = await screen.findByRole('navigation', { name: 'About sections' });
    expect(await within(toc).findByRole('link', { name: 'Connections' })).toHaveAttribute(
      'href',
      '#project-about-connections',
    );
    expect(document.querySelector('#project-about-connections')).not.toBeNull();
  });

  it('keeps a failed project-document edit dirty and retries it', async () => {
    const project = {
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
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
    await act(async () => {
      await flushSerializedAutosave('project:pj-alpha:about').catch(() => {});
    });
    const failedChip = screen.getByText('Save failed');
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
      managedWorkspaceWritePolicy: 'deny',
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
    await act(async () => {
      await flushSerializedAutosave('project:pj-alpha:about').catch(() => {});
    });
    const offlineChip = screen.getByText('Save failed');
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
      managedWorkspaceWritePolicy: 'deny',
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

  it('lets Project Settings override workspace indexing', async () => {
    const project = {
      id: 'pj-alpha',
      name: 'Checkers',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      indexingEnabled: false,
    };
    vi.mocked(api.getProject).mockResolvedValue(project as never);
    vi.mocked(api.updateProject).mockResolvedValue({
      ...project,
      indexingEnabled: true,
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const checkbox = await screen.findByRole('checkbox', {
      name: /Index this project's workspace/,
    });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', { indexingEnabled: true });
      expect(api.refreshProjectIndex).toHaveBeenCalledWith('pj-alpha');
    });
  });

  it('adds and removes one-way project links from Settings', async () => {
    const project = {
      id: 'pj-alpha',
      name: 'Racing game',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      packages: [],
      managedWorkspaceWritePolicy: 'allow' as const,
      linkedProjectIds: [],
    };
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        project as Project,
        {
          id: 'vehicle-physics',
          name: 'Vehicle physics',
          workingDir: 'D:\\projects\\vehicle-physics',
          managedWorkspaceWritePolicy: 'deny',
        } as Project,
        { id: 'archived-not-linked', name: 'Old prototype', archived: true } as Project,
      ],
    } as never);
    vi.mocked(api.getProject).mockResolvedValue(project as never);
    vi.mocked(api.updateProject).mockImplementation(
      async (_id, patch) => ({ ...project, ...patch }) as never,
    );

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(await screen.findByText('Linked projects')).toBeInTheDocument();
    expect(screen.getByText(/0 of 32 linked/)).toBeInTheDocument();
    expect(
      screen.getByText(/Shared documents are always included automatically/),
    ).toBeInTheDocument();
    expect(screen.getByText(/workspace read-only/)).toBeInTheDocument();
    expect(screen.queryByText('Old prototype')).not.toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox', { name: /Vehicle physics/ });
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', {
        linkedProjectIds: ['vehicle-physics'],
      }),
    );
    await waitFor(() => expect(checkbox).toBeChecked());

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenLastCalledWith('pj-alpha', {
        linkedProjectIds: [],
      }),
    );
  });

  it('shows workspace indexing issues and toggles the Boekwachter results pane', async () => {
    const editableProject = {
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'allow',
      gezelIds: ['willa'],
    };
    vi.mocked(api.getProject).mockResolvedValue(editableProject as never);
    vi.mocked(api.updateProject).mockImplementation(
      async (_id, patch) => ({ ...editableProject, ...patch }) as never,
    );
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'willa', name: 'Willa', role: 'Writer' }],
    } as never);
    vi.mocked(api.fixBoekwachterIssue).mockResolvedValue({
      issue: { ...trackedWorkspaceIssue, status: 'in_progress', seen: true, taskRef: 'pj-alpha/3' },
      taskRef: 'pj-alpha/3',
      gezelId: 'willa',
      gezelName: 'Willa',
      enqueued: true,
    });
    vi.mocked(api.listProjectWorkspace).mockResolvedValue({
      files: [{ name: 'audit.md', path: 'notes/audit.md', isDirectory: false }],
      truncated: false,
    } as never);
    vi.mocked(api.readProjectWorkspaceFile).mockResolvedValue({
      path: 'notes/audit.md',
      content: '# Audit',
    } as never);
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({
      state: 'fresh',
      enrichment: {
        eligible: 1,
        summarized: 1,
        embedded: 1,
        pending: 0,
        reviews: { eligible: 1, reviewed: 1, stale: 0, pending: 0 },
      },
    } as never);
    vi.mocked(api.toolListFileIssues).mockResolvedValue({
      issues: [trackedWorkspaceIssue],
      counts: { total: 1, bySeverity: { minor: 1 }, byCategory: { clarity: 1 } },
      truncated: false,
      indexed: true,
      reviewedFiles: 1,
      eligibleFiles: 1,
    } as never);
    vi.mocked(api.toolFileReview).mockResolvedValue({
      path: 'notes/audit.md',
      found: true,
      review: {
        notesMd: 'A concise audit with one unresolved ownership question.',
        issues: [
          {
            severity: 'minor',
            category: 'clarity',
            message: 'The conclusion does not identify an owner.',
            line: 12,
          },
        ],
        health: 8,
        healthReason: 'Clear and useful, with one actionable omission.',
        model: 'qwen-test',
        provider: 'mock',
        gezelName: 'Boekwachter',
        reviewedAt: '2026-08-11T12:00:00.000Z',
      },
      trackedIssues: [trackedWorkspaceIssue],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));

    expect(await screen.findByText('Index ready')).toBeInTheDocument();
    expect(screen.getByText('1 issue')).toBeInTheDocument();
    expect(screen.getByLabelText('1 indexing issue')).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: 'audit.md' }));
    const toggle = await screen.findByRole('button', {
      name: 'Show Boekwachter index pane, 1 issue in this file',
    });
    expect(toggle.closest('[data-testid="editor-toolbar-right"]')).not.toBeNull();
    fireEvent.click(toggle);

    const pane = await screen.findByRole('complementary', { name: 'Boekwachter index results' });
    expect(within(pane).getByText('8')).toBeInTheDocument();
    expect(
      within(pane).getByText('Clear and useful, with one actionable omission.'),
    ).toBeInTheDocument();
    expect(
      within(pane).getByText('The conclusion does not identify an owner.'),
    ).toBeInTheDocument();
    expect(api.toolFileReview).toHaveBeenCalledWith('pj-alpha', { path: 'notes/audit.md' });
    expect(within(pane).getByRole('button', { name: 'Fix' })).toBeInTheDocument();

    // Turning managed edits off does NOT take Fix away: a fix is drafted as a
    // change proposal the user applies, so it works on a workspace gezels may
    // not write — the case that needs it most.
    const editsSelect = () =>
      screen
        .getAllByTestId('mock-select')
        .find((select) => within(select).queryByRole('option', { name: 'Can edit' }));
    fireEvent.change(editsSelect()!, { target: { value: 'off' } });
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', {
        managedWorkspaceWritePolicy: 'deny',
      });
    });
    expect(within(pane).getByRole('button', { name: 'Fix' })).toBeInTheDocument();

    fireEvent.change(editsSelect()!, { target: { value: 'on' } });
    await waitFor(() => {
      expect(within(pane).getByRole('button', { name: 'Fix' })).toBeInTheDocument();
    });

    fireEvent.click(within(pane).getByRole('button', { name: /Line 12/ }));
    await waitFor(() => {
      expect(editorMocks.setSelection).toHaveBeenCalledWith({
        startLineNumber: 12,
        startColumn: 1,
        endLineNumber: 12,
        endColumn: 24,
      });
      expect(editorMocks.revealLineInCenter).toHaveBeenCalledWith(12);
      expect(editorMocks.focus).toHaveBeenCalled();
    });

    fireEvent.click(within(pane).getByRole('button', { name: 'Close Boekwachter index pane' }));
    expect(screen.queryByRole('complementary', { name: 'Boekwachter index results' })).toBeNull();

    fireEvent.click(toggle);
    const reopenedPane = await screen.findByRole('complementary', {
      name: 'Boekwachter index results',
    });
    fireEvent.click(within(reopenedPane).getByRole('button', { name: 'Fix' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Assigned role' })).toHaveValue('writer');
    expect(within(dialog).getByRole('option', { name: 'Willa — Writer' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Message' })).toHaveValue(
      '@writer, can you address BW-1 in notes/audit.md at line 12: The conclusion does not identify an owner.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => {
      expect(api.fixBoekwachterIssue).toHaveBeenCalledWith('pj-alpha', {
        ref: 'BW-1',
        gezelId: 'willa',
        message:
          '@writer, can you address BW-1 in notes/audit.md at line 12: The conclusion does not identify an owner.',
      });
    });
    expect(await screen.findByTestId('project-chat')).toBeInTheDocument();
  });

  it('offers five workspace view modes, persists the choice, and loads the flat index list', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
    } as never);
    vi.mocked(api.listProjectWorkspace).mockResolvedValue({
      files: [
        { name: 'old.md', path: 'docs/old.md', isDirectory: false, mtimeMs: 100 },
        { name: 'docs', path: 'docs', isDirectory: true },
      ],
      truncated: false,
    } as never);
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({ state: 'stale' } as never);
    vi.mocked(api.listProjectIndexFilesDetail).mockResolvedValue({
      files: [
        { path: 'docs/old.md', size: 10, mtimeMs: 100 },
        { path: 'fresh.md', size: 10, mtimeMs: 900 },
      ],
      total: 2,
    } as never);
    vi.mocked(api.refreshProjectIndex).mockResolvedValue({
      ok: true,
      status: { state: 'indexing' },
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));

    await waitFor(() => {
      expect(api.listProjectWorkspace).toHaveBeenCalledWith('pj-alpha', '', true, {
        stats: true,
        hidden: false,
      });
    });

    const tray = await screen.findByRole('radiogroup', { name: 'File list view' });
    expect(within(tray).getAllByRole('radio')).toHaveLength(5);
    expect(within(tray).getByRole('radio', { name: 'Folders, A to Z' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(within(tray).getByRole('radio', { name: 'All files by last modified' }));
    expect(window.localStorage.getItem('gezel.projectFilesView:pj-alpha:workspace')).toBe(
      'flat-modified',
    );
    await waitFor(() => {
      expect(api.listProjectIndexFilesDetail).toHaveBeenCalledWith('pj-alpha', { hidden: false });
    });
    // Newest first, from the index-backed list (fresh.md is not in the walk).
    const flatButtons = await screen.findByRole('button', { name: /fresh\.md/ });
    expect(flatButtons).toBeInTheDocument();

    // Stale index surfaces the notice with an Index now action.
    expect(screen.getByText('Index is out of date.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Index now' }));
    await waitFor(() => {
      expect(api.refreshProjectIndex).toHaveBeenCalledWith('pj-alpha');
    });
  });

  it('resizes the workspace file tree by dragging the grip and collapses it to a rail', async () => {
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));

    const layout = (await screen.findByText('Workspace', { selector: '.file-tree-title' })).closest(
      '.project-files-layout',
    ) as HTMLElement;
    expect(layout.style.getPropertyValue('--file-tree-user-width')).toBe('240px');

    const grip = screen.getByRole('separator', { name: 'Resize workspace files' });
    fireEvent.mouseDown(grip, { clientX: 240 });
    fireEvent.mouseMove(window, { clientX: 360 });
    fireEvent.mouseUp(window);

    expect(layout.style.getPropertyValue('--file-tree-user-width')).toBe('360px');
    expect(window.localStorage.getItem('gezel:project-file-tree-width:v1')).toBe('360');

    // Dragging back below the collapse threshold swaps the tree for a rail.
    fireEvent.mouseDown(grip, { clientX: 360 });
    fireEvent.mouseMove(window, { clientX: 80 });
    fireEvent.mouseUp(window);

    expect(window.localStorage.getItem('gezel:project-file-tree-collapsed:v1')).toBe('1');
    expect(screen.queryByText('Workspace', { selector: '.file-tree-title' })).toBeNull();
    // The stored width survives the collapse, so expanding restores it.
    expect(window.localStorage.getItem('gezel:project-file-tree-width:v1')).toBe('360');

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace files' }));
    expect(await screen.findByText('Workspace', { selector: '.file-tree-title' })).toBeVisible();
    expect(layout.style.getPropertyValue('--file-tree-user-width')).toBe('360px');
    expect(window.localStorage.getItem('gezel:project-file-tree-collapsed:v1')).toBe('0');
  });

  it('ranks the issue triage views by count and weighted criticality', async () => {
    const issueAt = (path: string, severity: 'major' | 'minor', ref: string) => ({
      ...trackedWorkspaceIssue,
      id: ref,
      ref,
      fingerprint: ref,
      path,
      severity,
    });
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
    } as never);
    vi.mocked(api.toolListFileIssues).mockResolvedValue({
      issues: [
        issueAt('many.md', 'minor', 'BW-1'),
        issueAt('many.md', 'minor', 'BW-2'),
        issueAt('grave.md', 'major', 'BW-3'),
      ],
      counts: { total: 3, bySeverity: { minor: 2, major: 1 }, byCategory: { clarity: 3 } },
      truncated: false,
      indexed: true,
      reviewedFiles: 2,
      eligibleFiles: 4,
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));

    const tray = await screen.findByRole('radiogroup', { name: 'File list view' });
    fireEvent.click(within(tray).getByRole('radio', { name: 'Files by issues' }));

    expect(await screen.findByText('2 of 4 eligible files reviewed')).toBeInTheDocument();
    const issueRows = screen
      .getAllByRole('button')
      .filter((b) => /many\.md|grave\.md/.test(b.textContent ?? ''));
    expect(issueRows.map((b) => b.textContent?.trim().split(/\s/)[0])).toEqual([
      'many.md',
      'grave.md',
    ]);

    fireEvent.click(within(tray).getByRole('radio', { name: 'Files by criticality' }));
    const scoredRows = screen
      .getAllByRole('button')
      .filter((b) => /many\.md|grave\.md/.test(b.textContent ?? ''));
    expect(scoredRows.map((b) => b.textContent?.trim().split(/\s/)[0])).toEqual([
      'grave.md',
      'many.md',
    ]);
  });

  it('opens the file with the Boekwachter pane when a triage row badge is clicked', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
    } as never);
    vi.mocked(api.readProjectWorkspaceFile).mockResolvedValue({
      path: 'notes/audit.md',
      content: '# Audit',
    } as never);
    vi.mocked(api.toolListFileIssues).mockResolvedValue({
      issues: [
        trackedWorkspaceIssue,
        { ...trackedWorkspaceIssue, id: 'issue-2', ref: 'BW-2', severity: 'major' },
      ],
      counts: { total: 2, bySeverity: { minor: 1, major: 1 }, byCategory: { clarity: 2 } },
      truncated: false,
      indexed: true,
      reviewedFiles: 1,
      eligibleFiles: 1,
    } as never);
    vi.mocked(api.toolFileReview).mockResolvedValue({
      path: 'notes/audit.md',
      found: true,
      review: {
        notesMd: 'A concise audit with one unresolved ownership question.',
        issues: [
          {
            severity: 'minor',
            category: 'clarity',
            message: 'The conclusion does not identify an owner.',
            line: 12,
          },
        ],
        health: 8,
        healthReason: 'Clear and useful, with one actionable omission.',
        model: 'qwen-test',
        provider: 'mock',
        gezelName: 'Boekwachter',
        reviewedAt: '2026-08-11T12:00:00.000Z',
      },
      trackedIssues: [trackedWorkspaceIssue],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));

    const tray = await screen.findByRole('radiogroup', { name: 'File list view' });
    fireEvent.click(within(tray).getByRole('radio', { name: 'Files by issues' }));

    // The severity badge, not the file name: it sits outside the label button
    // and is what a triage reader actually aims at.
    const badge = await screen.findByText('1 major · 1 minor');
    fireEvent.click(badge);

    const pane = await screen.findByRole('complementary', { name: 'Boekwachter index results' });
    expect(
      await within(pane).findByText('Clear and useful, with one actionable omission.'),
    ).toBeInTheDocument();
    expect(api.toolFileReview).toHaveBeenCalledWith('pj-alpha', { path: 'notes/audit.md' });
  });

  it('offers workspace file mutations only when the write policy allows them', async () => {
    vi.mocked(api.listProjectWorkspace).mockResolvedValue({
      files: [{ name: 'note.md', path: 'notes/note.md', isDirectory: false }],
      truncated: false,
    } as never);
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
    } as never);

    const readOnly = render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    await screen.findByTestId('file-tree');

    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'rename note.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'delete note.md' })).toBeNull();
    readOnly.unmount();

    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'allow',
    } as never);
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    await screen.findByTestId('file-tree');

    expect(screen.getByRole('button', { name: 'New folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'rename note.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'delete note.md' })).toBeInTheDocument();
  });

  it('confirms before deleting an artifact instead of removing it on the first click', async () => {
    vi.mocked(api.listProjectArtifacts).mockResolvedValue({
      files: [{ name: 'report.md', path: 'reports/report.md', isDirectory: false }],
      truncated: false,
    } as never);
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    await screen.findByTestId('file-tree');

    fireEvent.click(screen.getByRole('button', { name: 'delete report.md' }));
    // The confirmation gate owns the delete now — nothing reaches the API
    // until it is answered (ConfirmDialog is stubbed out in this spec).
    expect(api.deleteProjectArtifact).not.toHaveBeenCalled();
  });

  it('isolates a Markdown artifact in its own companion container', async () => {
    vi.mocked(api.listProjectArtifacts).mockResolvedValue({
      files: [{ name: 'report.md', path: 'reports/report.md', isDirectory: false }],
      truncated: false,
    } as never);
    vi.mocked(api.readProjectArtifact).mockResolvedValue({
      path: 'reports/report.md',
      content: '# Report',
    } as never);
    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'report.md' }));
    await screen.findByTestId('editor');

    expect(documentContainerMocks.createArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ root: 'reports/report_files', referencePrefix: 'report_files' }),
    );
    expect(documentContainerMocks.createArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ root: 'reports', primaryDocumentFilename: 'report.md' }),
    );
    expect(documentContainerMocks.createMedia).toHaveBeenCalledWith(
      expect.anything(),
      'report_files',
      expect.anything(),
    );
    expect(documentContainerMocks.createVersionCompatible).toHaveBeenCalledWith(
      expect.anything(),
      'report',
      expect.anything(),
      expect.anything(),
    );
  });

  it('shows only the three shared view modes on the artifacts tab', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));

    const tray = await screen.findByRole('radiogroup', { name: 'File list view' });
    const keys = within(tray).getAllByRole('radio');
    expect(keys).toHaveLength(3);
    expect(within(tray).queryByRole('radio', { name: 'Files by issues' })).toBeNull();
    expect(within(tray).queryByRole('radio', { name: 'Files by criticality' })).toBeNull();
  });

  it('offers a Boekwachter fix when Codex Edit can write past the scoped workspace gate', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'codex-cli' } as never);
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      codexPermissionMode: 'edit',
      gezelIds: ['willa'],
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'willa', name: 'Willa', role: 'Writer' }],
    } as never);
    vi.mocked(api.listProjectWorkspace).mockResolvedValue({
      files: [{ name: 'audit.md', path: 'notes/audit.md', isDirectory: false }],
      truncated: false,
    } as never);
    vi.mocked(api.readProjectWorkspaceFile).mockResolvedValue({
      path: 'notes/audit.md',
      content: '# Audit',
    } as never);
    vi.mocked(api.getProjectIndexStatus).mockResolvedValue({
      state: 'fresh',
      enrichment: {
        eligible: 1,
        summarized: 1,
        embedded: 1,
        pending: 0,
        reviews: { eligible: 1, reviewed: 1, stale: 0, pending: 0 },
      },
    } as never);
    vi.mocked(api.toolListFileIssues).mockResolvedValue({
      issues: [trackedWorkspaceIssue],
      counts: { total: 1, bySeverity: { minor: 1 }, byCategory: { clarity: 1 } },
      truncated: false,
      indexed: true,
      reviewedFiles: 1,
      eligibleFiles: 1,
    } as never);
    vi.mocked(api.toolFileReview).mockResolvedValue({
      path: 'notes/audit.md',
      found: true,
      review: {
        notesMd: '',
        issues: [
          {
            severity: 'minor',
            category: 'clarity',
            message: 'The conclusion does not identify an owner.',
            line: 12,
          },
        ],
        health: 8,
        healthReason: 'One actionable omission.',
        model: 'gpt-test',
        provider: 'codex-cli',
        gezelName: 'Boekwachter',
        reviewedAt: '2026-08-11T12:00:00.000Z',
      },
      trackedIssues: [trackedWorkspaceIssue],
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'audit.md' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Show Boekwachter index pane, 1 issue in this file',
      }),
    );

    const pane = await screen.findByRole('complementary', { name: 'Boekwachter index results' });
    const codexModeSelect = screen
      .getAllByTestId('mock-select')
      .find((select) => within(select).queryByRole('option', { name: 'Plan' }));
    const managedAccessSelect = screen
      .getAllByTestId('mock-select')
      .find((select) => within(select).queryByRole('option', { name: 'Can edit' }));
    expect(managedAccessSelect).toHaveValue('off');
    expect(codexModeSelect).toHaveValue('edit');
    expect(within(pane).getByRole('button', { name: 'Fix' })).toBeInTheDocument();
  });

  it('shows and persists Claude access only when Claude is represented in the project', async () => {
    const project = {
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
      gezelIds: ['claude-writer'],
    };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mlx',
      anthropicCli: { defaultPermissionMode: 'acceptEdits' },
    } as never);
    vi.mocked(api.getProject).mockResolvedValue(project as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        {
          id: 'claude-writer',
          name: 'Claude Writer',
          role: 'Writer',
          provider: 'anthropic-cli',
        },
      ],
    } as never);
    vi.mocked(api.updateProject).mockImplementation(
      async (_id, patch) => ({ ...project, ...patch }) as never,
    );

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');

    const claudeModeSelect = screen
      .getAllByTestId('mock-select')
      .find((select) => within(select).queryByRole('option', { name: 'Ask' }));
    expect(claudeModeSelect).toHaveValue('acceptEdits');
    expect(screen.queryByRole('option', { name: 'Reviewed' })).not.toBeInTheDocument();

    fireEvent.change(claudeModeSelect!, { target: { value: 'plan' } });
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', {
        claudePermissionMode: 'plan',
      });
    });
  });

  it('hides optional project tabs and lets Settings turn them back on', async () => {
    const focusedProject = {
      id: 'pj-alpha',
      name: 'Checkers',
      packages: [],
      managedWorkspaceWritePolicy: 'deny',
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
      managedWorkspaceWritePolicy: 'deny',
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
    // The picker opens with nothing chosen — step 1 is the catalog alone.
    expect(within(gallery).getByRole('radio', { name: 'General' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    const designType = await within(gallery).findByRole('radio', { name: 'Design Scheme' });
    expect(designType).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project types' }), {
      target: { value: 'palette' },
    });
    expect(within(gallery).queryByRole('radio', { name: 'General' })).not.toBeInTheDocument();
    expect(within(gallery).getByRole('radio', { name: 'Design Scheme' })).toBeInTheDocument();

    // Choosing advances to step 2; going back leaves the choice lit.
    fireEvent.click(designType);
    expect(screen.queryByRole('radiogroup', { name: 'Project type' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Design Scheme' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Project types/ }));
    const backGallery = await screen.findByRole('radiogroup', { name: 'Project type' });
    expect(within(backGallery).getByRole('radio', { name: 'Design Scheme' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
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
        managedWorkspaceWritePolicy: 'deny',
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

  it('lets a project opt out of overnight fixing, and defaults it on', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      gezelIds: [],
    } as never);
    vi.mocked(api.updateProject).mockResolvedValue({
      id: 'pj-alpha',
      name: 'Alpha',
      packages: [],
      gezelIds: [],
      nightlyFixesEnabled: false,
    } as never);

    render(<ProjectsView forceProjectId="pj-alpha" />);
    await screen.findByTestId('project-chat');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const toggle = await screen.findByRole('checkbox', { name: /Fix problems overnight/ });
    // Unset means on: the crew that unlocks it is the opt-in.
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('pj-alpha', { nightlyFixesEnabled: false });
    });
  });
});
