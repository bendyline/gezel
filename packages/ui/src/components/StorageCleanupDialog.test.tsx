import type { StorageCategory, StorageJob, StorageSummary } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

function category(over: Partial<StorageCategory> = {}): StorageCategory {
  return {
    id: 'models',
    class: 'redownloadable',
    label: 'Downloaded models',
    description: 'Model weights.',
    bytes: 1024 ** 3 * 60,
    itemCount: 1,
    deletable: true,
    inBackup: false,
    external: [],
    ...over,
  };
}

const gezelsCategory = category({
  id: 'gezels',
  class: 'user-content',
  label: 'Gezels',
  description: 'Your gezels.',
  bytes: 1024 ** 2 * 5,
  inBackup: true,
});

const summary = (over: Partial<StorageSummary> = {}): StorageSummary => ({
  home: '/home/someone/.gezel',
  measuredAt: '2026-08-16T12:00:00.000Z',
  redownloadableBytes: 1024 ** 3 * 60,
  userContentBytes: 1024 ** 2 * 5,
  categories: [category(), gezelsCategory],
  ...over,
});

const job = (over: Partial<StorageJob> = {}): StorageJob => ({
  id: 'job-1',
  kind: 'cleanup',
  status: 'done',
  itemsDone: 1,
  totalItems: 1,
  bytesDone: 1024 ** 3 * 60,
  totalBytes: 1024 ** 3 * 60,
  startedAt: '2026-08-16T12:00:00.000Z',
  restartRequired: false,
  cancelRequested: false,
  skippedExternal: [],
  ...over,
});

vi.mock('../api.js', () => ({
  api: createMockApi({
    storageSummary: vi.fn(),
    startCleanup: vi.fn(),
    getStorageJob: vi.fn(),
  }),
}));

const { api } = await import('../api.js');
const { StorageCleanupDialog, requestStorageCleanup } = await import('./StorageCleanupDialog.js');

beforeEach(() => {
  vi.mocked(api.storageSummary).mockResolvedValue(summary());
  vi.mocked(api.startCleanup).mockResolvedValue({ jobId: 'job-1' });
  vi.mocked(api.getStorageJob).mockResolvedValue(job());
});

/** The dialog mounts closed and opens on the window event. */
async function open(detail?: { preselectRedownloadable?: boolean }) {
  render(<StorageCleanupDialog />);
  requestStorageCleanup(detail);
  return screen.findByRole('alertdialog');
}

describe('StorageCleanupDialog', () => {
  it('stays closed until something asks for it', () => {
    render(<StorageCleanupDialog />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers nothing to delete until a category is picked', async () => {
    await open();
    await screen.findByText('Downloaded models — 60.0 GB');
    // Nothing selected means nothing to confirm — the button cannot fire.
    expect(screen.getByRole('button', { name: /^Free/ })).toBeDisabled();
  });

  it('reuses the settings measurement when it opens', async () => {
    const dialog = await open();
    await screen.findByText('Downloaded models — 60.0 GB');

    expect(vi.mocked(api.storageSummary)).toHaveBeenCalledWith();
    expect(dialog.querySelector('.gz-cleanup-body')).toBeInTheDocument();
    expect(dialog.querySelector('.gz-cleanup-body .gz-dialog-actions')).toBeNull();
    expect(dialog.querySelector(':scope > .gz-dialog-actions')).toBeInTheDocument();
  });

  it('pre-selects the safe downloads when opened from the uninstall path', async () => {
    await open({ preselectRedownloadable: true });

    const action = await screen.findByRole('button', { name: 'Free 60.0 GB' });
    expect(action).toBeEnabled();
  });

  it('never pre-selects the user’s own content', async () => {
    await open({ preselectRedownloadable: true });
    await screen.findByRole('button', { name: 'Free 60.0 GB' });

    // The content group is collapsed, so its checkboxes are not even present.
    expect(screen.queryByRole('checkbox', { name: /Gezels/ })).toBeNull();
  });

  it('keeps the user’s content behind a second click and relabels the action', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole('button', { name: /Delete my content instead/ }));
    expect(screen.getByText(/Gezel cannot bring these back/)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Gezels/ }));
    expect(
      screen.getByRole('button', { name: 'Delete selected content permanently' }),
    ).toBeInTheDocument();
  });

  it('sends the explicit confirmation flag only for user content', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole('checkbox', { name: /Downloaded models/ }));
    await user.click(screen.getByRole('button', { name: /^Free/ }));

    await waitFor(() =>
      expect(vi.mocked(api.startCleanup)).toHaveBeenCalledWith({ categories: ['models'] }),
    );
  });

  it('confirms user content explicitly when it is selected', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole('button', { name: /Delete my content instead/ }));
    await user.click(screen.getByRole('checkbox', { name: /Gezels/ }));
    await user.click(screen.getByRole('button', { name: 'Delete selected content permanently' }));

    await waitFor(() =>
      expect(vi.mocked(api.startCleanup)).toHaveBeenCalledWith({
        categories: ['gezels'],
        confirmUserContent: true,
      }),
    );
  });

  it('reports what was freed when the job finishes', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole('checkbox', { name: /Downloaded models/ }));
    await user.click(screen.getByRole('button', { name: /^Free/ }));

    expect(await screen.findByText('Freed 60.0 GB.')).toBeInTheDocument();
  });

  it('names folders it deliberately left alone', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getStorageJob).mockResolvedValue(
      job({
        skippedExternal: [{ label: 'Linked working folder', path: '/Users/x/repo' }],
      }),
    );
    await open();

    await user.click(await screen.findByRole('checkbox', { name: /Downloaded models/ }));
    await user.click(screen.getByRole('button', { name: /^Free/ }));

    expect(await screen.findByText(/live outside Gezel’s storage/)).toBeInTheDocument();
    expect(screen.getByText('/Users/x/repo')).toBeInTheDocument();
  });

  it('surfaces a refusal from the daemon inline', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getStorageJob).mockResolvedValue(
      job({ status: 'error', error: 'A chat is still replying. Wait for it to finish.' }),
    );
    await open();

    await user.click(await screen.findByRole('checkbox', { name: /Downloaded models/ }));
    await user.click(screen.getByRole('button', { name: /^Free/ }));

    expect(await screen.findByText(/A chat is still replying/)).toBeInTheDocument();
  });

  it('re-measures storage once the job settles', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(await screen.findByRole('checkbox', { name: /Downloaded models/ }));
    await user.click(screen.getByRole('button', { name: /^Free/ }));

    await screen.findByText('Freed 60.0 GB.');
    // Once at open, once after the run — a stale total would tell the user
    // the space they just reclaimed is still in use.
    await waitFor(() => expect(vi.mocked(api.storageSummary).mock.calls.length).toBeGreaterThan(1));
  });
});
