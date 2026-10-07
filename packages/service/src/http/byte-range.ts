/**
 * One `Range: bytes=…` request against a file of `size` bytes. Media players
 * seek with these (a video opened at 1:30 asks for the bytes there, not the
 * whole file), so large catalog assets are served as 206 partial content.
 *
 * Only a single range is honoured. A multi-range request gets the whole body
 * (RFC 9110 lets a server ignore Range), and a range that starts past the end
 * is unsatisfiable (416).
 */
export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match as unknown as [string, string, string];
  if (first === '' && last === '') return null;
  if (size === 0) return 'unsatisfiable';
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null;
  return { start, end };
}
