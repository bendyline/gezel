import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const api = createMockApi({
  listPhotoAlbums: vi.fn().mockResolvedValue([
    {
      path: 'albums/2026-09-20-beach-afternoon.md',
      title: 'Beach afternoon',
      from: '2026-09-20T14:00:00',
      to: '2026-09-20T17:10:00',
      cover: 'Camera/IMG_0001.HEIC',
      count: 12,
    },
  ]),
  getOnThisDay: vi.fn().mockResolvedValue({
    day: '10-08',
    years: [{ year: 2023, count: 3, paths: ['2023/canal-1.jpg', '2023/canal-2.jpg'] }],
  }),
  preparePhotoAlbum: vi.fn().mockResolvedValue({ stored: 12, skipped: [] }),
  fetchProjectThumbnail: vi.fn().mockRejectedValue(new Error('no thumbnails in tests')),
  copyPhotoAlbumToFolder: vi
    .fn()
    .mockResolvedValue({ folder: 'Albums/Beach afternoon', copied: 12, skipped: [] }),
});
vi.mock('../api.js', () => ({ api }));

const { PhotoAlbumsSection, albumFolderName, albumSpanLabel } = await import('./PhotoAlbums.js');

describe('PhotoAlbumsSection', () => {
  it('lists album proposals and this day in earlier years', async () => {
    render(<PhotoAlbumsSection projectId="pics" />);

    expect(await screen.findByText('Beach afternoon')).toBeTruthy();
    expect(screen.getByText('2023')).toBeTruthy();
    expect(screen.getByText(/12 photos/)).toBeTruthy();
  });

  it('stores the photos, then opens the album document where it plays and exports', async () => {
    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener('gezel:open-file', onOpen);
    render(<PhotoAlbumsSection projectId="pics" />);

    fireEvent.click(await screen.findByRole('button', { name: /Beach afternoon/ }));

    await waitFor(() => expect(opened).toHaveLength(1));
    window.removeEventListener('gezel:open-file', onOpen);
    expect(api.preparePhotoAlbum).toHaveBeenCalledWith(
      'pics',
      'albums/2026-09-20-beach-afternoon.md',
    );
    expect(opened[0]).toMatchObject({
      projectId: 'pics',
      path: 'albums/2026-09-20-beach-afternoon.md',
      source: 'artifacts',
    });
  });

  it('copies the originals into a folder the person names, only on their click', async () => {
    render(<PhotoAlbumsSection projectId="pics" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to a folder…' }));
    expect(screen.getByDisplayValue('Albums/Beach afternoon')).toBeTruthy();
    expect(api.copyPhotoAlbumToFolder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByText('Copied 12 photos into Albums/Beach afternoon.')).toBeTruthy();
    expect(api.copyPhotoAlbumToFolder).toHaveBeenCalledWith('pics', {
      path: 'albums/2026-09-20-beach-afternoon.md',
      folder: 'Albums/Beach afternoon',
    });
  });

  it('renders nothing for a folder with no albums and no earlier years', async () => {
    api.listPhotoAlbums!.mockResolvedValueOnce([]);
    api.getOnThisDay!.mockResolvedValueOnce({ day: '10-08', years: [] });
    const { container } = render(<PhotoAlbumsSection projectId="code" />);
    await waitFor(() => expect(api.getOnThisDay).toHaveBeenCalledWith('code'));
    expect(container.textContent).toBe('');
  });

  it('names a folder after the album, without characters a folder cannot hold', () => {
    expect(albumFolderName('Beach: day 2 / sunset')).toBe('Albums/Beach day 2 sunset');
    expect(albumFolderName(undefined)).toBe('Albums/Album');
  });

  it('labels an album by its capture span', () => {
    expect(albumSpanLabel('2026-09-20T14:00:00', '2026-09-20T17:00:00')).toBe('2026-09-20');
    expect(albumSpanLabel('2026-09-20T14:00:00', '2026-09-22T09:00:00')).toBe(
      '2026-09-20 – 2026-09-22',
    );
    expect(albumSpanLabel(undefined, undefined)).toBeNull();
  });
});
