import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { parseByteRange } from './byte-range.js';

export const isMediaType = (mime: string): boolean => /^(image|audio|video)\//.test(mime);

/** Call only after the route has authorized and resolved a regular file.
 * Streaming keeps originals off the JS heap; byte ranges let players seek. */
export function mediaFileResponse(args: {
  path: string;
  size: number;
  mtimeMs: number;
  request: Request;
  headers: Record<string, string>;
}): Response {
  const { path, size, mtimeMs, request } = args;
  const etag = `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
  const headers = new Headers(args.headers);
  headers.set('accept-ranges', 'bytes');
  headers.set('etag', etag);
  headers.set('x-content-type-options', 'nosniff');
  // SVG is safe as an image but must not become an active same-origin document.
  if (!headers.has('content-security-policy'))
    headers.set(
      'content-security-policy',
      "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    );
  const ifRange = request.headers.get('if-range');
  const range =
    ifRange && ifRange !== etag
      ? null
      : parseByteRange(request.headers.get('range') ?? undefined, size);
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set('content-length', String(size === 0 ? 0 : end - start + 1));
  if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`);
  const body =
    request.method === 'HEAD' || size === 0
      ? null
      : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream);
  return new Response(body, { status: range ? 206 : 200, headers });
}
