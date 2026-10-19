import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { HtmlPreviewFrame } from './HtmlPreviewFrame.js';

vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.createProjectTypePreviewUrl).mockResolvedValue({
    url: 'https://127.0.0.1/preview/cap/type/project/index.html',
    scopePath: '',
    expiresAt: '',
  });
});
async function frame() {
  await waitFor(() => expect(screen.getByTitle('App')).toHaveAttribute('src'));
  return screen.getByTitle('App') as HTMLIFrameElement;
}
function post(
  frame: HTMLIFrameElement,
  data: Record<string, unknown>,
  source = frame.contentWindow,
) {
  window.dispatchEvent(
    new MessageEvent('message', { source: source!, data: { __gezelPage: 1, ...data } }),
  );
}
const props = { projectId: 'project', source: 'type' as const, path: 'index.html', title: 'App' };
it('binds uploads to the current project and rejects other windows and invalid names', async () => {
  render(<HtmlPreviewFrame {...props} />);
  const host = await frame();
  const replies = vi.spyOn(host.contentWindow!, 'postMessage');
  const file = new File(['x'], 'ok.csv');
  vi.mocked(api.importProjectPageFile).mockResolvedValue({
    source: 'workspace',
    path: 'ok.csv',
    name: 'ok.csv',
    size: 1,
    mtime: 1,
  });
  post(host, { kind: 'import-file', id: 'foreign', target: 'data', name: 'ok.csv', file }, window);
  post(host, { kind: 'import-file', id: 'bad', target: 'data', name: '../bad.csv', file });
  post(host, {
    kind: 'import-file',
    id: 'fake',
    target: 'data',
    name: 'ok.csv',
    file: { size: 1 },
  });
  await waitFor(() => expect(replies).toHaveBeenCalledTimes(2));
  expect(api.importProjectPageFile).not.toHaveBeenCalled();
  post(host, {
    kind: 'import-file',
    id: 'good',
    target: 'data',
    name: 'ok.csv',
    file,
    projectId: 'other',
  });
  await waitFor(() =>
    expect(api.importProjectPageFile).toHaveBeenCalledWith(
      'project',
      'data',
      'ok.csv',
      file,
      expect.any(AbortSignal),
    ),
  );
});
it('cancels an in-flight upload on page refresh and ignores its stale result', async () => {
  let finish!: (value: never) => void;
  vi.mocked(api.importProjectPageFile).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { rerender } = render(<HtmlPreviewFrame {...props} refreshKey={0} />);
  const host = await frame();
  const replies = vi.spyOn(host.contentWindow!, 'postMessage');
  post(host, {
    kind: 'import-file',
    id: 'slow',
    target: 'data',
    name: 'slow.csv',
    file: new File(['x'], 'slow.csv'),
  });
  await waitFor(() => expect(api.importProjectPageFile).toHaveBeenCalled());
  const signal = vi.mocked(api.importProjectPageFile).mock.calls[0]![4]!;
  rerender(<HtmlPreviewFrame {...props} refreshKey={1} />);
  expect(signal.aborted).toBe(true);
  finish({ source: 'workspace', path: 'slow.csv' } as never);
  await Promise.resolve();
  expect(replies.mock.calls.some(([value]) => value.kind === 'import-result')).toBe(false);
});
it('accepts cancellation only for this frame and bounds concurrent imports', async () => {
  vi.mocked(api.importProjectPageFile).mockImplementation(() => new Promise(() => {}));
  const { unmount } = render(<HtmlPreviewFrame {...props} />);
  const host = await frame();
  const replies = vi.spyOn(host.contentWindow!, 'postMessage');
  for (const id of ['one', 'two', 'three'])
    post(host, {
      kind: 'import-file',
      id,
      target: 'data',
      name: 'a.csv',
      file: new File(['x'], 'a.csv'),
    });
  expect(api.importProjectPageFile).toHaveBeenCalledTimes(2);
  expect(replies).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'three', errorCode: 'rate-limited' }),
    '*',
  );
  const signal = vi.mocked(api.importProjectPageFile).mock.calls[0]![4]!;
  post(host, { kind: 'import-cancel', id: 'one' }, window);
  expect(signal.aborted).toBe(false);
  post(host, { kind: 'import-cancel', id: 'one' });
  expect(signal.aborted).toBe(true);
  unmount();
  expect(vi.mocked(api.importProjectPageFile).mock.calls[1]![4]!.aborted).toBe(true);
});
