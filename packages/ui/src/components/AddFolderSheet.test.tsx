import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({
  api: createMockApi({
    inferProjectForPath: vi.fn(),
  }),
}));

const { AddFolderSheet, openAddFolder } = await import('./AddFolderSheet.js');
const { api } = await import('../api.js');

describe('AddFolderSheet', () => {
  it('previews a folder, says what tonight brings, and adds it with its crew', async () => {
    vi.mocked(api.inferProjectForPath)
      .mockResolvedValueOnce({
        project: null,
        created: false,
        matchedBy: 'well-known',
        root: '/Users/ada/Pictures',
        name: 'Pictures',
        readOnly: true,
        warnings: [],
        folder: {
          kind: 'pictures',
          census: { files: 50, images: 48, videos: 2, documents: 0, cloudOnly: 0, complete: true },
        },
      })
      .mockResolvedValueOnce({
        project: { id: 'pictures' } as never,
        created: true,
        matchedBy: 'well-known',
        readOnly: true,
        warnings: [],
      });
    render(<AddFolderSheet />);
    act(() => openAddFolder('/Users/ada/Pictures'));

    expect(await screen.findByText('Read-only folder')).toBeInTheDocument();
    expect(screen.getByText('48 photos · 2 videos')).toBeInTheDocument();
    expect(
      screen.getByText('Describe your photos, so you can find one by what is in it'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Work on this folder overnight' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));

    await waitFor(() =>
      expect(vi.mocked(api.inferProjectForPath)).toHaveBeenLastCalledWith({
        path: '/Users/ada/Pictures',
        kind: 'folder',
        source: 'add-folder',
        create: true,
        recruitCrew: true,
        nightWork: false,
      }),
    );
  });

  it("explains a folder gezel won't own in plain words", async () => {
    vi.mocked(api.inferProjectForPath).mockRejectedValueOnce(
      Object.assign(new Error('403'), { details: { code: 'forbidden_root', reason: 'user-home' } }),
    );
    render(<AddFolderSheet />);
    act(() => openAddFolder('/Users/ada'));
    expect(
      await screen.findByText(/Gezel keeps your home folder out of projects/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeDisabled();
  });
});
