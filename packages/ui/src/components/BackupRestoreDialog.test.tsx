import type { BackupPlan, RestoreReview, StorageJob } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const plan = (over: Partial<BackupPlan> = {}): BackupPlan => ({
  items: [
    { kind: 'gezel', id: 'tamsin', label: 'Tamsin', bytes: 4096, fileCount: 8, external: false },
    {
      kind: 'project',
      id: 'roof-survey',
      label: 'Roof Survey',
      bytes: 1024 ** 2,
      fileCount: 40,
      external: false,
    },
  ],
  totalBytes: 1024 ** 2 + 4096,
  secretsExcluded: true,
  warnings: [],
  ...over,
});

const review = (over: Partial<RestoreReview> = {}): RestoreReview => ({
  restoreId: 'restore-1',
  createdAt: '2026-08-16T12:00:00.000Z',
  gezelVersion: '1.2.3',
  archivePath: '/tmp/backup.zip',
  items: [
    {
      kind: 'gezel',
      id: 'tamsin',
      label: 'Tamsin',
      bytes: 4096,
      fileCount: 8,
      conflict: 'none',
    },
  ],
  secretsExcluded: true,
  warnings: [],
  ...over,
});

const job = (over: Partial<StorageJob> = {}): StorageJob => ({
  id: 'job-1',
  kind: 'backup',
  status: 'done',
  itemsDone: 2,
  totalItems: 2,
  bytesDone: 1024 ** 2,
  totalBytes: 1024 ** 2,
  startedAt: '2026-08-16T12:00:00.000Z',
  restartRequired: false,
  cancelRequested: false,
  skippedExternal: [],
  ...over,
});

vi.mock('../api.js', () => ({
  api: createMockApi({
    planBackup: vi.fn(),
    startBackup: vi.fn(),
    scanRestore: vi.fn(),
    confirmRestore: vi.fn(),
    cancelRestore: vi.fn(),
    getStorageJob: vi.fn(),
  }),
}));

const { api } = await import('../api.js');
const { BackupRestoreDialog, requestBackupRestore } = await import('./BackupRestoreDialog.js');

const chooseSavePath = vi.fn();
const chooseOpenPath = vi.fn();

beforeEach(() => {
  vi.mocked(api.planBackup).mockResolvedValue(plan());
  vi.mocked(api.startBackup).mockResolvedValue({ jobId: 'job-1' });
  vi.mocked(api.scanRestore).mockResolvedValue(review());
  vi.mocked(api.confirmRestore).mockResolvedValue({ jobId: 'job-1' });
  vi.mocked(api.getStorageJob).mockResolvedValue(job());
  chooseSavePath.mockResolvedValue({ path: '/Users/someone/gezel-backup.zip' });
  chooseOpenPath.mockResolvedValue({ path: '/Users/someone/gezel-backup.zip' });
  (window as unknown as { __GEZEL__: unknown }).__GEZEL__ = {
    backupFile: { chooseSavePath, chooseOpenPath },
  };
});

afterEach(() => {
  (window as unknown as { __GEZEL__?: unknown }).__GEZEL__ = undefined;
  vi.clearAllMocks();
});

async function open(detail?: { tab?: 'backup' | 'restore' }) {
  render(<BackupRestoreDialog />);
  requestBackupRestore(detail);
  return screen.findByRole('alertdialog');
}

