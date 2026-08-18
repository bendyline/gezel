import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BINARY_FILE, MEDIA_IMAGE, NonTextFilePreview } from './FilePreview.js';

/**
 * A file we refuse to preview leaves the pane with nothing to say about it.
 * Size is the one fact we can still offer, so it has to survive the trip
 * from the read response into this component.
 */

const neverFetched = vi.fn(() => Promise.reject(new Error('not expected')));

describe('NonTextFilePreview', () => {
  it('shows the size beside the path for a binary file', () => {
    render(
      <NonTextFilePreview
        content={BINARY_FILE}
        path="artifacts/release/gezel-1.0.1.tgz"
        fetchBlob={neverFetched}
        sizeBytes={4 * 1024 * 1024}
      />,
    );

    expect(screen.getByText(/no text preview available/)).toBeTruthy();
    expect(screen.getByText('artifacts/release/gezel-1.0.1.tgz · 4.0 MB')).toBeTruthy();
  });

  it('shows the path alone when the source did not report a size', () => {
    render(<NonTextFilePreview content={BINARY_FILE} path="notes.bin" fetchBlob={neverFetched} />);

    expect(screen.getByText('notes.bin')).toBeTruthy();
  });

  it('carries the size through the media branch too', () => {
    render(
      <NonTextFilePreview
        content={MEDIA_IMAGE}
        path="photo.png"
        fetchBlob={() => Promise.resolve(new Blob(['x']))}
        sizeBytes={2048}
      />,
    );

    expect(screen.getByText('photo.png · 2.0 KB')).toBeTruthy();
  });
});
