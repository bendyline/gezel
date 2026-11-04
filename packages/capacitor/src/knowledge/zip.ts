/**
 * The entries of a `.gezk` archive, read in place. Every entry of a catalog
 * archive is STORED (knowledge/src/archive/write.ts), so a device never
 * extracts one: the reader opens each SQLite file at its offset inside the
 * archive. The checks are the extractor's (archive/read.ts) that still apply
 * without extraction; the archive's pinned sha256 vouches for the bytes.
 */
export interface ArchiveEntry {
  /** Offset of the entry's data within the archive. */
  readonly offset: number;
  readonly size: number;
}

export type RangeReader = (offset: number, length: number) => Uint8Array;

const GEZK_MIME_TYPE = 'application/vnd.gezk+zip';
const MAX_ENTRIES = 100_000;

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveFormatError('archive is too large');
  return Number(value);
}

/** The end-of-central-directory fields, ZIP64-aware. */
function centralDirectory(
  read: RangeReader,
  size: number,
): { offset: number; length: number; count: number } {
  const tail = Math.min(size, 22 + 0xffff);
  const bytes = read(size - tail, tail);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ArchiveFormatError('not a zip archive');
  let count = view.getUint16(at + 10, true);
  let length = view.getUint32(at + 12, true);
  let offset = view.getUint32(at + 16, true);
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    const locator = at - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50)
      throw new ArchiveFormatError('missing zip64 locator');
    const record = read(u64(view, locator + 8), 56);
    const r = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (r.getUint32(0, true) !== 0x06064b50)
      throw new ArchiveFormatError('missing zip64 directory');
    count = u64(r, 32);
    length = u64(r, 40);
    offset = u64(r, 48);
  }
  if (count > MAX_ENTRIES || offset + length > size)
    throw new ArchiveFormatError('invalid central directory');
  return { offset, length, count };
}

export function readArchiveIndex(read: RangeReader, size: number): Map<string, ArchiveEntry> {
  const directory = centralDirectory(read, size);
  const bytes = read(directory.offset, directory.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map<string, ArchiveEntry>();
  const seen = new Set<string>();
  const order: string[] = [];
  let at = 0;
  for (let i = 0; i < directory.count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      throw new ArchiveFormatError('corrupt central directory');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    let compressed = view.getUint32(at + 20, true);
    let uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    let local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // ZIP64 extended information: present fields appear in this order.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressed === 0xffffffff) {
          uncompressed = u64(view, field);
          field += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = u64(view, field);
          field += 8;
        }
        if (local === 0xffffffff) local = u64(view, field);
      }
      extra += 4 + length;
    }
    at = extraEnd + commentLength;
    if (name.endsWith('/')) continue;
    if (
      name.includes('\\') ||
      name.startsWith('/') ||
      /(^|\/)\.\.(\/|$)/.test(name) ||
      /^[a-zA-Z]:/.test(name)
    )
      throw new ArchiveFormatError(`unsafe path: ${name}`);
    if (flags & 0x1) throw new ArchiveFormatError(`encrypted entry: ${name}`);
    if (((external >>> 16) & 0o170000) === 0o120000)
      throw new ArchiveFormatError(`symlink entry: ${name}`);
    if (method !== 0 || compressed !== uncompressed)
      throw new ArchiveFormatError(`compressed entry: ${name}`);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new ArchiveFormatError(`duplicate entry: ${name}`);
    seen.add(lower);
    // The data follows the local header, whose own extra field may differ.
    const header = read(local, 30);
    const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (h.getUint32(0, true) !== 0x04034b50)
      throw new ArchiveFormatError(`corrupt local header: ${name}`);
    const offset = local + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    if (offset + uncompressed > size) throw new ArchiveFormatError(`truncated entry: ${name}`);
    entries.set(name, { offset, size: uncompressed });
    order.push(name);
  }
  const mimetype = entries.get('mimetype');
  if (
    order[0] !== 'mimetype' ||
    !mimetype ||
    new TextDecoder().decode(read(mimetype.offset, mimetype.size)) !== GEZK_MIME_TYPE
  )
    throw new ArchiveFormatError('not a knowledge catalog archive');
  if (!entries.has('manifest.json'))
    throw new ArchiveFormatError('catalog archive has no manifest');
  return entries;
}
