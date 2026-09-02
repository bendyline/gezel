import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// Stub the Squisq markdown editor — Monaco doesn't load in jsdom and we
// only care about wiring (file name, initial markdown, onChange) here.
vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    initialMarkdown,
    fileName,
    onChange,
    toolbarSlotAfterActions,
    toolbarSlotRight,
    statusBarSlotRight,
    workspaceContainer,
    mediaProvider,
    versionBasename,
  }: {
    initialMarkdown: string;
    fileName: string;
    onChange: (s: string) => void;
    toolbarSlotAfterActions?: React.ReactNode;
    toolbarSlotRight?: React.ReactNode;
    statusBarSlotRight?: React.ReactNode;
    workspaceContainer?: { root?: string } | null;
    mediaProvider?: { referencePrefix?: string } | null;
    versionBasename?: string;
  }) => (
    <div
      data-testid="editor-shell"
      data-file={fileName}
      data-container-root={workspaceContainer?.root}
      data-media-prefix={mediaProvider?.referencePrefix}
      data-version-basename={versionBasename}
    >
      <div data-testid="editor-initial">{initialMarkdown}</div>
      <button type="button" data-testid="editor-emit" onClick={() => onChange('edited content')}>
        emit-change
      </button>
      <button
        type="button"
        data-testid="editor-emit-newer"
        onClick={() => onChange('newer content')}
      >
        emit-newer-change
      </button>
      <div data-testid="editor-toolbar">{toolbarSlotAfterActions}</div>
      <div data-testid="editor-toolbar-right">{toolbarSlotRight}</div>
      <div data-testid="editor-status-bar-right">{statusBarSlotRight}</div>
    </div>
  ),
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

// The Export controls pull in `@bendyline/squisq-formats` and the
// player bundle from `@bendyline/squisq-react/standalone-source`,
// neither of which loads cleanly in jsdom (markdown→PDF/PPTX bundles
// touch DOMParser quirks and the standalone source ships a giant
// pre-bundled blob). Stub the barrel so DocumentDetail tests can
// exercise the load/save/AI wiring without dragging in real exporters.
vi.mock('../components/DocumentExport/index.js', () => ({
  ExportToolbarControls: () => <span data-testid="export-toolbar">export</span>,
}));
vi.mock('../components/DocumentNarration.js', () => ({
  DocumentNarration: () => <span data-testid="narration-toolbar">narrate</span>,
}));
vi.mock('../components/SquisqIntegration/index.js', () => ({
  createDocumentsContentContainer: (options: { root: string }) => ({ root: options.root }),
  createDocumentMediaProvider: (_container: unknown, referencePrefix: string) => ({
    referencePrefix,
    resolveUrl: async (path: string) => path,
    listMedia: async () => [],
    addMedia: async (name: string) => name,
    removeMedia: async () => {},
    dispose: () => {},
  }),
  createVersionCompatibleContentContainer: (container: unknown) => container,
  createArtifactsContentContainer: () => ({}),
  createDocumentLinkProvider: () => async () => [],
  deriveContainerScope: (p: string) => ({
    root: `${p.replace(/\.[^.]+$/, '')}_files`,
    parentDirectory: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '',
    companionName: `${(p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p).replace(/\.[^.]+$/, '')}_files`,
    primaryDocumentFilename: p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p,
  }),
  documentVersionBasename: (p: string) =>
    (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p).replace(/\.[^.]+$/, ''),
  resolveOutsideInLayout: (path: string) =>
    path.endsWith('.docx') ? { targetPath: path, format: 'docx' } : null,
  gezelProofingProvider: () => ({ kind: 'proofing-provider' }),
  useProofingCapability: () => ({ kind: 'proofing-provider' }),
  gezelProofingIgnoreStore: { load: () => undefined, save: () => {} },
}));

vi.mock('./OutsideInDocumentDetail.js', () => ({
  OutsideInDocumentDetail: ({ path }: { path: string }) => (
    <div data-testid="outside-in-document-detail">{path}</div>
  ),
}));

vi.mock('../components/transform/TransformToolbarButton.js', () => ({
  TransformToolbarButton: () => <span data-testid="ai-toolbar">ai</span>,
}));
vi.mock('../theme.js', () => ({
  useEffectiveTheme: () => 'dark',
}));

