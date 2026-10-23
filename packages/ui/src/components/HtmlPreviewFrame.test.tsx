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

describe('Output Pane API v1 relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.createProjectTypePreviewUrl).mockResolvedValue({
      url: 'https://127.0.0.1/preview/cap/type/checkers/board/index.html',
      expiresAt: '2026-07-29T22:00:00.000Z',
      scopePath: 'board',
    });
  });

  async function mountFrame(pageTools?: string[]) {
    const { unmount } = render(
      <HtmlPreviewFrame
        projectId="checkers"
        path="board/index.html"
        source="type"
        title="Dashboard"
        {...(pageTools ? { pageTools } : {})}
      />,
    );
    await waitFor(() => expect(screen.getByTitle('Dashboard')).toHaveAttribute('src'));
    const frame = screen.getByTitle('Dashboard') as HTMLIFrameElement;
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation((msg: unknown) => {
      posted.push(msg);
    });
    const send = (data: unknown) => {
      window.dispatchEvent(
        new MessageEvent('message', { data, source: frame.contentWindow as Window }),
      );
    };
    const postedOf = (kind: string) =>
      posted.filter((m) => (m as { kind?: string }).kind === kind) as Array<
        Record<string, unknown>
      >;
    return { frame, posted, send, postedOf, unmount };
  }

  it('answers hello with init (api, theme, limits)', async () => {
    const h = await mountFrame(['user_move']);
    h.send({ __gezelPage: 1, kind: 'hello' });
    await waitFor(() => expect(h.postedOf('init')).toHaveLength(1));
    expect(h.postedOf('init')[0]).toMatchObject({
      __gezelPage: 1,
      api: 1,
      theme: { mode: expect.stringMatching(/^(light|dark)$/) },
      limits: { maxInflight: 4, maxReadBytes: 2 * 1024 * 1024 },
    });
  });

  it('relays v1 invokes with the allowlist fast-fail and typed error codes', async () => {
    const h = await mountFrame(['user_move']);
    vi.mocked(api.invokeProjectPageTool).mockResolvedValue({
      runId: 'r1',
      status: 'ok',
      output: { board: 'x' },
      callsSummary: [],
    });

    h.send({ __gezelPage: 1, kind: 'invoke', id: 'a1', tool: 'not_listed', input: {} });
    await waitFor(() => expect(h.postedOf('result')).toHaveLength(1));
    expect(h.postedOf('result')[0]).toMatchObject({
      id: 'a1',
      ok: false,
      errorCode: 'not-allowed',
    });
    expect(api.invokeProjectPageTool).not.toHaveBeenCalled();

    h.send({ __gezelPage: 1, kind: 'invoke', id: 'a2', tool: 'user_move', input: { from: 'c3' } });
    await waitFor(() => expect(h.postedOf('result')).toHaveLength(2));
    expect(h.postedOf('result')[1]).toMatchObject({
      id: 'a2',
      ok: true,
      output: { board: 'x' },
      runId: 'r1',
    });
    expect(api.invokeProjectPageTool).toHaveBeenCalledWith('checkers', {
      tool: 'user_move',
      input: { from: 'c3' },
    });
  });

  it('relays v1 reads to the page-read route', async () => {
    const h = await mountFrame(['user_move']);
    vi.mocked(api.invokeProjectPageRead).mockResolvedValue({
      op: 'read',
      content: '{"turn":"ai"}',
      encoding: 'utf8',
      etag: 'e1',
      size: 13,
      mtime: 1,
    });
    h.send({
      __gezelPage: 1,
      kind: 'read',
      id: 'r1',
      op: 'read',
      source: 'workspace',
      path: 'game.json',
    });
    await waitFor(() => expect(h.postedOf('read-result')).toHaveLength(1));
    expect(h.postedOf('read-result')[0]).toMatchObject({
      id: 'r1',
      ok: true,
      content: '{"turn":"ai"}',
      etag: 'e1',
    });
    expect(api.invokeProjectPageRead).toHaveBeenCalledWith('checkers', {
      op: 'read',
      source: 'workspace',
      path: 'game.json',
    });
  });

  it('relays table calls for the host project and rejects extra request authority', async () => {
    const h = await mountFrame();
    vi.mocked(api.invokeProjectPageTables).mockResolvedValue({ op: 'list', tables: [] });
    h.send({
      __gezelPage: 1,
      kind: 'table',
      id: 't1',
      projectId: 'other',
      request: { op: 'list' },
    });
    await waitFor(() => expect(h.postedOf('table-result')).toHaveLength(1));
    expect(api.invokeProjectPageTables).toHaveBeenCalledWith('checkers', { op: 'list' });
    expect(h.postedOf('table-result')[0]).toMatchObject({
      id: 't1',
      ok: true,
      result: { op: 'list', tables: [] },
    });
    h.send({
      __gezelPage: 1,
      kind: 'table',
      id: 't2',
      request: { op: 'query', sql: 'SELECT 1', projectId: 'other' },
    });
    expect(h.postedOf('table-result')[1]).toMatchObject({
      id: 't2',
      ok: false,
      errorCode: 'invalid-input',
    });
    expect(api.invokeProjectPageTables).toHaveBeenCalledOnce();
  });

  it('bounds concurrent table calls and drops replies after unmount', async () => {
    const h = await mountFrame();
    const finishes: Array<(value: { op: 'list'; tables: [] }) => void> = [];
    vi.mocked(api.invokeProjectPageTables).mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    for (const id of ['a', 'b', 'c'])
      h.send({ __gezelPage: 1, kind: 'table', id, request: { op: 'list' } });
    expect(api.invokeProjectPageTables).toHaveBeenCalledTimes(2);
    expect(h.postedOf('table-result')).toEqual([
      expect.objectContaining({ id: 'c', ok: false, errorCode: 'rate-limited' }),
    ]);
    h.unmount();
    for (const finish of finishes) finish({ op: 'list', tables: [] });
    await Promise.resolve();
    expect(h.postedOf('table-result')).toHaveLength(1);
  });

  it('opens large files through the existing viewer only after a scoped stat', async () => {
    const h = await mountFrame();
    vi.mocked(api.invokeProjectPageRead).mockResolvedValue({
      op: 'stat',
      etag: 'file',
      size: 12_000_000,
      mtime: 1,
    });
    const opened = vi.fn();
    window.addEventListener('gezel:open-file', opened);
    try {
      h.send({
        __gezelPage: 1,
        kind: 'open',
        id: 'o1',
        source: 'workspace',
        path: 'sales/Q1 #2.csv',
      });
      await waitFor(() => expect(opened).toHaveBeenCalledOnce());
      expect(api.invokeProjectPageRead).toHaveBeenCalledWith('checkers', {
        op: 'stat',
        source: 'workspace',
        path: 'sales/Q1 #2.csv',
      });
      expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        projectId: 'checkers',
        source: 'workspace',
        path: 'sales/Q1 #2.csv',
      });
      expect(h.postedOf('open-result')[0]).toMatchObject({ id: 'o1', ok: true });
    } finally {
      window.removeEventListener('gezel:open-file', opened);
    }
  });

  it('rejects traversal, missing files, directories, and server-denied scopes', async () => {
    const h = await mountFrame();
    const opened = vi.fn();
    window.addEventListener('gezel:open-file', opened);
    try {
      h.send({
        __gezelPage: 1,
        kind: 'open',
        id: 'traversal',
        source: 'workspace',
        path: '../outside.csv',
      });
      expect(api.invokeProjectPageRead).not.toHaveBeenCalled();
      vi.mocked(api.invokeProjectPageRead)
        .mockResolvedValueOnce({ op: 'stat', etag: 'absent', exists: false })
        .mockResolvedValueOnce({ op: 'stat', etag: 'directory', mtime: 1 })
        .mockRejectedValueOnce(Object.assign(new Error('not declared'), { status: 403 }));
      for (const path of ['missing.csv', 'folder', 'secret.csv']) {
        h.send({ __gezelPage: 1, kind: 'open', id: path, source: 'workspace', path });
      }
      await waitFor(() => expect(h.postedOf('open-result')).toHaveLength(4));
      expect(h.postedOf('open-result').every((reply) => reply.ok === false)).toBe(true);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('gezel:open-file', opened);
    }
  });

  it('does not open a file after its requesting page unmounts', async () => {
    const h = await mountFrame();
    let finish!: (value: { op: 'stat'; etag: string; size: number }) => void;
    vi.mocked(api.invokeProjectPageRead).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opened = vi.fn();
    window.addEventListener('gezel:open-file', opened);
    try {
      h.send({
        __gezelPage: 1,
        kind: 'open',
        id: 'pending',
        source: 'workspace',
        path: 'sales.csv',
      });
      h.unmount();
      finish({ op: 'stat', etag: 'file', size: 100 });
      await Promise.resolve();
      expect(opened).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('gezel:open-file', opened);
    }
  });

  it('refuses file navigation from workspace HTML', async () => {
    vi.mocked(api.createProjectWorkspacePreviewUrl).mockResolvedValue({
      url: 'https://127.0.0.1/preview/cap/workspace/checkers/index.html',
      expiresAt: '2026-07-29T22:00:00.000Z',
      scopePath: '',
    });
    render(
      <HtmlPreviewFrame
        projectId="checkers"
        path="index.html"
        source="workspace"
        title="Untrusted page"
      />,
    );
    await waitFor(() => expect(screen.getByTitle('Untrusted page')).toHaveAttribute('src'));
    const frame = screen.getByTitle('Untrusted page') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow as Window,
        data: { __gezelPage: 1, kind: 'open', id: 'open', source: 'workspace', path: 'sales.csv' },
      }),
    );
    expect(api.invokeProjectPageRead).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'open-result', ok: false, errorCode: 'not-allowed' }),
      '*',
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow as Window,
        data: { __gezelPage: 1, kind: 'table', id: 'tables', request: { op: 'list' } },
      }),
    );
    expect(api.invokeProjectPageTables).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'table-result', ok: false, errorCode: 'not-allowed' }),
      '*',
    );
  });

  it('watch seeds an etag and posts change on the post-invoke sweep when it flips', async () => {
    const h = await mountFrame(['user_move']);
    vi.mocked(api.invokeProjectPageRead)
      .mockResolvedValueOnce({ op: 'stat', etag: 'aaa', mtime: 1 })
      .mockResolvedValue({ op: 'stat', etag: 'bbb', mtime: 2 });
    vi.mocked(api.invokeProjectPageTool).mockResolvedValue({
      runId: 'r2',
      status: 'ok',
      output: {},
      callsSummary: [],
    });

    h.send({ __gezelPage: 1, kind: 'watch', id: 'w1', source: 'workspace', path: 'game.json' });
    await waitFor(() => expect(api.invokeProjectPageRead).toHaveBeenCalledTimes(1));
    expect(h.postedOf('change')).toHaveLength(0);

    // A successful invoke triggers the read-your-write sweep; the flipped
    // etag becomes a change event without waiting for the poll interval.
    h.send({ __gezelPage: 1, kind: 'invoke', id: 'a9', tool: 'user_move' });
    await waitFor(() => expect(h.postedOf('change')).toHaveLength(1));
    expect(h.postedOf('change')[0]).toMatchObject({
      watchId: 'w1',
      path: 'game.json',
      etag: 'bbb',
    });

    h.send({ __gezelPage: 1, kind: 'unwatch', id: 'w1' });
  });

  it('still relays v0 sentinel invokes untouched', async () => {
    const h = await mountFrame(['user_move']);
    vi.mocked(api.invokeProjectPageTool).mockResolvedValue({
      runId: 'r3',
      status: 'ok',
      output: { ok: 1 },
      callsSummary: [],
    });
    h.send({ __gezelPageInvoke: true, id: 'v0-1', tool: 'user_move', input: {} });
    await waitFor(() =>
      expect(
        h.posted.filter((m) => (m as { __gezelPageResult?: boolean }).__gezelPageResult === true),
      ).toHaveLength(1),
    );
    const v0 = h.posted.find(
      (m) => (m as { __gezelPageResult?: boolean }).__gezelPageResult === true,
    );
    expect(v0).toMatchObject({ id: 'v0-1', ok: true, output: { ok: 1 } });
  });
});
