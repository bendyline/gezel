import type { StorageCategory, StorageSummary } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

const summary = (over: Partial<StorageSummary> = {}): StorageSummary => ({
  home: '/home/someone/.gezel',
  measuredAt: '2026-08-16T12:00:00.000Z',
  redownloadableBytes: 1024 ** 3 * 60,
  userContentBytes: 1024 ** 2 * 40,
  categories: [
    category(),
    category({
      id: 'gezels',
      class: 'user-content',
      label: 'Gezels',
      description: 'Your gezels.',
      bytes: 1024 ** 2 * 40,
      inBackup: true,
    }),
  ],
  ...over,
});

vi.mock('../api.js', () => ({
  api: createMockApi({
    storageSummary: vi.fn().mockResolvedValue({
      home: '/home/someone/.gezel',
      measuredAt: '2026-08-16T12:00:00.000Z',
      redownloadableBytes: 0,
      userContentBytes: 0,
      categories: [],
    }),
  }),
}));

const { api } = await import('../api.js');
const { StorageUsageCard } = await import('./StorageUsageCard.js');

describe('StorageUsageCard', () => {
  it('leads with the two totals that decide what to clear', async () => {
    vi.mocked(api.storageSummary).mockResolvedValue(summary());
    render(<StorageUsageCard />);

    expect(await screen.findByText('60.0 GB')).toBeInTheDocument();
    expect(screen.getByText('40 MB')).toBeInTheDocument();
    expect(screen.getByText(/Uninstalling\s+Gezel does not remove it/)).toBeInTheDocument();
  });

  it('breaks the total down on request', async () => {
    const user = userEvent.setup();
    vi.mocked(api.storageSummary).mockResolvedValue(summary());
    render(<StorageUsageCard />);

    await user.click(await screen.findByRole('button', { name: /Show what is using the space/ }));

    expect(screen.getByRole('heading', { name: 'Can be downloaded again' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your content' })).toBeInTheDocument();
    expect(screen.getByText('Downloaded models')).toBeInTheDocument();
  });

  it('names folders outside the Gezel directory as untouchable', async () => {
    const user = userEvent.setup();
    vi.mocked(api.storageSummary).mockResolvedValue(
      summary({
        categories: [
          category({
            id: 'projects',
            class: 'user-content',
            label: 'Projects',
            description: 'Your projects.',
            bytes: 900,
            external: [{ path: '/Users/someone/code/repo', bytes: 900 }],
          }),
        ],
      }),
    );
    render(<StorageUsageCard />);

    await user.click(await screen.findByRole('button', { name: /Show what is using the space/ }));

    expect(
      screen.getByRole('heading', { name: 'Stored outside the Gezel folder' }),
    ).toBeInTheDocument();
    expect(screen.getByText('/Users/someone/code/repo')).toBeInTheDocument();
    expect(screen.getByText(/never deletes these/)).toBeInTheDocument();
  });

  it('re-measures on demand rather than serving the cached numbers', async () => {
    const user = userEvent.setup();
    vi.mocked(api.storageSummary).mockResolvedValue(summary());
    render(<StorageUsageCard />);

    await screen.findByText('60.0 GB');
    await user.click(screen.getByRole('button', { name: 'Measure again' }));

    await waitFor(() =>
      expect(vi.mocked(api.storageSummary)).toHaveBeenLastCalledWith({ refresh: true }),
    );
  });

  it('shows a failure inline instead of an empty panel', async () => {
    vi.mocked(api.storageSummary).mockRejectedValue(new Error('daemon unreachable'));
    render(<StorageUsageCard />);

    expect(await screen.findByText('daemon unreachable')).toBeInTheDocument();
  });
});
