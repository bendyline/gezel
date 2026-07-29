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
    vi.mocked(api.createProjectTypePreviewUrl).mockResolvedValue({
      url: 'https://127.0.0.1/preview/cap/type/checkers/board/index.html',
      expiresAt: '2026-07-29T22:00:00.000Z',
      scopePath: 'board',
    });
  });

  it('loads the opaque sandbox without credentials under the app shell COEP', async () => {
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
    expect(frame).toHaveAttribute('credentialless');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  });
});
