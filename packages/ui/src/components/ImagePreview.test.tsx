import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImagePreview } from './ImagePreview.js';

describe('ImagePreview', () => {
  it('portals the preview above the app shell and gives close focus', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImagePreview src="blob:preview" alt="A cat" caption="cat.png" onClose={onClose} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Image preview' });
    const close = screen.getByRole('button', { name: 'Close preview' });

    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
    await waitFor(() => expect(close).toHaveFocus());
  });

  it('closes from the visible close button or Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(
      <ImagePreview src="blob:preview" alt="A cat" caption="cat.png" onClose={onClose} />,
    );

    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    render(<ImagePreview src="blob:preview" alt="A cat" onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the optional download action available beside close', () => {
    render(
      <ImagePreview
        src="blob:preview"
        alt="A cat"
        caption="cat.png"
        downloadFilename="cat.png"
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'Download cat.png' })).toHaveAttribute(
      'download',
      'cat.png',
    );
  });
});
