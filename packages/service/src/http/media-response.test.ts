import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mediaFileResponse } from './media-response.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-response-'));
  await writeFile(join(root, 'clip.webm'), '0123456789');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function response(headers: Record<string, string> = {}, method = 'GET') {
  return mediaFileResponse({
    path: join(root, 'clip.webm'),
    size: 10,
    mtimeMs: 100,
    request: new Request('https://localhost/clip.webm', { headers, method }),
    headers: { 'content-type': 'video/webm' },
  });
}
it('supports suffix/open-ended ranges and rejects out-of-bounds seeks', async () => {
  const suffix = response({ range: 'bytes=-3' });
  expect(suffix.status).toBe(206);
  expect(await suffix.text()).toBe('789');
  expect(await response({ range: 'bytes=8-' }).text()).toBe('89');
  const outside = response({ range: 'bytes=10-' });
  expect(outside.status).toBe(416);
  expect(outside.headers.get('content-range')).toBe('bytes */10');
});
it('serves the whole new resource when If-Range is stale and HEAD has no body', async () => {
  const stale = response({ range: 'bytes=1-2', 'if-range': '"old"' });
  expect(stale.status).toBe(200);
  expect(await stale.text()).toBe('0123456789');
  const head = response({}, 'HEAD');
  expect(head.headers.get('content-length')).toBe('10');
  expect(await head.text()).toBe('');
  const current = response({ range: 'bytes=1-2', 'if-range': head.headers.get('etag')! });
  expect(current.status).toBe(206);
  expect(await current.text()).toBe('12');
  expect(current.headers.get('content-security-policy')).toContain('sandbox');
});
