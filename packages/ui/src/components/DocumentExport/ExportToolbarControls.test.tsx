import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: vi.fn(() => 'blob:document-media-export'),
});
Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  value: vi.fn(),
});

const apiMock = {
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  exportDocumentMedia: vi.fn(),
};
const runExportMock = vi.fn();

vi.mock('../../api.js', () => ({ api: apiMock }));
vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => ({ markdownSource: '# Current draft' }),
}));
vi.mock('@bendyline/squisq/schemas', () => ({
  getThemeSummaries: () => [{ id: 'standard', name: 'Standard', description: 'Standard theme' }],
}));
vi.mock('@bendyline/squisq/transform', () => ({
  getTransformStyleSummaries: () => [
    { id: 'documentary', name: 'Documentary', description: 'Documentary transform' },
  ],
}));
vi.mock('./run-export.js', () => ({
  runExport: (...args: unknown[]) => runExportMock(...args),
}));

const { DEFAULT_OPTIONS } = await import('./export-options.js');
const { ExportToolbarControls } = await import('./ExportToolbarControls.js');

const mediaContainer = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  removeFile: vi.fn(),
  listFiles: vi.fn(async () => []),
  exists: vi.fn(),
  getDocumentPath: vi.fn(),
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
};

describe('ExportToolbarControls', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.getConfig.mockReset();
    apiMock.getConfig.mockResolvedValue({});
    apiMock.updateConfig.mockReset();
    apiMock.updateConfig.mockResolvedValue({});
    runExportMock.mockReset();
    runExportMock.mockResolvedValue(undefined);
    apiMock.exportDocumentMedia.mockReset();
    apiMock.exportDocumentMedia.mockResolvedValue(new Blob(['native-media']));
  });

  it('offers document, video, and GIF actions for a Store-backed document', async () => {
    const user = userEvent.setup();
    render(
      <ExportToolbarControls
        selectedFile="notes/brief.md"
        mediaContainer={mediaContainer}
        mediaSource={{ kind: 'documents' }}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Export document' });
    expect(trigger).toHaveTextContent('Export');
    await user.click(trigger);

    expect(await screen.findByRole('menuitem', { name: 'Export…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export video…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export animated GIF…' })).toBeInTheDocument();
  });

  it('routes GIF export through the daemon native renderer', async () => {
    const user = userEvent.setup();
    render(
      <ExportToolbarControls
        selectedFile="notes/brief.md"
        mediaContainer={mediaContainer}
        mediaSource={{ kind: 'documents' }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Export document' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export animated GIF…' }));

    await waitFor(() =>
      expect(apiMock.exportDocumentMedia).toHaveBeenCalledWith(
        {
          markdown: '# Current draft',
          selectedFile: 'notes/brief.md',
          format: 'gif',
          source: { kind: 'documents' },
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it('shows and runs the last document export as a one-click quick action', async () => {
    const user = userEvent.setup();
    const saved = { ...DEFAULT_OPTIONS, format: 'docx' as const };
    localStorage.setItem('gezel-export-options', JSON.stringify(saved));

    render(<ExportToolbarControls selectedFile="notes/brief.md" mediaContainer={mediaContainer} />);

    await user.click(screen.getByRole('button', { name: 'Export document' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export DOCX' }));

    await waitFor(() =>
      expect(runExportMock).toHaveBeenCalledWith(
        '# Current draft',
        'notes/brief.md',
        saved,
        mediaContainer,
      ),
    );
  });

  it('persists dialog choices before exporting', async () => {
    const user = userEvent.setup();
    render(<ExportToolbarControls selectedFile="notes/brief.md" mediaContainer={mediaContainer} />);

    await user.click(screen.getByRole('button', { name: 'Export document' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export…' }));
    expect(screen.getByRole('radio', { name: 'PowerPoint' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Word' }));
    await user.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() =>
      expect(apiMock.updateConfig).toHaveBeenCalledWith({
        documentExportOptions: { ...DEFAULT_OPTIONS, format: 'docx' },
      }),
    );
    expect(runExportMock).toHaveBeenCalledWith(
      '# Current draft',
      'notes/brief.md',
      { ...DEFAULT_OPTIONS, format: 'docx' },
      mediaContainer,
    );
  });
});