const { DocumentDetail } = await import('./DocumentDetail.js');
const { api } = await import('../api.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('DocumentDetail', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.readDocument).mockResolvedValue({ content: '# Mission\n\nStuff' } as never);
    vi.mocked(api.writeDocument).mockResolvedValue({ ok: true } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a loading placeholder while readDocument is in flight', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(api.readDocument).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as never,
    );
    render(<DocumentDetail path="mission.md" />);
    expect(screen.getByText(/Loading mission\.md/)).toBeInTheDocument();
    resolve({ content: '' });
  });

  it('mounts the editor with the loaded content and file name', async () => {
    render(<DocumentDetail path="mission.md" />);
    await waitFor(() => {
      expect(screen.getByTestId('editor-shell')).toBeInTheDocument();
    });
    expect(screen.getByTestId('editor-shell').getAttribute('data-file')).toBe('mission.md');
    expect(screen.getByTestId('editor-initial')).toHaveTextContent('# Mission');
    expect(document.querySelector('.document-detail-head')).not.toBeInTheDocument();
  });

  it('typing fires a debounced writeDocument after ~1s of idle', async () => {
    render(<DocumentDetail path="mission.md" />);
    await waitFor(() => {
      expect(screen.getByTestId('editor-shell')).toBeInTheDocument();
    });

    screen.getByTestId('editor-emit').click();
    expect(api.writeDocument).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1100);
    expect(api.writeDocument).toHaveBeenCalledWith('mission.md', 'edited content');
  });

  it('reports save state in the status bar, with unsaved changes as a bare dot', async () => {
    render(<DocumentDetail path="mission.md" />);
    await screen.findByTestId('editor-shell');

    screen.getByTestId('editor-emit').click();
    const status = await waitFor(() => {
      const el = screen.getByRole('status');
      expect(el).toHaveTextContent('Unsaved changes');
      return el;
    });
    expect(screen.getByTestId('editor-status-bar-right')).toContainElement(status);
    expect(screen.getByTestId('editor-toolbar-right')).not.toContainElement(status);
    expect(status.querySelector('.autosave-status-dot')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1100);
    await waitFor(() => expect(status).toHaveTextContent('Saved'));
  });

  it('keeps a failed draft visible and retries without another edit', async () => {
    vi.mocked(api.writeDocument).mockRejectedValueOnce(new Error('daemon unavailable'));
    render(<DocumentDetail path="mission.md" />);
    await screen.findByTestId('editor-shell');

    screen.getByTestId('editor-emit').click();
    await vi.advanceTimersByTimeAsync(1100);

    const failedChip = await screen.findByText('Save failed');
    expect(failedChip).toHaveAttribute('title', 'daemon unavailable');
    expect(screen.getByTestId('editor-shell')).toBeInTheDocument();

    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(api.writeDocument).toHaveBeenCalledTimes(2));
    expect(api.writeDocument).toHaveBeenLastCalledWith('mission.md', 'edited content');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('does not let an old-path completion affect saves for the newly selected path', async () => {
    vi.mocked(api.readDocument).mockImplementation(async (requestedPath) => ({
      path: requestedPath,
      content: requestedPath === 'first.md' ? '# First' : '# Second',
    }));
    const oldWrite = deferred<{ ok: true }>();
    vi.mocked(api.writeDocument)
      .mockReturnValueOnce(oldWrite.promise as never)
      .mockResolvedValue({ ok: true } as never);

    const { rerender } = render(<DocumentDetail path="first.md" />);
    await screen.findByText('# First');
    screen.getByTestId('editor-emit').click();
    await vi.advanceTimersByTimeAsync(1100);
    expect(api.writeDocument).toHaveBeenCalledWith('first.md', 'edited content');

    rerender(<DocumentDetail path="second.md" />);
    await screen.findByText('# Second');
    await act(async () => oldWrite.resolve({ ok: true }));

    screen.getByTestId('editor-emit').click();
    await vi.advanceTimersByTimeAsync(1100);
    await waitFor(() => expect(api.writeDocument).toHaveBeenCalledTimes(2));
    expect(api.writeDocument).toHaveBeenLastCalledWith('second.md', 'edited content');
  });

  it('rejoins the same keyed lane when a document is reopened during its cleanup save', async () => {
    vi.mocked(api.readDocument).mockImplementation(async (requestedPath) => ({
      path: requestedPath,
      content: requestedPath === 'first.md' ? '# First' : '# Second',
    }));
    const oldWrite = deferred<{ ok: true }>();
    vi.mocked(api.writeDocument)
      .mockReturnValueOnce(oldWrite.promise as never)
      .mockResolvedValue({ ok: true } as never);

    const { rerender } = render(<DocumentDetail path="first.md" />);
    await screen.findByText('# First');
    screen.getByTestId('editor-emit').click();
    await vi.advanceTimersByTimeAsync(1100);
    expect(api.writeDocument).toHaveBeenCalledTimes(1);

    rerender(<DocumentDetail path="second.md" />);
    await screen.findByText('# Second');
    rerender(<DocumentDetail path="first.md" />);
    // The reload response still contains the old server value, but the keyed
    // lane restores the newer local draft that is currently being written.
    await screen.findByText('edited content');
    screen.getByTestId('editor-emit-newer').click();
    await vi.advanceTimersByTimeAsync(1100);
    expect(api.writeDocument).toHaveBeenCalledTimes(1);

    await act(async () => oldWrite.resolve({ ok: true }));
    await waitFor(() => expect(api.writeDocument).toHaveBeenCalledTimes(2));
    expect(api.writeDocument).toHaveBeenLastCalledWith('first.md', 'newer content');
  });

  it('shows an error placeholder when readDocument rejects', async () => {
    vi.mocked(api.readDocument).mockRejectedValue(new Error('not found'));
    render(<DocumentDetail path="missing.md" />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't open/)).toBeInTheDocument();
    });
    expect(screen.getByText(/not found/)).toBeInTheDocument();
  });

  it('renders the AI transform button for markdown files but not for non-markdown', async () => {
    render(<DocumentDetail path="data.json" />);
    await waitFor(() => {
      expect(screen.getByTestId('editor-shell')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('ai-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('narration-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-toolbar')).not.toBeInTheDocument();
  });

  it('routes rendered Office files through the outside-in editor', async () => {
    render(<DocumentDetail path="brief.docx" />);
    expect(await screen.findByTestId('outside-in-document-detail')).toHaveTextContent('brief.docx');
    expect(api.readDocument).not.toHaveBeenCalled();
  });

  it('treats extensionless library documents as markdown and shows Export in the toolbar', async () => {
    render(<DocumentDetail path="test" />);
    await waitFor(() => {
      expect(screen.getByTestId('editor-shell')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ai-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('narration-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('export-toolbar')).toBeInTheDocument();
  });

  it('scopes each text document editor to its own companion directory', async () => {
    render(<DocumentDetail path="notes/diary.md" />);
    const editor = await screen.findByTestId('editor-shell');

    expect(editor).toHaveAttribute('data-container-root', 'notes/diary_files');
    expect(editor).toHaveAttribute('data-media-prefix', 'diary_files');
    expect(editor).toHaveAttribute('data-version-basename', 'diary');
  });
});
