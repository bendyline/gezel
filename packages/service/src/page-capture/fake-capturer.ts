/**
 * A capturer for tests and the connector simulator: "renders" pages by
 * fetching them through an injected `fetch` (a `FakeHttp` route table or the
 * simulated world) and converting the HTML the text-only way, plus a small
 * fake screenshot per page so the attachment path is exercised. No browser,
 * no network.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pageFromHtml } from './http-session.js';
import type {
  CaptureSession,
  CaptureSessionOptions,
  PageCaptureOutcome,
  PageCaptureRequest,
  PageCapturer,
} from './types.js';

export class FakePageCapturer implements PageCapturer {
  /** Every address captured, in order. */
  readonly captured: string[] = [];
  opened = 0;
  closed = 0;

  constructor(private readonly fetchImpl: typeof fetch) {}

  async open(opts: CaptureSessionOptions): Promise<CaptureSession> {
    this.opened++;
    const fetchImpl = this.fetchImpl;
    const captured = this.captured;
    const onClose = () => {
      this.closed++;
    };
    return {
      render: 'browser',
      async capture(req: PageCaptureRequest): Promise<PageCaptureOutcome> {
        if (opts.signal?.aborted) return { ok: false, kind: 'unavailable', message: 'Stopped.' };
        captured.push(req.url);
        let res: Response;
        let finalUrl = req.url;
        try {
          // Follow redirects the way a browser would, keeping the final address.
          for (let hop = 0; ; hop++) {
            res = await fetchImpl(finalUrl, {
              headers: {
                ...(hop === 0 && req.etag ? { 'if-none-match': req.etag } : {}),
                ...(hop === 0 && req.lastModified ? { 'if-modified-since': req.lastModified } : {}),
              },
            });
            const location = res.headers.get('location');
            if (
              res.status < 300 ||
              res.status >= 400 ||
              res.status === 304 ||
              !location ||
              hop >= 5
            )
              break;
            finalUrl = new URL(location, finalUrl).href;
          }
        } catch (err) {
          return { ok: false, kind: 'failed', message: (err as Error).message };
        }
        const outcome = await pageFromHtml(
          { status: res.status, finalUrl, headers: res.headers, body: await res.text() },
          req,
        );
        if (!outcome.ok) return outcome;
        const shots = [];
        if (req.screenshots > 0) {
          await mkdir(req.stagingDir, { recursive: true });
          const bytes = Buffer.from(`fake screenshot of ${req.url}\n${outcome.markdown.length}`);
          const path = join(req.stagingDir, 'view-1.jpg');
          await writeFile(path, bytes);
          shots.push({
            path,
            name: 'view-1.jpg',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
          });
        }
        return { ...outcome, render: 'browser', screenshots: shots };
      },
      async close() {
        onClose();
      },
    };
  }
}
