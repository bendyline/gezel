import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const outsideInMocks = vi.hoisted(() => ({
  chooseOutsideInSource: vi.fn(),
  documentContainer: {
    writeDocument: vi.fn(),
    writeFile: vi.fn(),
  },
  importContainer: {
    listFiles: vi.fn(),
    readFile: vi.fn(),
  },
  importOutsideInDocument: vi.fn(),
  renderOutsideInDocument: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({
    initialMarkdown,
    fileName,
    readOnly,
    onChange,
    toolbarSlotAfterActions,
    statusBarSlotRight,
    calcEngineFactory,
    mediaProvider,
    initialView,
  }: {
    initialMarkdown: string;
    fileName: string;
    readOnly?: boolean;
    onChange?: (value: string) => void;
    toolbarSlotAfterActions?: React.ReactNode;
    statusBarSlotRight?: React.ReactNode;
    calcEngineFactory?: unknown;
    mediaProvider?: unknown;
    initialView?: string;
  }) => (
    <div
      data-testid="editor-shell"
      data-file={fileName}
      data-readonly={String(Boolean(readOnly))}
      data-calc-engine={typeof calcEngineFactory === 'function'}
      data-media-provider={String(Boolean(mediaProvider))}
      data-initial-view={initialView}
    >
      <span>{initialMarkdown}</span>
      <button type="button" data-testid="edit" onClick={() => onChange?.('# Edited')}>
        Edit
      </button>
      <div>{toolbarSlotAfterActions}</div>
      <div>{statusBarSlotRight}</div>
    </div>
  ),
}));
vi.mock('../components/SquisqIntegration/index.js', () => ({
  chooseOutsideInSource: outsideInMocks.chooseOutsideInSource,
  createDataReferenceContainer: (container: unknown) => container,
  createDocumentLinkProvider: () => async () => [],
  createDocumentsContentContainer: () => outsideInMocks.documentContainer,
  createVersionCompatibleContentContainer: (container: unknown) => container,
  documentVersionBasename: (path: string) => path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''),
  importOutsideInDocument: outsideInMocks.importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled: (content: string) => content.includes('editable: true'),
  relativePath: () => '../_squisq/squisq-player.js',
  renderOutsideInDocument: outsideInMocks.renderOutsideInDocument,
  runtimePathForTarget: () => '_squisq/squisq-player.js',
  supportsOutsideInMarkdownEditing: (format: string) => format !== 'csv',
  withOutsideInMarkdownEditing: (content: string) => `${content}\neditable: true`,
  withOutsideInMetadata: (content: string) => content,
  gezelProofingProvider: () => ({ kind: 'proofing-provider' }),
  useProofingCapability: () => ({ kind: 'proofing-provider' }),
  gezelProofingIgnoreStore: { load: () => undefined, save: () => {} },
}));
vi.mock('../components/transform/TransformToolbarButton.js', () => ({
  TransformToolbarButton: () => <span>transform</span>,
}));
vi.mock('../components/DocumentNarration.js', () => ({
  DocumentNarration: () => <span>narrate</span>,
}));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

const { OutsideInDocumentDetail } = await import('./OutsideInDocumentDetail.js');
const { api } = await import('../api.js');
const { renderOutsideInDocument } = await import('../components/SquisqIntegration/index.js');

const LAYOUT = {
  targetPath: 'brief.docx',
  format: 'docx',
  parentDirectory: '',
  stem: 'brief',
  companionName: 'brief_files',
  companionDirectory: 'brief_files',
  markdownFilename: 'brief.md',
  markdownPath: 'brief_files/brief.md',
  relativeTargetPath: '../brief.docx',
  backupDirectory: 'brief_files/.original',
  backupFilename: 'original.docx',
  backupPath: 'brief_files/.original/original.docx',
} as const;

const CSV_LAYOUT = {
  targetPath: 'pg_catalog.csv',
  format: 'csv',
  parentDirectory: '',
  stem: 'pg_catalog',
  companionName: 'pg_catalog_files',
  companionDirectory: 'pg_catalog_files',
  markdownFilename: 'pg-catalog.md',
  markdownPath: 'pg_catalog_files/pg-catalog.md',
  relativeTargetPath: '../pg_catalog.csv',
  backupDirectory: 'pg_catalog_files/.original',
  backupFilename: 'original.csv',
  backupPath: 'pg_catalog_files/.original/original.csv',
} as const;

