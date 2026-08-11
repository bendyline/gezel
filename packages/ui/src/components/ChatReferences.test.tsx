import { type Task, initialPoppetjeForGezel } from '@bendyline/gezel';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_RAIL_MIN_SPLIT_PX, ChatReferences } from './ChatReferences.js';

const apiMocks = vi.hoisted(() => ({
  getTaskByRef: vi.fn(),
  getConfig: vi.fn(),
  listGezels: vi.fn(),
  listTaskNotes: vi.fn(),
  previewReference: vi.fn(),
  fetchProjectArtifactBlob: vi.fn(),
  fetchProjectWorkspaceBlob: vi.fn(),
  fetchDocumentBlob: vi.fn(),
  readProjectArtifact: vi.fn(),
  readDocument: vi.fn(),
  readProjectWorkspaceFile: vi.fn(),
  getProjectSkills: vi.fn(),
  getProjectImportsPending: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMocks }));

// The global-HTML preview test exercises the inert source-code branch, not
// Squisq itself. Mounting the real EditorShell starts Monaco's uncancellable
// dynamic import, which can outlive this jsdom environment and race teardown.
vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    initialMarkdown,
    fileName,
    readOnly,
  }: {
    initialMarkdown: string;
    fileName?: string;
    readOnly?: boolean;
  }) => (
    <pre
      data-testid="reference-code-preview"
      data-file={fileName}
      data-readonly={String(Boolean(readOnly))}
    >
      {initialMarkdown}
    </pre>
  ),
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

// Capture the props: `data-section` and `data-stageable` are what stop the
// rail silently regaining commands/craftbooks or the terminal-staging hook.
vi.mock('./CommandsPanel.js', () => ({
  CommandsPanel: ({
    section,
    onStageCommand,
  }: {
    section?: string;
    onStageCommand?: unknown;
  }) => (
    <div
      data-testid="commands-panel"
      data-section={section}
      data-stageable={String(Boolean(onStageCommand))}
    />
  ),
}));

let activeWidth = 0;

beforeEach(() => {
  apiMocks.getConfig.mockResolvedValue({ showPoppetjes: true });
  apiMocks.listGezels.mockResolvedValue({ gezels: [] });
  apiMocks.listTaskNotes.mockResolvedValue({ notes: [] });
  apiMocks.previewReference.mockImplementation(async (_projectId, request) => ({
    mode: 'text',
    content: `# ${request.path}`,
  }));
  apiMocks.fetchProjectArtifactBlob.mockResolvedValue(new Blob(['media']));
  apiMocks.fetchProjectWorkspaceBlob.mockResolvedValue(new Blob(['media']));
  apiMocks.fetchDocumentBlob.mockResolvedValue(new Blob(['media']));
  apiMocks.getProjectSkills.mockResolvedValue({
    skills: [{ name: 'summarize', source: '.claude/skills/summarize/SKILL.md' }],
  });
  apiMocks.getProjectImportsPending.mockResolvedValue({ items: [] });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:reference-preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
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
  delete window.__GEZEL__;
});

