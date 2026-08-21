import type { FindSimilarImagesResponse } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { api } = await import('../api.js');
const { FindSimilarImages } = await import('./FindSimilarImages.js');

describe('FindSimilarImages', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:similar-thumb'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows that the visual index is still building when vector search is unavailable', async () => {
    let resolveSearch: ((value: FindSimilarImagesResponse) => void) | undefined;
    vi.mocked(api.toolFindSimilarImages).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    render(
      <FindSimilarImages projectId="project-1" path="photos/source.jpg" fetchBlob={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Find similar images' }));
    expect(screen.getByText('Looking for similar images…')).toBeInTheDocument();
    resolveSearch?.({ results: [], engine: 'unavailable', truncated: false });

    expect(await screen.findByText(/No visual index for this image yet/)).toBeInTheDocument();
    expect(api.toolFindSimilarImages).toHaveBeenCalledWith('project-1', {
      path: 'photos/source.jpg',
      maxResults: 8,
    });
  });

  it('renders authed thumbnails and opens a selected vector result', async () => {
    vi.mocked(api.toolFindSimilarImages).mockResolvedValue({
      results: [{ path: 'photos/fern.jpg', score: 0.873 }],
      engine: 'vector',
      truncated: false,
    });
    const fetchBlob = vi.fn().mockResolvedValue(new Blob(['image']));
    const onOpen = vi.fn();
    render(
      <FindSimilarImages
        projectId="project-1"
        path="photos/source.jpg"
        fetchBlob={fetchBlob}
        onOpen={onOpen}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Find similar images' }));
    const result = await screen.findByTitle('photos/fern.jpg · 87% similar');
    expect(await screen.findByRole('img', { name: 'fern.jpg' })).toHaveAttribute(
      'src',
      'blob:similar-thumb',
    );
    expect(fetchBlob).toHaveBeenCalledWith('photos/fern.jpg');

    await userEvent.click(result);
    expect(onOpen).toHaveBeenCalledWith('photos/fern.jpg');
  });

  it('distinguishes lookup failures from an empty result set', async () => {
    vi.mocked(api.toolFindSimilarImages).mockRejectedValueOnce(new Error('offline'));
    render(
      <FindSimilarImages projectId="project-1" path="photos/source.jpg" fetchBlob={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Find similar images' }));

    expect(await screen.findByText('The similarity lookup failed.')).toBeInTheDocument();
    expect(screen.queryByText(/No visually similar images/)).not.toBeInTheDocument();
  });
});