describe('OutsideInDocumentDetail', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    outsideInMocks.chooseOutsideInSource.mockReturnValue('brief_files/brief.md');
    outsideInMocks.importContainer.listFiles.mockResolvedValue([]);
    outsideInMocks.importContainer.readFile.mockResolvedValue(null);
    outsideInMocks.importOutsideInDocument.mockResolvedValue({
      markdown: '# Imported brief',
      container: outsideInMocks.importContainer,
      warnings: [],
    });
    outsideInMocks.renderOutsideInDocument.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [
        { path: 'brief.docx', name: 'brief.docx', isDirectory: false },
        { path: 'brief_files/brief.md', name: 'brief.md', isDirectory: false },
      ],
    } as never);
    vi.mocked(api.readDocument).mockResolvedValue({
      path: LAYOUT.markdownPath,
      content: '# Brief\neditable: true',
    } as never);
    vi.mocked(api.writeDocument).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.writeDocumentBinary).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.fetchDocumentBlob).mockResolvedValue(
      new Blob(['original'], { type: 'application/octet-stream' }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('edits the Markdown companion and regenerates the visible DOCX on autosave', async () => {
    render(<OutsideInDocumentDetail path="brief.docx" layout={LAYOUT} />);
    const editor = await screen.findByTestId('editor-shell');
    expect(editor).toHaveAttribute('data-file', LAYOUT.markdownPath);
    expect(editor).toHaveAttribute('data-initial-view', 'wysiwyg');
    expect(editor).toHaveAttribute('data-readonly', 'false');
    expect(editor).toHaveAttribute('data-calc-engine', 'true');
    expect(editor).toHaveAttribute('data-media-provider', 'true');

    screen.getByTestId('edit').click();
    await vi.advanceTimersByTimeAsync(1100);

    await waitFor(() => expect(renderOutsideInDocument).toHaveBeenCalled());
    expect(api.writeDocument).toHaveBeenCalledWith('brief_files/brief.md', '# Edited');
    expect(api.writeDocumentBinary).toHaveBeenCalledWith(
      'brief.docx',
      new Uint8Array([1, 2, 3]),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('keeps pre-existing rendered documents read-only until the user enables Markdown editing', async () => {
    vi.mocked(api.readDocument).mockResolvedValue({
      path: LAYOUT.markdownPath,
      content: '# Brief',
    } as never);
    render(<OutsideInDocumentDetail path="brief.docx" layout={LAYOUT} />);

    const editor = await screen.findByTestId('editor-shell');
    expect(editor).toHaveAttribute('data-readonly', 'true');
    expect(editor).toHaveAttribute('data-calc-engine', 'false');
    expect(screen.getByText('DOCX preview · read-only.')).toBeInTheDocument();
    expect(screen.getByText('narrate')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Enable editing' }).click();

    await waitFor(() => {
      expect(api.writeDocumentBinary).toHaveBeenCalledWith(
        LAYOUT.backupPath,
        expect.any(Blob),
        'application/octet-stream',
      );
    });
    expect(api.writeDocument).toHaveBeenCalledWith(
      LAYOUT.markdownPath,
      expect.stringContaining('editable: true'),
    );
    await waitFor(() => {
      expect(screen.getByTestId('editor-shell')).toHaveAttribute('data-readonly', 'false');
    });
  });

  it('imports a newly dropped DOCX as a read-only companion without duplicating the package', async () => {
    outsideInMocks.chooseOutsideInSource.mockReturnValue(null);
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [{ path: 'brief.docx', name: 'brief.docx', isDirectory: false }],
    } as never);
    outsideInMocks.importContainer.listFiles.mockResolvedValue([
      {
        path: 'brief.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { path: 'media/image.png', mimeType: 'image/png' },
    ]);
    outsideInMocks.importContainer.readFile.mockResolvedValue(new Uint8Array([9, 8, 7]));

    render(<OutsideInDocumentDetail path="brief.docx" layout={LAYOUT} />);

    expect(await screen.findByTestId('editor-shell')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByText('# Imported brief')).toBeInTheDocument();
    expect(api.fetchDocumentBlob).toHaveBeenCalledWith('brief.docx');
    expect(outsideInMocks.documentContainer.writeFile).toHaveBeenCalledTimes(1);
    expect(outsideInMocks.documentContainer.writeFile).toHaveBeenCalledWith(
      'media/image.png',
      new Uint8Array([9, 8, 7]),
      'image/png',
    );
    expect(outsideInMocks.documentContainer.writeDocument).toHaveBeenCalledWith(
      '# Imported brief',
      'brief.md',
    );
    expect(api.writeDocumentBinary).not.toHaveBeenCalled();
  });

  it('opens a large CSV through its retained data sidecar without offering lossy editing', async () => {
    outsideInMocks.chooseOutsideInSource.mockReturnValue(null);
    vi.mocked(api.listDocuments).mockResolvedValue({
      files: [{ path: 'pg_catalog.csv', name: 'pg_catalog.csv', isDirectory: false }],
    } as never);
    outsideInMocks.importOutsideInDocument.mockResolvedValue({
      markdown:
        '# pg_catalog {[dataTable src=pg-catalog_files/data/pg_catalog.csv]}\n\n[pg_catalog.csv](pg-catalog_files/data/pg_catalog.csv)\n',
      container: outsideInMocks.importContainer,
      warnings: [],
    });
    outsideInMocks.importContainer.listFiles.mockResolvedValue([
      { path: 'pg-catalog.md', mimeType: 'text/markdown' },
      { path: 'pg-catalog_files/data/pg_catalog.csv', mimeType: 'text/csv' },
    ]);
    outsideInMocks.importContainer.readFile.mockResolvedValue(
      new TextEncoder().encode('id,title\n1,Declaration\n'),
    );

    render(<OutsideInDocumentDetail path="pg_catalog.csv" layout={CSV_LAYOUT} />);

    const editor = await screen.findByTestId('editor-shell');
    expect(editor).toHaveAttribute('data-readonly', 'true');
    expect(editor).toHaveAttribute('data-media-provider', 'true');
    expect(editor).toHaveAttribute('data-file', CSV_LAYOUT.markdownPath);
    expect(editor).toHaveAttribute('data-initial-view', 'wysiwyg');
    expect(screen.getByText('CSV data preview · source preserved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable editing' })).not.toBeInTheDocument();
    expect(outsideInMocks.documentContainer.writeFile).toHaveBeenCalledWith(
      'pg-catalog_files/data/pg_catalog.csv',
      new TextEncoder().encode('id,title\n1,Declaration\n'),
      'text/csv',
    );
  });
});
