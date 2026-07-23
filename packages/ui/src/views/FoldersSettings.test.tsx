import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="confirm-dialog">
        <h3>{title}</h3>
        <button type="button" onClick={onConfirm} data-testid="confirm">
          Start
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
  backups: { count: 0, totalBytes: 0, path: '/home/u/.gezel/backups' },
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
      selectDirectory: vi.fn().mockResolvedValue('/mnt/onedrive/gezel-docs'),
      restartService: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  afterEach(() => {
    delete (window as unknown as { __GEZEL__: { selectDirectory?: unknown } }).__GEZEL__
      ?.selectDirectory;
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
    expect(screen.getByText(/Gezels$/)).toBeInTheDocument();
    expect(screen.getByText(/Projects \(artifacts/)).toBeInTheDocument();
    // Each row should have a Move button.
    expect(screen.getAllByRole('button', { name: /Move to other folder/ })).toHaveLength(3);
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
