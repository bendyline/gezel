import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogArtwork } from './CatalogArtwork.js';
import { resetCatalogArtworkCache } from './catalog-artwork-url.js';

const fetchCatalogFile = vi.fn<(path: string) => Promise<Blob>>();

vi.mock('../api.js', () => ({
  api: {
    fetchCatalogFile: (path: string) => fetchCatalogFile(path),
  },
}));

let nextObjectUrl = 0;
const createdObjectUrls: Blob[] = [];

beforeEach(() => {
  nextObjectUrl = 0;
  createdObjectUrls.length = 0;
  fetchCatalogFile.mockReset();
  fetchCatalogFile.mockImplementation(async () => new Blob(['logo'], { type: 'image/webp' }));
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      createdObjectUrls.push(blob);
      nextObjectUrl += 1;
      return `blob:logo-${nextObjectUrl}`;
    },
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  resetCatalogArtworkCache();
  vi.unstubAllGlobals();
});

describe('CatalogArtwork', () => {
  it('keeps the caller fallback visible until the image has loaded', async () => {
    const { container } = render(
      <CatalogArtwork
        logoUrl="https://cdn.example/logo.webp"
        fallback={<span>category mark</span>}
      />,
    );

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image).not.toBeVisible();
    expect(screen.getByText('category mark')).toBeVisible();

    fireEvent.load(image!);

    expect(image).toBeVisible();
    expect(screen.queryByText('category mark')).not.toBeInTheDocument();
  });

  it('retains the fallback after an image fails and tries a new URL', () => {
    const { container, rerender } = render(
      <CatalogArtwork logoUrl="https://cdn.example/first.webp" fallback={<span>fallback</span>} />,
    );
    fireEvent.error(container.querySelector('img')!);

    expect(screen.getByText('fallback')).toBeVisible();
    expect(container.querySelector('img')).toBeNull();

    rerender(
      <CatalogArtwork logoUrl="https://cdn.example/second.webp" fallback={<span>fallback</span>} />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.example/second.webp',
    );
  });

  it('passes absolute and data URLs straight to the image without fetching', () => {
    const { container } = render(
      <CatalogArtwork logoUrl="data:image/svg+xml,%3Csvg%2F%3E" fallback={<span>fb</span>} />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/svg+xml,%3Csvg%2F%3E',
    );
    expect(fetchCatalogFile).not.toHaveBeenCalled();
  });

  /**
   * The regression this whole path exists for: `/api/*` is bearer-gated, so a
   * bare `<img src="/api/catalog/...">` 401s and silently shows the glyph.
   */
  it('fetches bearer-gated catalog paths and renders them as an object URL', async () => {
    const { container } = render(
      <CatalogArtwork
        logoUrl="/api/catalog/craftbook-template/ad-variations/file/logo.webp?source=gilde"
        fallback={<span>glyph</span>}
      />,
    );

    // Nothing to show yet — the caller's glyph stands in.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('glyph')).toBeVisible();

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:logo-1');
    expect(fetchCatalogFile).toHaveBeenCalledWith(
      '/api/catalog/craftbook-template/ad-variations/file/logo.webp?source=gilde',
    );
  });

  it('fetches a shared logo path once across many cards', async () => {
    const path = '/api/catalog/craftbook-template/shared/file/logo.webp';
    const { container } = render(
      <>
        <CatalogArtwork logoUrl={path} fallback={<span>a</span>} />
        <CatalogArtwork logoUrl={path} fallback={<span>b</span>} />
        <CatalogArtwork logoUrl={path} fallback={<span>c</span>} />
      </>,
    );

    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(3));
    expect(fetchCatalogFile).toHaveBeenCalledTimes(1);
    for (const img of container.querySelectorAll('img')) {
      expect(img).toHaveAttribute('src', 'blob:logo-1');
    }
  });

  it('falls back to the glyph and does not retry when the fetch fails', async () => {
    fetchCatalogFile.mockRejectedValue(new Error('401'));
    const path = '/api/catalog/craftbook-template/broken/file/logo.webp';

    const { container, rerender } = render(
      <CatalogArtwork logoUrl={path} fallback={<span>glyph</span>} />,
    );

    await waitFor(() => expect(fetchCatalogFile).toHaveBeenCalledTimes(1));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('glyph')).toBeVisible();

    rerender(<CatalogArtwork logoUrl={path} fallback={<span>glyph</span>} />);
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
    expect(fetchCatalogFile).toHaveBeenCalledTimes(1);
  });

  it('prefers sanitized iconSvg over any logo fetch', () => {
    const { container } = render(
      <CatalogArtwork
        iconSvg="<svg data-testid='inline'></svg>"
        logoUrl="/api/catalog/toolset/x/file/logo.webp"
        fallback={<span>fb</span>}
      />,
    );

    expect(container.querySelector('svg')).not.toBeNull();
    expect(fetchCatalogFile).not.toHaveBeenCalled();
  });
});
