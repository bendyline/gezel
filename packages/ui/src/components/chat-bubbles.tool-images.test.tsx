import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolHistoryExpando } from './chat-bubbles.js';

const apiMocks = vi.hoisted(() => ({
  fetchProjectArtifactBlob: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMocks }));

const SCREENSHOT_TOOL = {
  name: 'browser_take_screenshot',
  durationMs: 120,
  success: true,
  images: [
    {
      path: 'sessions/2026-08-19_231929_new-session/tool-0-img-0.png',
      mimeType: 'image/png',
    },
  ],
};

describe('tool image preview', () => {
  beforeEach(() => {
    apiMocks.fetchProjectArtifactBlob.mockReset();
    apiMocks.fetchProjectArtifactBlob.mockResolvedValue(
      new Blob(['screenshot'], { type: 'image/png' }),
    );
    let nextObjectUrl = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:tool-image-${++nextObjectUrl}`),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('keeps the expanded image URL alive while a streaming parent re-renders', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ToolHistoryExpando tools={[SCREENSHOT_TOOL]} projectId="default" />,
    );

    await user.click(screen.getByRole('button', { name: 'Open screenshot 1' }));
    const preview = await screen.findByRole('img', { name: 'Tool screenshot' });
    const previewSrc = preview.getAttribute('src');
    expect(previewSrc).toMatch(/^blob:tool-image-/);
    await waitFor(() => expect(apiMocks.fetchProjectArtifactBlob).toHaveBeenCalledTimes(2));

    // Live turns update their parent bubble as tokens and tool events arrive.
    // The image path is unchanged, so that update must not revoke/refetch the
    // full-size preview that is already on screen.
    rerender(<ToolHistoryExpando tools={[{ ...SCREENSHOT_TOOL }]} projectId="default" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fetchProjectArtifactBlob).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(previewSrc);
    expect(screen.getByRole('img', { name: 'Tool screenshot' })).toHaveAttribute(
      'src',
      previewSrc,
    );
  });
});