function renderProjectRail() {
  return render(
    <ChatReferences chatKey="project-1" projectId="project-1" skillsProjectId="project-1">
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
  it('does not reserve a context pane when the project has no workspace skills or imports', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    apiMocks.getProjectSkills.mockResolvedValue({ skills: [] });
    apiMocks.getProjectImportsPending.mockResolvedValue({ items: [] });

    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(apiMocks.getProjectSkills).toHaveBeenCalledWith('project-1');
      expect(apiMocks.getProjectImportsPending).toHaveBeenCalledWith('project-1');
    });
    expect(container.querySelector('.chat-rail-body-split')).toBeNull();
    expect(container.querySelector('.chat-rail-side')).toBeNull();
    expect(screen.queryByTestId('commands-panel')).not.toBeInTheDocument();
  });

  it('replaces the right pane with full-width tabs below the split threshold', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX - 1;
    const user = userEvent.setup();
    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(container.querySelector('.chat-rail-body-compact')).not.toBeNull();
    });
    expect(container.querySelector('aside')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('tab', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.queryByTestId('commands-panel')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Skills' }));

    const panel = screen.getByTestId('commands-panel');
    expect(panel).toBeVisible();
    expect(panel).toHaveAttribute('data-section', 'skills');
    expect(panel).toHaveAttribute('data-stageable', 'false');
    expect(screen.getByTestId('chat-main').closest('.gz-tabs-content')).toHaveAttribute(
      'data-state',
      'inactive',
    );
  });

  it('keeps the right pane at the minimum viable split width', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(container.querySelector('.chat-rail-body-split')).not.toBeNull();
    });
    expect(container.querySelector('aside')).not.toBeNull();
    const panel = await screen.findByTestId('commands-panel');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute('data-section', 'skills');
    expect(panel).toHaveAttribute('data-stageable', 'false');
  });

  it('still splits at the width the output pane leaves on a laptop window', async () => {
    // 1512 px window − ~242 px Home sidebar − ~220 px output pane ≈ 1035 px
    // of rail. The threshold used to sit at 1100, so the split was
    // unreachable whenever the output pane was open, no matter how wide the
    // window. Pinned as a literal: a future bump past this fails here.
    activeWidth = 1035;
    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(container.querySelector('.chat-rail-body-split')).not.toBeNull();
    });
    expect(container.querySelector('.chat-rail-body-compact')).toBeNull();
  });

  it('offers Chat, Task, and Skills as peer tabs when a narrow chat has a task', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX - 1;
    const user = userEvent.setup();
    apiMocks.getTaskByRef.mockResolvedValue(task('project-1/1', 'First task'));

    const { container } = render(
      <ChatReferences
        chatKey="project-1"
        projectId="project-1"
        skillsProjectId="project-1"
        banner={() => <div data-testid="thread-task-bar">Thread/task bar</div>}
      >
        {({ onTaskReference }) => (
          <button type="button" onClick={() => onTaskReference('project-1/1', { scoped: true })}>
            Add task reference
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Add task reference' }));

    await waitFor(() => {
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'Chat',
        'Task',
        'Skills',
      ]);
    });

    expect(
      Array.from(
        container.querySelectorAll('.chat-rail-banner, .chat-rail-compact-tabs'),
        (element) => (element.classList.contains('chat-rail-banner') ? 'banner' : 'tabs'),
      ),
    ).toEqual(['banner', 'tabs']);

    await user.click(screen.getByRole('tab', { name: 'Task' }));

    expect(await screen.findByRole('heading', { name: 'First task' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Task' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('thread-task-bar')).toBeVisible();
  });

  it('pulls the rail onto a task with `focus`, even while a reference is open', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.getTaskByRef.mockResolvedValue(task('project-1/2', 'Second task'));

    render(
      <ChatReferences chatKey="project-1" projectId="project-1" skillsProjectId="project-1">
        {({ onArtifactReference, onTaskReference }) => (
          <>
            <button type="button" onClick={() => onArtifactReference('notes.md')}>
              Add artifact
            </button>
            <button type="button" onClick={() => onTaskReference('project-1/2', { focus: true })}>
              Focus task
            </button>
          </>
        )}
      </ChatReferences>,
    );

    // A live reference normally wins the rail — the rising-edge effect
    // switches to References and the task effect holds back.
    await user.click(screen.getByRole('button', { name: 'Add artifact' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'References' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    await user.click(screen.getByRole('button', { name: 'Focus task' }));

    expect(await screen.findByRole('heading', { name: 'Second task' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Task' })).toHaveAttribute('aria-selected', 'true');
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
    apiMocks.listGezels.mockResolvedValue({
      gezels: [
        {
          id: 'maya',
          name: 'Maya',
          poppetje: initialPoppetjeForGezel('maya', 'Maya'),
        },
      ],
    });
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
    expect(noteBodies[0]?.querySelector('.gezel-icon-poppetje')).not.toBeNull();
    expect(noteBodies[0]).toHaveTextContent('Inspect');
    expect(noteBodies[1]).toHaveTextContent('Older note');
  });
});

describe('ChatReferences reference picker', () => {
  it('renders global HTML documents as inert source rather than srcDoc', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.previewReference.mockResolvedValue({
      mode: 'text',
      content: '<meta http-equiv="refresh" content="0;url=https://attacker.test">',
    });

    const { container } = render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onToolActivity }) => (
          <button
            type="button"
            onClick={() =>
              onToolActivity({
                name: 'read_document',
                path: 'remote.html',
                success: true,
                durationMs: 1,
              })
            }
          >
            Open global HTML
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Open global HTML' }));
    await waitFor(() => expect(container.querySelector('.chat-rail-viewer-code')).not.toBeNull());
    const source = screen.getByTestId('reference-code-preview');
    expect(source).toHaveAttribute('data-file', 'remote.html');
    expect(source).toHaveAttribute('data-readonly', 'true');
    expect(source).toHaveTextContent(
      '<meta http-equiv="refresh" content="0;url=https://attacker.test">',
    );
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('offers native save-copy and containing-folder actions for the active file', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    const saveReferenceCopy = vi.fn().mockResolvedValue({ ok: true });
    const showReferenceInFolder = vi.fn().mockResolvedValue({ ok: true });
    window.__GEZEL__ = {
      token: '',
      saveReferenceCopy,
      showReferenceInFolder,
    };
    apiMocks.previewReference.mockRejectedValue(
      new Error('Preview unavailable in native-action test'),
    );

    render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onToolActivity }) => (
          <button
            type="button"
            onClick={() =>
              onToolActivity({
                name: 'read_artifact',
                path: 'reports/final.md',
                success: true,
                durationMs: 1,
              })
            }
          >
            Add reference
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Add reference' }));
    const actions = await screen.findByRole('button', { name: 'Actions for final.md' });

    await user.click(actions);
    await user.click(await screen.findByRole('menuitem', { name: 'Save copy as…' }));
    expect(saveReferenceCopy).toHaveBeenCalledWith({
      projectId: 'project-1',
      kind: 'artifact',
      path: 'reports/final.md',
    });

    await user.click(actions);
    await user.click(await screen.findByRole('menuitem', { name: 'Open containing folder' }));
    expect(showReferenceInFolder).toHaveBeenCalledWith({
      projectId: 'project-1',
      kind: 'artifact',
      path: 'reports/final.md',
    });
  });

  it('promotes a terminal workspace reference into the previewer', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.previewReference.mockRejectedValue(
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
      expect(apiMocks.previewReference).toHaveBeenCalledWith('project-1', {
        kind: 'workspace',
        path: 'battle-research.md',
      });
    });
  });

  it('selects files from a dropdown under the References tab', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    // Keep the viewer on its lightweight error path. This test exercises the
    // picker; rendering markdown would pull canvas/media behavior into jsdom
    // that belongs to the previewer's own coverage.
    apiMocks.previewReference.mockRejectedValue(new Error('Preview unavailable in picker test'));

    const { container } = render(
      <ChatReferences chatKey="project-1" projectId="project-1" skillsProjectId="project-1">
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
      expect(apiMocks.previewReference).toHaveBeenLastCalledWith('project-1', {
        kind: 'artifact',
        path: 'design.md',
      });
    });
  });

  it('adds every successful path from a batched workspace read', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.previewReference.mockRejectedValue(
      new Error('Preview unavailable in batch-reference test'),
    );

    render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onToolActivity }) => (
          <button
            type="button"
            onClick={() =>
              onToolActivity({
                name: 'read_files',
                paths: ['src/alpha.ts', 'src/beta.ts'],
                success: true,
                durationMs: 1,
              })
            }
          >
            Read batch
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Read batch' }));
    const referencesTab = await screen.findByRole('tab', { name: 'References' });
    await user.click(referencesTab);
    expect(await screen.findByRole('menuitem', { name: 'alpha.ts' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'beta.ts' })).toBeVisible();
  });

  it.each([
    ['image', 'preview.png', 'img'],
    ['video', 'preview.mp4', 'video'],
    ['audio', 'preview.mp3', 'audio'],
  ] as const)('renders a %s reference with its native viewer', async (kind, path, selector) => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.previewReference.mockResolvedValue({ mode: 'media', mediaKind: kind });

    const { container } = render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onArtifactReference }) => (
          <button type="button" onClick={() => onArtifactReference(path)}>
            Open media
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Open media' }));
    await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
    expect(apiMocks.fetchProjectArtifactBlob).toHaveBeenCalledWith('project-1', path);
  });

  it('renders a converted PPTX companion through the Squisq markdown viewer', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    apiMocks.previewReference.mockResolvedValue({
      mode: 'markdown',
      content: '# Converted deck\n\nBattle overview',
      sidecarPath: 'battle-deck_files/battle-deck.md',
    });

    const { container } = render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onArtifactReference }) => (
          <button type="button" onClick={() => onArtifactReference('battle-deck.pptx')}>
            Open deck
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Open deck' }));
    expect(await screen.findByText('Converted deck')).toBeInTheDocument();
    expect(container.querySelector('.chat-rail-viewer-markdown')).not.toBeNull();
    expect(container.querySelector('.chat-rail-viewer-code')).toBeNull();
  });

  it('shows a machine-file card with direct native actions for unknown binary files', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const user = userEvent.setup();
    const saveReferenceCopy = vi.fn().mockResolvedValue({ ok: true });
    const showReferenceInFolder = vi.fn().mockResolvedValue({ ok: true });
    window.__GEZEL__ = {
      token: '',
      saveReferenceCopy,
      showReferenceInFolder,
    };
    apiMocks.previewReference.mockResolvedValue({ mode: 'binary' });

    render(
      <ChatReferences chatKey="project-1" projectId="project-1">
        {({ onArtifactReference }) => (
          <button type="button" onClick={() => onArtifactReference('build/archive.bin')}>
            Open binary
          </button>
        )}
      </ChatReferences>,
    );

    await user.click(screen.getByRole('button', { name: 'Open binary' }));
    expect(await screen.findByText('<Machine File>')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save copy as…' }));
    await user.click(screen.getByRole('button', { name: 'Open containing folder' }));
    expect(saveReferenceCopy).toHaveBeenCalledWith({
      projectId: 'project-1',
      kind: 'artifact',
      path: 'build/archive.bin',
    });
    expect(showReferenceInFolder).toHaveBeenCalledWith({
      projectId: 'project-1',
      kind: 'artifact',
      path: 'build/archive.bin',
    });
  });
});
