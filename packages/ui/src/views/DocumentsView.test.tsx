import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../components/FileTree.js';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
// `useEffectiveTheme` subscribes to `window.matchMedia`, which jsdom doesn't
// implement — stub it (same as the DocumentDetail / ProjectsView specs).
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

// FileTree is its own component with recursive rendering — mock it as
// a flat list with click + delete buttons so we can drive selection
// and deletion without exercising the tree internals.
vi.mock('../components/FileTree.js', () => ({
  // FileFlatList (the flat view modes) imports this from the same module.
  defaultIconFor: () => null,
  FileTree: ({
    entries,
    onSelect,
    onRename,
    onDelete,
  }: {
    entries: FileEntry[];
    onSelect: (e: FileEntry) => void;
    onRename: (e: FileEntry) => void;
    onDelete: (e: FileEntry) => void;
  }) => (
    <ul data-testid="file-tree">
      {entries.map((e) => (
        <li key={e.path}>
          <button type="button" onClick={() => onSelect(e)} data-testid={`select-${e.path}`}>
            {e.path}
          </button>
          <button type="button" onClick={() => onDelete(e)} data-testid={`delete-${e.path}`}>
            delete
          </button>
          <button type="button" onClick={() => onRename(e)} data-testid={`rename-${e.path}`}>
            rename
          </button>
        </li>
      ))}
    </ul>
  ),
}));

// ConfirmDialog renders a couple of buttons; we render a simplified
// version that exposes the message + confirm/cancel actions.
vi.mock('../components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="confirm-dialog">
        <h3>{title}</h3>
        <p>{message}</p>
        <button type="button" onClick={onConfirm} data-testid="confirm">
          Confirm
        </button>
        <button type="button" onClick={onCancel} data-testid="cancel">
          Cancel
        </button>
      </div>
    );
  },
}));

// DocumentDetail is mocked because it pulls in the squisq markdown
// editor (Monaco) — we'd rather assert "the right pane was asked to
// render document X" than mount Monaco in jsdom.
vi.mock('./DocumentDetail.js', () => ({
  DocumentDetail: ({ path }: { path: string }) => <div data-testid="document-detail">{path}</div>,
}));

