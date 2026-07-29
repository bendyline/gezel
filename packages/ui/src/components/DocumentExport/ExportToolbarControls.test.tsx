import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = {
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
};
const runExportMock = vi.fn();
const resolveAudioMappingMock = vi.fn(async (doc: unknown, _container: unknown) => doc);

vi.mock('../../api.js', () => ({ api: apiMock }));
vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => ({ markdownSource: '# Current draft' }),
}));
vi.mock('@bendyline/squisq-react/standalone-source', () => ({
  PLAYER_BUNDLE: 'player-source',
}));
vi.mock('@bendyline/squisq-video-react', () => ({
  VideoExportModal: ({
    defaultConfig,
    colorScheme,
    mediaProvider,
  }: {
    defaultConfig: { outputFormat?: string; ffmpegWasm?: { coreURL?: string } };
    colorScheme: string;
    mediaProvider?: unknown;
  }) => (
    <div
      data-testid="video-export-modal"
      data-format={defaultConfig.outputFormat}
      data-has-ffmpeg={Boolean(defaultConfig.ffmpegWasm?.coreURL)}
      data-theme={colorScheme}
      data-has-media={Boolean(mediaProvider)}
    />
  ),
}));
vi.mock('@bendyline/squisq/doc', () => ({
  markdownToDoc: () => ({ blocks: [] }),
  resolveAudioMapping: (doc: unknown, container: unknown) =>
    resolveAudioMappingMock(doc, container),
}));
vi.mock('@bendyline/squisq/markdown', () => ({
  parseMarkdown: () => ({ children: [] }),
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
    resolveAudioMappingMock.mockClear();
  });

  it('renders an explicit Export button and offers document, video, and GIF actions', async () => {
    const user = userEvent.setup();
    render(
      <ExportToolbarControls
        selectedFile="notes/brief.md"
        mediaContainer={mediaContainer}
        colorScheme="dark"
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Export document' });
    expect(trigger).toHaveTextContent('Export');
    await user.click(trigger);

    expect(await screen.findByRole('menuitem', { name: 'Export…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export video…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export animated GIF…' })).toBeInTheDocument();
  });

  it('opens Squisq directly in its GIF preset with the offline runtime and Gezel theme', async () => {
    const user = userEvent.setup();
    render(
      <ExportToolbarControls
        selectedFile="notes/brief.md"
        mediaContainer={mediaContainer}
        colorScheme="dark"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Export document' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export animated GIF…' }));

    const modal = await screen.findByTestId('video-export-modal');
    expect(modal).toHaveAttribute('data-format', 'gif');
    expect(modal).toHaveAttribute('data-has-ffmpeg', 'true');
    expect(modal).toHaveAttribute('data-theme', 'dark');
    expect(modal).toHaveAttribute('data-has-media', 'true');
    expect(resolveAudioMappingMock).toHaveBeenCalledWith({ blocks: [] }, mediaContainer);
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
