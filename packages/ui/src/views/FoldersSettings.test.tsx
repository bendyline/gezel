import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    message?: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="confirm-dialog">
        <h3>{title}</h3>
        {message}
        <button type="button" onClick={onConfirm} data-testid="confirm">
          {confirmLabel ?? 'Confirm'}
        </button>
        <button type="button" onClick={onCancel} data-testid="cancel">
          Cancel
        </button>
      </div>
    );
  },
}));

const { FoldersSettings } = await import('./FoldersSettings.js');
const { api } = await import('../api.js');

const STATUS = {
  current: {
    documents: '/home/u/.gezel/documents',
    gezels: '/home/u/.gezel/gezels',
    projects: '/home/u/.gezel/projects',
  },
  defaults: {
    documents: '/home/u/.gezel/documents',
    gezels: '/home/u/.gezel/gezels',
    projects: '/home/u/.gezel/projects',
  },
  externalized: { documents: null, gezels: null, projects: null },
  backups: { count: 0, totalBytes: 0, path: '/home/u/.gezel/backup', snapshots: [] },
  activeJob: false,
};

describe('FoldersSettings', () => {
  beforeEach(() => {
    vi.mocked(api.getFolders).mockResolvedValue(STATUS as never);
    vi.mocked(api.planFolderMove).mockResolvedValue({
      sourcePath: '/home/u/.gezel/documents',
      files: 42,
      bytes: 12345,
      conflicts: 0,
      validation: { ok: true },
    } as never);
    vi.mocked(api.startFolderMove).mockResolvedValue({ jobId: 'job-1' } as never);
    vi.mocked(api.resetFolder).mockResolvedValue({ jobId: 'job-2' } as never);

    // Wire window.__GEZEL__.selectDirectory to a mockable shim.
    (window as unknown as { __GEZEL__: Record<string, unknown> }).__GEZEL__ = {
      ...(window as unknown as { __GEZEL__: Record<string, unknown> }).__GEZEL__,
      platform: 'linux',
      selectDirectory: vi.fn().mockResolvedValue('/mnt/onedrive/gezel-docs'),
      restartService: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  afterEach(() => {
    const bridge = (
      window as unknown as {
        __GEZEL__: { selectDirectory?: unknown; openPath?: unknown };
      }
    ).__GEZEL__;
    delete bridge?.selectDirectory;
    delete bridge?.openPath;
  });

  it('renders a Loading… placeholder before the status arrives', async () => {
    let resolveStatus!: (s: unknown) => void;
    vi.mocked(api.getFolders).mockReturnValue(
      new Promise((r) => {
        resolveStatus = r;
      }) as never,
    );
    render(<FoldersSettings />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    resolveStatus(STATUS);
  });

  it('renders three scope rows with their default-location markers', async () => {
    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Documents library/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Gezellen$/)).toBeInTheDocument();
    expect(screen.getByText(/Projects \(artifacts/)).toBeInTheDocument();
    // Each row should have a Move button.
    expect(screen.getAllByRole('button', { name: /Move to other folder/ })).toHaveLength(3);
  });

  it.each([
    ['darwin', 'Open in Finder'],
    ['win32', 'Open in File Explorer'],
    ['linux', 'Open in file manager'],
  ])('labels and opens scope folders using the %s file browser name', async (platform, label) => {
    const openPath = vi.fn().mockResolvedValue(undefined);
    window.__GEZEL__ = {
      ...window.__GEZEL__,
      token: window.__GEZEL__?.token ?? 'test-token',
      platform,
      openPath,
    };

    render(<FoldersSettings />);

    const buttons = await screen.findAllByRole('button', { name: label });
    expect(buttons).toHaveLength(3);
    await userEvent.click(buttons[0]!);
    expect(openPath).toHaveBeenCalledWith('/home/u/.gezel/documents');
  });

  it('clicking Move calls planFolderMove and opens the confirm dialog', async () => {
    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Documents library/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /Move to other folder/ })[0]!);

    await waitFor(() => {
      expect(api.planFolderMove).toHaveBeenCalledWith({
        scope: 'documents',
        destPath: '/mnt/onedrive/gezel-docs',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });
    expect(
      within(screen.getByTestId('confirm-dialog')).getByText(/Move 42 files/),
    ).toBeInTheDocument();
  });

  it('confirming a move calls startFolderMove with the picked policy', async () => {
    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Documents library/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /Move to other folder/ })[0]!);
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('confirm'));

    await waitFor(() => {
      expect(api.startFolderMove).toHaveBeenCalledWith({
        scope: 'documents',
        destPath: '/mnt/onedrive/gezel-docs',
        conflictPolicy: 'overwrite-all',
      });
    });
    // Dialog closes after the move kicks off.
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });

    const progress = document.querySelector<HTMLElement>('.folders-progress .ollama-pull-bar');
    expect(progress).not.toBeNull();
    expect(progress).toHaveClass('ollama-pull-bar-indeterminate');
    const progressCard = progress!.closest('.folders-progress');
    const folderRows = document.querySelector('.folders-rows');
    expect(progressCard).not.toBeNull();
    expect(folderRows).not.toBeNull();
    expect(
      progressCard!.compareDocumentPosition(folderRows!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('restores a completed move, shows its new path, and offers the required restart', async () => {
    vi.mocked(api.getFolders).mockResolvedValue({
      ...STATUS,
      job: {
        id: 'job-complete',
        scope: 'documents',
        sourcePath: STATUS.current.documents,
        destPath: '/mnt/onedrive/gezel-docs',
        conflictPolicy: 'overwrite-all',
        status: 'done',
        phase: 'prune',
        filesDone: 42,
        totalFiles: 42,
        bytesDone: 12345,
        totalBytes: 12345,
        restartRequired: true,
        startedAt: '2026-09-08T18:59:00.000Z',
        endedAt: '2026-09-08T18:59:47.000Z',
      },
    } as never);

    render(<FoldersSettings />);

    expect(await screen.findByText('Move complete')).toBeInTheDocument();
    const documentsRow = screen.getByText('Documents library').closest<HTMLElement>('.folders-row');
    expect(documentsRow).not.toBeNull();
    expect(within(documentsRow!).getByText('External — restart required')).toBeInTheDocument();
    expect(within(documentsRow!).getByText('/mnt/onedrive/gezel-docs')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(window.__GEZEL__?.restartService).toHaveBeenCalledWith('folders-changed');
  });

  it('keeps conflict radios before their labels and submits the selected policy', async () => {
    vi.mocked(api.planFolderMove).mockResolvedValue({
      sourcePath: '/home/u/.gezel/documents',
      files: 42,
      bytes: 12345,
      conflicts: 1,
      validation: { ok: true },
    } as never);

    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Documents library/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /Move to other folder/ })[0]!);

    const dialog = await screen.findByTestId('confirm-dialog');
    const overwrite = within(dialog).getByRole('radio', {
      name: 'Move files, replacing destination conflicts',
    });
    const skip = within(dialog).getByRole('radio', {
      name: 'Move files, keeping destination conflicts',
    });
    const useDestination = within(dialog).getByRole('radio', {
      name: 'Don’t move files (use destination as-is)',
    });

    expect(overwrite).toBeChecked();
    expect(overwrite.nextElementSibling).toHaveTextContent(
      'Move files, replacing destination conflicts',
    );
    expect(skip.nextElementSibling).toHaveTextContent('Move files, keeping destination conflicts');
    expect(useDestination.nextElementSibling).toHaveTextContent(
      'Don’t move files (use destination as-is)',
    );

    await user.click(skip);
    fireEvent.click(within(dialog).getByTestId('confirm'));

    await waitFor(() => {
      expect(api.startFolderMove).toHaveBeenCalledWith({
        scope: 'documents',
        destPath: '/mnt/onedrive/gezel-docs',
        conflictPolicy: 'skip-all',
      });
    });
  });

  it('can adopt the selected folder without moving either folder’s files', async () => {
    render(<FoldersSettings />);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /Move to other folder/ }))[0]!);

    const dialog = await screen.findByTestId('confirm-dialog');
    await user.click(
      within(dialog).getByRole('radio', {
        name: 'Don’t move files (use destination as-is)',
      }),
    );

    expect(within(dialog).getByText('Use this folder without moving files?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Nothing will be copied, overwritten, or deleted/),
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId('confirm')).toHaveTextContent('Use this folder');

    await user.click(within(dialog).getByTestId('confirm'));
    await waitFor(() => {
      expect(api.startFolderMove).toHaveBeenCalledWith({
        scope: 'documents',
        destPath: '/mnt/onedrive/gezel-docs',
        conflictPolicy: 'use-destination',
      });
    });
  });

  it('plan with validation.ok=false surfaces the rejection reason', async () => {
    vi.mocked(api.planFolderMove).mockResolvedValue({
      sourcePath: '/home/u/.gezel/documents',
      files: 0,
      bytes: 0,
      conflicts: 0,
      validation: { ok: false, reason: 'destination is on a different filesystem' },
    } as never);

    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Documents library/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /Move to other folder/ })[0]!);

    await waitFor(() => {
      expect(screen.getByText(/different filesystem/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('without a desktop selectDirectory shim, surfaces a friendly error', async () => {
    (window as unknown as { __GEZEL__: { selectDirectory?: unknown } }).__GEZEL__.selectDirectory =
      undefined;
    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Documents library/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /Move to other folder/ })[0]!);

    await waitFor(() => {
      expect(
        screen.getByText(/Folder picker is only available in the desktop app/),
      ).toBeInTheDocument();
    });
  });

  it('says nothing about snapshots when no move has ever run', async () => {
    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Documents library/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Move snapshots/)).not.toBeInTheDocument();
  });

  it('lists each snapshot with its scope and size, and opens it', async () => {
    const openPath = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __GEZEL__: Record<string, unknown> }).__GEZEL__.openPath = openPath;
    vi.mocked(api.getFolders).mockResolvedValue({
      ...STATUS,
      backups: {
        count: 1,
        totalBytes: 2048,
        path: '/home/u/.gezel/backup',
        snapshots: [
          {
            id: '2026-08-14T09-15-00-000Z',
            path: '/home/u/.gezel/backup/2026-08-14T09-15-00-000Z',
            scopes: ['gezels'],
            bytes: 2048,
            createdAt: '2026-08-14T09:15:00.000Z',
          },
        ],
      },
    } as never);

    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Move snapshots/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Gezellen · 2.0 KB/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      within(screen.getByRole('list')).getByRole('button', { name: 'Open in file manager' }),
    );

    expect(openPath).toHaveBeenCalledWith('/home/u/.gezel/backup/2026-08-14T09-15-00-000Z');
  });

  it('falls back to the folder name when a snapshot timestamp does not parse', async () => {
    vi.mocked(api.getFolders).mockResolvedValue({
      ...STATUS,
      backups: {
        count: 1,
        totalBytes: 10,
        path: '/home/u/.gezel/backup',
        snapshots: [
          {
            id: 'manual-copy',
            path: '/home/u/.gezel/backup/manual-copy',
            scopes: [],
            bytes: 10,
            createdAt: null,
          },
        ],
      },
    } as never);

    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByText('manual-copy')).toBeInTheDocument();
    });
    expect(screen.getByText(/empty · 10 B/)).toBeInTheDocument();
  });

  it('renders a Reset button for an externalized scope and dispatches resetFolder', async () => {
    vi.mocked(api.getFolders).mockResolvedValue({
      ...STATUS,
      current: { ...STATUS.current, documents: '/mnt/onedrive/gezel-docs' },
      externalized: { ...STATUS.externalized, documents: '/mnt/onedrive/gezel-docs' },
    } as never);

    render(<FoldersSettings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reset to default/ })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reset to default/ }));

    await waitFor(() => {
      expect(api.resetFolder).toHaveBeenCalledWith('documents');
    });
  });
});