// FolderView comes from the squisq editor-react barrel, which ships a giant
// pre-bundled editor blob we don't want in jsdom. Stub it as a flat list of
// its entries plus the New document / New folder actions so we can assert the
// right pane and drive folder navigation + creation.
vi.mock('@bendyline/squisq-editor-react', () => ({
  FolderView: ({
    name,
    entries,
    onOpenFile,
    onOpenFolder,
    onNewDocument,
    onNewFolder,
  }: {
    name: string;
    entries: FileEntry[];
    onOpenFile: (e: FileEntry) => void;
    onOpenFolder: (e: FileEntry) => void;
    onNewDocument: () => void;
    onNewFolder: () => void;
  }) => (
    <div data-testid="folder-view">
      <span data-testid="folder-view-name">{name}</span>
      <ul>
        {entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              data-testid={`fv-open-${e.path}`}
              onClick={() => (e.isDirectory ? onOpenFolder(e) : onOpenFile(e))}
            >
              {e.path}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" data-testid="fv-new-doc" onClick={onNewDocument}>
        New document
      </button>
      <button type="button" data-testid="fv-new-folder" onClick={onNewFolder}>
        New folder
      </button>
    </div>
  ),
}));

const { DocumentsView } = await import('./DocumentsView.js');
const { api } = await import('../api.js');

const FAKE_ENTRIES: FileEntry[] = [
  { path: 'guidelines/coding.md', name: 'coding.md', isDirectory: false },
  { path: 'guidelines', name: 'guidelines', isDirectory: true },
  { path: 'mission.md', name: 'mission.md', isDirectory: false },
];

describe('DocumentsView', () => {
  beforeEach(() => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: [] } as never);
    vi.mocked(api.deleteDocument).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.writeDocument).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.createDocumentFolder).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.renameDocument).mockResolvedValue({ ok: true } as never);
    // Reset localStorage between tests so a stale selectedPath from a
    // prior test doesn't leak in.
    window.localStorage.clear();
  });

  it('renders the empty-state hint when no documents exist', async () => {
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByText(/No documents yet/)).toBeInTheDocument();
    });
    expect(api.listDocuments).toHaveBeenCalledWith('', true, { stats: true, hidden: false });
    expect(screen.queryByTestId('file-tree')).not.toBeInTheDocument();
  });

  it('is the shared file browser: view modes, hidden key, resize grip, and Open', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await screen.findByTestId('file-tree');

    const tray = screen.getByRole('radiogroup', { name: 'File list view' });
    // Three modes — the library carries no review issues, like Artifacts.
    expect(within(tray).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('separator', { name: 'Resize documents files' })).toBeInTheDocument();
    // The reveal action lives in the toolbar row beside the mode keys.
    expect(screen.getByRole('button', { name: 'Open in file manager' })).toHaveAttribute(
      'title',
      'Open in file manager',
    );

    fireEvent.click(within(tray).getByRole('radio', { name: 'All files by last modified' }));
    expect(window.localStorage.getItem('gezel.documentsFilesView')).toBe('flat-modified');

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }));
    await waitFor(() => {
      expect(api.listDocuments).toHaveBeenLastCalledWith('', true, { stats: true, hidden: true });
    });
    expect(window.localStorage.getItem('gezel.documentsFilesHidden')).toBe('1');
  });

  it('renders the file tree when documents come back', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });
    // getAllByText: the first file auto-selects, so its path renders in the
    // tree row AND the detail pane.
    expect(screen.getAllByText('guidelines/coding.md').length).toBeGreaterThan(0);
    expect(screen.getByText('mission.md')).toBeInTheDocument();
  });

  it('hides managed outside-in companion folders from the document tree', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [
        { path: 'brief.docx', name: 'brief.docx', isDirectory: false },
        { path: 'brief_files', name: 'brief_files', isDirectory: true },
        { path: 'brief_files/brief.md', name: 'brief.md', isDirectory: false },
      ],
    } as never);
    render(<DocumentsView />);

    await screen.findByTestId('file-tree');
    expect(screen.getAllByText('brief.docx').length).toBeGreaterThan(0);
    expect(screen.queryByText('brief_files')).not.toBeInTheDocument();
    expect(screen.queryByText('brief_files/brief.md')).not.toBeInTheDocument();
  });

  it('imports a dropped Markdown file from the left tree without overwriting an existing name', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [{ path: 'notes.md', name: 'notes.md', isDirectory: false }],
    } as never);
    const { container } = render(<DocumentsView />);
    await screen.findByTestId('file-tree');
    const treePane = container.querySelector('.file-tree-panel');
    expect(treePane).not.toBeNull();
    const file = new File(['# Dropped'], 'notes.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', { value: vi.fn(async () => '# Dropped') });
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' };

    fireEvent.dragEnter(treePane!, { dataTransfer });
    expect(screen.getByText('Drop to add to Documents')).toBeInTheDocument();
    fireEvent.drop(treePane!, { dataTransfer });

    await waitFor(() => {
      expect(api.writeDocument).toHaveBeenCalledWith('notes 2.md', '# Dropped');
    });
    expect(window.localStorage.getItem('gezel:documents:selectedPath')).toBe('notes 2.md');
  });

  it('drops into the selected folder when a file lands in the main pane', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    window.localStorage.setItem('gezel:documents:selectedPath', 'guidelines');
    const { container } = render(<DocumentsView />);
    await screen.findByTestId('folder-view');
    const detailPane = container.querySelector('.file-viewer-panel');
    expect(detailPane).not.toBeNull();
    const file = new File(['# Brief'], 'brief.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', { value: vi.fn(async () => '# Brief') });
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' };

    fireEvent.dragEnter(detailPane!, { dataTransfer });
    expect(screen.getByText('Drop to add to guidelines')).toBeInTheDocument();
    fireEvent.drop(detailPane!, { dataTransfer });

    await waitFor(() => {
      expect(api.writeDocument).toHaveBeenCalledWith('guidelines/brief.md', '# Brief');
    });
  });

  it('selecting a document populates the detail pane and persists in localStorage', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('select-mission.md'));

    await waitFor(() => {
      expect(screen.getByTestId('document-detail')).toBeInTheDocument();
    });
    expect(screen.getByTestId('document-detail')).toHaveTextContent('mission.md');
    expect(window.localStorage.getItem('gezel:documents:selectedPath')).toBe('mission.md');
  });

  it('selecting a directory shows the folder view with its contents', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('select-guidelines'));

    await waitFor(() => {
      expect(screen.getByTestId('folder-view')).toBeInTheDocument();
    });
    // The folder name and its one child are shown; the document editor is not.
    expect(screen.getByTestId('folder-view-name')).toHaveTextContent('guidelines');
    expect(screen.getByTestId('fv-open-guidelines/coding.md')).toBeInTheDocument();
    expect(screen.queryByTestId('document-detail')).not.toBeInTheDocument();
  });

  it('the folder view New document button opens the dialog prefilled with the folder path', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('select-guidelines'));
    await waitFor(() => {
      expect(screen.getByTestId('folder-view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('fv-new-doc'));

    const pathInput = await screen.findByPlaceholderText('e.g. guidelines/coding');
    expect(pathInput).toHaveValue('guidelines/');
    expect(screen.getByText('.md')).toBeInTheDocument();
  });

  it('renders right-aligned Font Awesome creation actions', async () => {
    render(<DocumentsView />);
    await waitFor(() => {
      expect(api.listDocuments).toHaveBeenCalledTimes(1);
    });

    const folderButton = screen.getByRole('button', { name: 'New folder' });
    const documentButton = screen.getByRole('button', { name: 'New document' });
    expect(folderButton.parentElement).toHaveClass('file-create-tray');
    expect(folderButton.querySelector('i')).toHaveClass('fa-solid', 'fa-folder-plus');
    expect(documentButton.querySelector('i')).toHaveClass('fa-solid', 'fa-file-circle-plus');
  });

  it('clicking New document opens a dialog; submitting calls writeDocument and refreshes', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: [] } as never);
    render(<DocumentsView />);
    await waitFor(() => {
      expect(api.listDocuments).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New document' }));

    // The new-doc dialog renders a Path input.
    const pathInput = screen.getByPlaceholderText('e.g. guidelines/coding');
    await user.type(pathInput, 'newdoc');

    // After typing, the second listDocuments queues up. The next
    // listDocuments call should also include the freshly written doc.
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [{ path: 'newdoc.md', name: 'newdoc.md', isDirectory: false } as FileEntry],
    } as never);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(api.writeDocument).toHaveBeenCalledWith('newdoc.md', '');
    });
    await waitFor(() => {
      // Initial mount + post-create refresh = 2 calls.
      expect(api.listDocuments).toHaveBeenCalledTimes(2);
    });
    // The newly-created doc is auto-selected.
    await waitFor(() => {
      expect(window.localStorage.getItem('gezel:documents:selectedPath')).toBe('newdoc.md');
    });
  });

  it('deleting a document confirms first, then calls deleteDocument and refreshes', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('delete-mission.md'));

    // Confirmation dialog appears with the doc path in the message.
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('mission.md');

    fireEvent.click(screen.getByTestId('confirm'));

    await waitFor(() => {
      expect(api.deleteDocument).toHaveBeenCalledWith('mission.md');
    });
    // Dialog closes after delete completes.
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  it('renames a Markdown document in place and preserves the selected document', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    window.localStorage.setItem('gezel:documents:selectedPath', 'mission.md');
    render(<DocumentsView />);
    await screen.findByTestId('document-detail');

    fireEvent.click(screen.getByTestId('rename-mission.md'));

    const nameInput = await screen.findByRole('textbox', { name: 'Name' });
    expect(nameInput).toHaveValue('mission');
    expect(screen.getByText('.md')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.clear(nameInput);
    await user.type(nameInput, 'brief');
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [
        ...FAKE_ENTRIES.filter((entry) => entry.path !== 'mission.md'),
        { path: 'brief.md', name: 'brief.md', isDirectory: false },
      ],
    } as never);
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(api.renameDocument).toHaveBeenCalledWith('mission.md', 'brief.md');
    });
    await waitFor(() => {
      expect(window.localStorage.getItem('gezel:documents:selectedPath')).toBe('brief.md');
    });
  });

  it('cancelling the delete dialog does NOT call deleteDocument', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('delete-mission.md'));
    await screen.findByTestId('confirm-dialog');

    fireEvent.click(screen.getByTestId('cancel'));

    expect(api.deleteDocument).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  it('deleting the currently-selected document clears the detail pane', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    window.localStorage.setItem('gezel:documents:selectedPath', 'mission.md');
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('document-detail')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('delete-mission.md'));
    await screen.findByTestId('confirm-dialog');

    // After confirm, the post-delete state should clear the detail pane
    // even before the refresh response arrives. Make refresh return an
    // empty list so we know the entry is gone.
    vi.mocked(api.listDocuments).mockResolvedValue({ files: [] } as never);
    fireEvent.click(screen.getByTestId('confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('document-detail')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem('gezel:documents:selectedPath')).toBeNull();
  });

  it('shows a status message when deleteDocument throws', async () => {
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    vi.mocked(api.deleteDocument).mockRejectedValue(new Error('permission denied'));
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByTestId('file-tree')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('delete-mission.md'));
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm'));

    await waitFor(() => {
      expect(screen.getByText(/delete failed: permission denied/)).toBeInTheDocument();
    });
  });

  it('shows the listDocuments error in an error chip', async () => {
    vi.mocked(api.listDocuments).mockRejectedValue(new Error('connection refused'));
    render(<DocumentsView />);
    await waitFor(() => {
      expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    });
  });

  it('searches document contents and lists the matches', async () => {
    // The tree answers "where did I file it"; this answers "which document
    // says this" — the question a growing library makes hard.
    vi.mocked(api.searchDocuments).mockResolvedValue({
      results: [{ path: 'policies/refunds.md', lineStart: 4, snippet: 'refunded within 30 days' }],
      engine: 'hybrid',
    } as never);
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => expect(screen.getByTestId('file-tree')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search document contents'), {
      target: { value: 'refund' },
    });

    await waitFor(() => {
      expect(screen.getByText('refunded within 30 days')).toBeInTheDocument();
    });
    expect(vi.mocked(api.searchDocuments)).toHaveBeenCalledWith({ q: 'refund' });
  });

  it('says so plainly when nothing in the library matches', async () => {
    vi.mocked(api.searchDocuments).mockResolvedValue({ results: [], engine: 'hybrid' } as never);
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => expect(screen.getByTestId('file-tree')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search document contents'), {
      target: { value: 'nothing here' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Nothing in the library mentions/)).toBeInTheDocument();
    });
  });

  it('restores the tree when the search box is cleared', async () => {
    vi.mocked(api.searchDocuments).mockResolvedValue({ results: [], engine: 'hybrid' } as never);
    vi.mocked(api.listDocuments).mockResolvedValue({ files: FAKE_ENTRIES } as never);
    render(<DocumentsView />);
    await waitFor(() => expect(screen.getByTestId('file-tree')).toBeInTheDocument());
    const box = screen.getByLabelText('Search document contents');

    fireEvent.change(box, { target: { value: 'refund' } });
    await waitFor(() => {
      expect(screen.getByText(/Nothing in the library mentions/)).toBeInTheDocument();
    });

    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.queryByText(/Nothing in the library mentions/)).not.toBeInTheDocument();
    });
  });
});
