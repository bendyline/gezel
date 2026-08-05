import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { HtmlPreviewFrame } from './HtmlPreviewFrame.js';

vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});

describe('HtmlPreviewFrame security boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.createProjectTypePreviewUrl).mockResolvedValue({
      url: 'https://127.0.0.1/preview/cap/type/checkers/board/index.html',
      expiresAt: '2026-07-29T22:00:00.000Z',
      scopePath: 'board',
    });
  });

  it('re-mints the frame when the security policy changes', async () => {
    const lockedUrl = 'https://127.0.0.1/preview/locked/type/checkers/board/index.html';
    const externalUrl = 'https://127.0.0.1/preview/external/type/checkers/board/index.html';
    vi.mocked(api.createProjectTypePreviewUrl)
      .mockResolvedValueOnce({
        url: lockedUrl,
        expiresAt: '2026-07-29T22:00:00.000Z',
        scopePath: 'board',
      })
      .mockResolvedValueOnce({
        url: externalUrl,
        expiresAt: '2026-07-29T22:00:00.000Z',
        scopePath: 'board',
      });

    render(
      <HtmlPreviewFrame
        projectId="checkers"
        path="board/index.html"
        source="type"
        title="Dashboard"
      />,
    );
    await waitFor(() => expect(screen.getByTitle('Dashboard')).toHaveAttribute('src', lockedUrl));

    window.dispatchEvent(
      new CustomEvent('gezel:config-updated', {
        detail: { securityPolicy: { allowExternalServices: true } },
      }),
    );

    await waitFor(() => expect(screen.getByTitle('Dashboard')).toHaveAttribute('src', externalUrl));
    expect(api.createProjectTypePreviewUrl).toHaveBeenCalledTimes(2);
  });

  it('loads the preview in an opaque script-only sandbox', async () => {
    render(
      <HtmlPreviewFrame
        projectId="checkers"
        path="board/index.html"
        source="type"
        title="Dashboard"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTitle('Dashboard')).toHaveAttribute(
        'src',
        'https://127.0.0.1/preview/cap/type/checkers/board/index.html',
      ),
    );
    const frame = screen.getByTitle('Dashboard');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('does not expose the previous interactive lease while refreshing', async () => {
    const oldUrl = 'https://127.0.0.1/preview/old-cap/type/checkers/board/index.html';
    vi.mocked(api.createProjectTypePreviewUrl)
      .mockResolvedValueOnce({
        url: oldUrl,
        expiresAt: '2026-07-29T22:00:00.000Z',
        scopePath: 'board',
      })
      .mockImplementationOnce(() => new Promise(() => {}));

    const props = {
      projectId: 'checkers',
      path: 'board/index.html',
      source: 'type' as const,
      title: 'Dashboard',
    };
    const { container, rerender } = render(<HtmlPreviewFrame {...props} refreshKey={0} />);
    await waitFor(() => expect(screen.getByTitle('Dashboard')).toHaveAttribute('src', oldUrl));

    const addedFrameSources: Array<string | null> = [];
    const recordAddedFrames = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLIFrameElement) {
            addedFrameSources.push(node.getAttribute('src'));
          } else if (node instanceof Element) {
            for (const frame of node.querySelectorAll('iframe')) {
              addedFrameSources.push(frame.getAttribute('src'));
            }
          }
        }
      }
    };
    const observer = new MutationObserver(recordAddedFrames);
    observer.observe(container, { childList: true, subtree: true });

    rerender(<HtmlPreviewFrame {...props} refreshKey={1} />);
    recordAddedFrames(observer.takeRecords());
    observer.disconnect();

    expect(screen.getByTitle('Dashboard')).not.toHaveAttribute('src');
    expect(addedFrameSources).not.toContain(oldUrl);
  });
});
