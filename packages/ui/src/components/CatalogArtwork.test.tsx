import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CatalogArtwork } from './CatalogArtwork.js';

describe('CatalogArtwork', () => {
  it('keeps the caller fallback visible until the image has loaded', () => {
    const { container } = render(
      <CatalogArtwork
        logoUrl="/catalog/craftbooks/example/logo.webp"
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
      <CatalogArtwork logoUrl="/first.webp" fallback={<span>fallback</span>} />,
    );
    fireEvent.error(container.querySelector('img')!);

    expect(screen.getByText('fallback')).toBeVisible();
    expect(container.querySelector('img')).toBeNull();

    rerender(<CatalogArtwork logoUrl="/second.webp" fallback={<span>fallback</span>} />);

    expect(container.querySelector('img')).toHaveAttribute('src', '/second.webp');
  });
});
