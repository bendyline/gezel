import type { GalleryItem, GalleryResponse, ProjectDetail } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GalleryProjectView from './index.js';

vi.mock('../../../api.js', () => ({
  api: {
    getGallery: vi.fn(),
    getGalleryShelf: vi.fn(),
    fetchProjectThumbnail: vi.fn(),
  },
}));

const { api } = await import('../../../api.js');
const getGallery = vi.mocked(api.getGallery);
const getGalleryShelf = vi.mocked(api.getGalleryShelf);
vi.mocked(api.fetchProjectThumbnail).mockRejectedValue(new Error('no thumbnails in tests'));

const item = (path: string, over: Partial<GalleryItem> = {}): GalleryItem => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  type: 'note',
  typeLabel: 'Note',
  family: 'documents',
  size: 100,
  mtimeMs: Date.now() - 3_600_000,
  ...over,
});

const RESPONSE: GalleryResponse = {
  indexed: true,
  group: 'type',
  groups: ['folder', 'type'],
  filter: 'all',
  families: { documents: 3, photos: 1 },
  total: 4,
  shelves: [
    {
      id: 'type:note',
      label: 'Notes',
      labelSource: 'rule',
      count: 3,
      items: [
        item('notes/plan.md', { title: 'Launch plan', lead: 'The launch plan for the bakery.' }),
        item('notes/ideas.md'),
      ],
    },
    {
      id: 'type:photo',
      label: 'Photos',
      labelSource: 'rule',
      count: 1,
      items: [item('pics/a.jpg', { type: 'photo', typeLabel: 'Photo', family: 'photos' })],
    },
  ],
  shelfCount: 2,
};

const project = { id: 'p1', name: 'Demo', packages: [] } as unknown as ProjectDetail;

function renderGallery() {
  const onSelectPath = vi.fn();
  render(
    <GalleryProjectView
      projectId="p1"
      project={project}
      compact={false}
      selectedPath={null}
      onSelectPath={onSelectPath}
      setInspectorExtras={vi.fn()}
    />,
  );
  return { onSelectPath };
}

beforeEach(() => {
  getGallery.mockReset();
  getGalleryShelf.mockReset();
  window.localStorage.clear();
});

describe('GalleryProjectView', () => {
  it('shows shelves of cards, and a card selects its file', async () => {
    getGallery.mockResolvedValue(RESPONSE);
    const { onSelectPath } = renderGallery();
    const notes = await screen.findByRole('region', { name: 'Notes' });
    expect(within(notes).getByText('Launch plan')).toBeInTheDocument();
    expect(within(notes).getByText('The launch plan for the bakery.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByText('4 files')).toBeInTheDocument();
    fireEvent.click(within(notes).getByText('Launch plan'));
    expect(onSelectPath).toHaveBeenCalledWith('notes/plan.md');
    fireEvent.click(screen.getByRole('button', { name: 'a.jpg' }));
    expect(onSelectPath).toHaveBeenLastCalledWith('pics/a.jpg');
  });

  it('offers only the filters the files fill, and remembers the grouping', async () => {
    getGallery.mockResolvedValue(RESPONSE);
    renderGallery();
    const show = await screen.findByRole('radiogroup', { name: 'Show' });
    expect(
      within(show)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['All', 'Photos', 'Documents']);
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Group by' })).getByText('Folders'),
    );
    await waitFor(() =>
      expect(getGallery).toHaveBeenLastCalledWith(
        'p1',
        expect.objectContaining({ group: 'folder' }),
      ),
    );
    expect(window.localStorage.getItem('gezel.gallery.group.p1')).toBe('folder');
    fireEvent.click(within(show).getByText('Photos'));
    await waitFor(() =>
      expect(getGallery).toHaveBeenLastCalledWith(
        'p1',
        expect.objectContaining({ filter: 'photos' }),
      ),
    );
  });

  it('fetches the next page of a shelf on Show more', async () => {
    getGallery.mockResolvedValue(RESPONSE);
    getGalleryShelf.mockResolvedValue({
      shelf: 'type:note',
      offset: 2,
      count: 3,
      items: [item('notes/third.md')],
    });
    renderGallery();
    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 more' }));
    expect(await screen.findByText('third.md')).toBeInTheDocument();
    expect(getGalleryShelf).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ group: 'type', shelf: 'type:note', offset: 2 }),
    );
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
  });

  it('searches as the person types, and says when nothing matches', async () => {
    getGallery.mockResolvedValue(RESPONSE);
    renderGallery();
    await screen.findByRole('region', { name: 'Notes' });
    getGallery.mockResolvedValue({ ...RESPONSE, total: 0, shelves: [], shelfCount: 0 });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in the gallery' }), {
      target: { value: 'bakery ' },
    });
    await waitFor(() =>
      expect(getGallery).toHaveBeenLastCalledWith('p1', expect.objectContaining({ q: 'bakery' })),
    );
    expect(await screen.findByText('Nothing matches “bakery”.')).toBeInTheDocument();
  });

  it('waits for the first scan before it has anything to show', async () => {
    getGallery.mockResolvedValue({ ...RESPONSE, indexed: false, shelves: [], total: 0 });
    renderGallery();
    expect(await screen.findByText(/hasn’t looked through this folder yet/)).toBeInTheDocument();
  });
});