describe('BackupRestoreDialog — backing up', () => {
  it('says up front that credentials are not included', async () => {
    await open();
    expect(await screen.findByText(/Saved credentials are never\s+included/)).toBeInTheDocument();
  });

  it('lists what the backup will hold, with a total', async () => {
    await open();
    expect(await screen.findByText('Tamsin')).toBeInTheDocument();
    expect(screen.getByText('Roof Survey')).toBeInTheDocument();
    expect(screen.getByText(/About 1 MB in total/)).toBeInTheDocument();
  });

  it('asks the OS where to save, then hands the path to the daemon', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole('button', { name: /Choose where to save/ }));

    await waitFor(() => expect(chooseSavePath).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(api.startBackup)).toHaveBeenCalledWith({
        outPath: '/Users/someone/gezel-backup.zip',
        excludeWorkspaces: false,
      }),
    );
    expect(
      await screen.findByText(/Saved to \/Users\/someone\/gezel-backup.zip/),
    ).toBeInTheDocument();
  });

  it('does nothing when the save dialog is dismissed', async () => {
    const user = userEvent.setup();
    chooseSavePath.mockResolvedValue({});
    await open();

    await user.click(await screen.findByRole('button', { name: /Choose where to save/ }));

    await waitFor(() => expect(chooseSavePath).toHaveBeenCalled());
    expect(vi.mocked(api.startBackup)).not.toHaveBeenCalled();
  });

  it('re-plans when workspaces are excluded, so the size shown is real', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Tamsin');

    await user.click(screen.getByRole('checkbox', { name: /Leave out project working files/ }));

    await waitFor(() =>
      expect(vi.mocked(api.planBackup)).toHaveBeenLastCalledWith({ excludeWorkspaces: true }),
    );
  });
});

describe('BackupRestoreDialog — restoring', () => {
  it('shows what a chosen backup holds before changing anything', async () => {
    const user = userEvent.setup();
    await open({ tab: 'restore' });

    await user.click(await screen.findByRole('button', { name: /Choose a backup file/ }));

    expect(await screen.findByText('Tamsin')).toBeInTheDocument();
    expect(vi.mocked(api.confirmRestore)).not.toHaveBeenCalled();
  });

  it('leaves existing items alone unless replace is ticked', async () => {
    const user = userEvent.setup();
    vi.mocked(api.scanRestore).mockResolvedValue(
      review({
        items: [
          {
            kind: 'gezel',
            id: 'tamsin',
            label: 'Tamsin',
            bytes: 4096,
            fileCount: 8,
            conflict: 'exists',
          },
        ],
      }),
    );
    await open({ tab: 'restore' });
    await user.click(await screen.findByRole('button', { name: /Choose a backup file/ }));

    // Nothing restorable yet — the only item is already here.
    expect(await screen.findByText(/already exist here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore 0 item/ })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /replace the one already here/ }));
    await user.click(screen.getByRole('button', { name: /Restore 1 item/ }));

    await waitFor(() =>
      expect(vi.mocked(api.confirmRestore)).toHaveBeenCalledWith('restore-1', {
        items: [{ kind: 'gezel', id: 'tamsin', action: 'replace' }],
      }),
    );
  });

  it('adds items that are not here yet without extra ceremony', async () => {
    const user = userEvent.setup();
    await open({ tab: 'restore' });
    await user.click(await screen.findByRole('button', { name: /Choose a backup file/ }));
    await user.click(await screen.findByRole('button', { name: /Restore 1 item/ }));

    await waitFor(() =>
      expect(vi.mocked(api.confirmRestore)).toHaveBeenCalledWith('restore-1', {
        items: [{ kind: 'gezel', id: 'tamsin', action: 'add' }],
      }),
    );
  });

  it('asks for a restart when the daemon says one is needed', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getStorageJob).mockResolvedValue(job({ kind: 'restore', restartRequired: true }));
    await open({ tab: 'restore' });
    await user.click(await screen.findByRole('button', { name: /Choose a backup file/ }));
    await user.click(await screen.findByRole('button', { name: /Restore 1 item/ }));

    expect(await screen.findByText(/Restart Gezel to see restored content/)).toBeInTheDocument();
  });

  it('explains a file that is not a backup, inline', async () => {
    const user = userEvent.setup();
    vi.mocked(api.scanRestore).mockRejectedValue(new Error('That file is not a Gezel backup.'));
    await open({ tab: 'restore' });

    await user.click(await screen.findByRole('button', { name: /Choose a backup file/ }));

    expect(await screen.findByText('That file is not a Gezel backup.')).toBeInTheDocument();
  });
});

describe('BackupRestoreDialog — without the desktop shell', () => {
  it('points at the CLI when there is no file picker', async () => {
    (window as unknown as { __GEZEL__?: unknown }).__GEZEL__ = {};
    await open();
    expect(await screen.findByText(/needs the desktop app/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose where to save/ })).toBeDisabled();
  });
});
