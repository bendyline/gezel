import type { PageLibrariesResponse } from '@bendyline/gezel/pages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({
  api: createMockApi({
    getPageLibraries: vi.fn(),
    installPageLibrary: vi.fn().mockResolvedValue({ ok: true, ready: true }),
    removePageLibrary: vi.fn().mockResolvedValue({ ok: true }),
    updateConfig: vi.fn().mockResolvedValue({}),
  }),
}));

const { api } = await import('../api.js');
const { PageLibrariesCard } = await import('./PageLibrariesCard.js');

function status(over: Partial<PageLibrariesResponse> = {}): PageLibrariesResponse {
  return {
    downloads: { person: true, automatic: true },
    autoDownload: true,
    libraries: [
      {
        library: 'three',
        name: 'three.js',
        description: '3D graphics for the web.',
        lines: [
          {
            version: '0.187.0',
            forms: ['module'],
            defaults: ['module'],
            installed: true,
            removable: true,
            downloading: false,
            bytes: 12 * 1024 * 1024,
            license: 'MIT',
          },
          {
            version: '0.128.0',
            forms: ['module', 'classic'],
            defaults: ['classic'],
            installed: false,
            removable: false,
            downloading: false,
            license: 'MIT',
          },
        ],
      },
    ],
    ...over,
  };
}

describe('PageLibrariesCard', () => {
  it('lists each version with where it stands, and downloads or removes one', async () => {
    vi.mocked(api.getPageLibraries!).mockResolvedValue(status());
    render(<PageLibrariesCard />);

    expect(await screen.findByText('three.js')).toBeTruthy();
    expect(screen.getByText(/On this computer · 12 MB/)).toBeTruthy();
    expect(screen.getByText(/import, script tag · Not downloaded/)).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(api.installPageLibrary).toHaveBeenCalledWith('three', '0.128.0'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removePageLibrary).toHaveBeenCalledWith('three', '0.187.0'));
  });

  it('saves the automatic-download setting', async () => {
    vi.mocked(api.getPageLibraries!).mockResolvedValue(status());
    render(<PageLibrariesCard />);
    const checkbox = await screen.findByRole('checkbox');
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({ pageLibraries: { autoDownload: false } }),
    );
  });

  it('offers no downloads in a build that cannot download, and says why', async () => {
    vi.mocked(api.getPageLibraries!).mockResolvedValue(
      status({
        downloads: {
          person: false,
          automatic: false,
          blocked: 'build',
          refusal: 'This build comes with a fixed set of page libraries and cannot download more.',
        },
      }),
    );
    render(<PageLibrariesCard />);
    expect(await screen.findByText(/fixed set of page libraries/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
