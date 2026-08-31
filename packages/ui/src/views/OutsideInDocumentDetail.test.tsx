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
  }: {
    initialMarkdown: string;
    fileName: string;
    readOnly?: boolean;
    onChange?: (value: string) => void;
    toolbarSlotAfterActions?: React.ReactNode;
    statusBarSlotRight?: React.ReactNode;
  }) => (
    <div data-testid="editor-shell" data-file={fileName} data-readonly={String(Boolean(readOnly))}>
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
  createDocumentLinkProvider: () => async () => [],
  createDocumentsContentContainer: () => outsideInMocks.documentContainer,
  importOutsideInDocument: outsideInMocks.importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled: (content: string) => content.includes('editable: true'),
  relativePath: () => '../_squisq/squisq-player.js',
  renderOutsideInDocument: outsideInMocks.renderOutsideInDocument,
  runtimePathForTarget: () => '_squisq/squisq-player.js',
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
    expect(editor).toHaveAttribute('data-file', 'brief.docx');
    expect(editor).toHaveAttribute('data-readonly', 'false');

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

    expect(await screen.findByTestId('editor-shell')).toHaveAttribute('data-readonly', 'true');
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
});
