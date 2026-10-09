import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import type { HostHtmlPreview } from '../html-preview-host.js';
import { HtmlPreviewFrame } from './HtmlPreviewFrame.js';
vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});
afterEach(() => {
  delete window.__GEZEL__;
});
const props = {
  projectId: 'project',
  path: 'page/index.html',
  source: 'artifacts' as const,
  title: 'Local preview',
};
describe('portable host snapshots in the shared preview frame', () => {
  it('revokes the previous snapshot on refresh and closes product page relays', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const onUrlReady = vi.fn();
    const createHtmlPreview = vi
      .fn()
      .mockResolvedValueOnce({ url: 'blob:first', dispose: first })
      .mockResolvedValueOnce({ url: 'blob:second', dispose: second });
    window.__GEZEL__ = { token: 'private', createHtmlPreview };
    const { rerender, unmount } = render(<HtmlPreviewFrame {...props} onUrlReady={onUrlReady} />);
    await waitFor(() =>
      expect(screen.getByTitle('Local preview')).toHaveAttribute('src', 'blob:first'),
    );
    const frame = screen.getByTitle('Local preview') as HTMLIFrameElement;
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow!,
        data: {
          __gezelPage: 1,
          kind: 'read',
          id: 'evil',
          op: 'read',
          source: 'workspace',
          path: 'private.json',
        },
      }),
    );
    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow!,
        data: {
          __gezelPreviewLog: true,
          __gezelPage: 1,
          kind: 'read',
          id: 'mixed',
          op: 'read',
          source: 'workspace',
          path: 'private.json',
        },
      }),
    );
    expect(api.invokeProjectPageRead).not.toHaveBeenCalled();
    expect(api.createProjectPreviewUrl).not.toHaveBeenCalled();
    expect(onUrlReady.mock.calls.every(([value]) => value === null)).toBe(true);
    rerender(<HtmlPreviewFrame {...props} onUrlReady={onUrlReady} refreshKey={1} />);
    await waitFor(() =>
      expect(screen.getByTitle('Local preview')).toHaveAttribute('src', 'blob:second'),
    );
    expect(first).toHaveBeenCalledOnce();
    unmount();
    expect(second).toHaveBeenCalledOnce();
  });
  it("relays a project type page's v1 bridge, and only that, on a snapshot host", async () => {
    window.__GEZEL__ = {
      token: 'private',
      createHtmlPreview: vi.fn().mockResolvedValue({ url: 'blob:type', dispose: vi.fn() }),
    };
    vi.mocked(api.invokeProjectPageRead).mockResolvedValue({
      op: 'read',
      content: '{}',
      encoding: 'utf8',
      etag: 'e1',
    } as never);
    vi.mocked(api.invokeProjectPageTool).mockResolvedValue({
      runId: 'run-1',
      status: 'ok',
      output: {},
      callsSummary: [],
    } as never);
    render(
      <HtmlPreviewFrame
        projectId="project"
        path="board/index.html"
        source="type"
        title="Board"
        pageTools={['user_move']}
      />,
    );
    await waitFor(() => expect(screen.getByTitle('Board')).toHaveAttribute('src', 'blob:type'));
    const frame = screen.getByTitle('Board') as HTMLIFrameElement;
    const post = (data: Record<string, unknown>) =>
      fireEvent(window, new MessageEvent('message', { source: frame.contentWindow!, data }));
    post({
      __gezelPage: 1,
      kind: 'read',
      id: 'r1',
      op: 'read',
      source: 'workspace',
      path: 'game.json',
    });
    post({ __gezelPage: 1, kind: 'invoke', id: 'i1', tool: 'user_move', input: { from: 'c3' } });
    post({ __gezelPage: 1, kind: 'invoke', id: 'i2', tool: 'new_game' });
    post({ __gezelPageInvoke: true, id: 'legacy', tool: 'user_move' });
    await waitFor(() =>
      expect(api.invokeProjectPageRead).toHaveBeenCalledWith('project', {
        op: 'read',
        source: 'workspace',
        path: 'game.json',
      }),
    );
    expect(api.invokeProjectPageTool).toHaveBeenCalledTimes(1);
    expect(api.invokeProjectPageTool).toHaveBeenCalledWith('project', {
      tool: 'user_move',
      input: { from: 'c3' },
    });
  });
  it('disposes snapshots that finish loading after unmount', async () => {
    let resolve!: (lease: HostHtmlPreview) => void;
    const dispose = vi.fn();
    window.__GEZEL__ = {
      token: 'private',
      createHtmlPreview: () =>
        new Promise((done) => {
          resolve = done;
        }),
    };
    const { unmount } = render(<HtmlPreviewFrame {...props} />);
    unmount();
    resolve({ url: 'blob:late', dispose });
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});
