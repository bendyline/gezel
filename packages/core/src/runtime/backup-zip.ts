import { validatePortablePath } from './files.js';

export const PORTABLE_BACKUP_LIMITS = Object.freeze({
  files: 5000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  archiveBytes: 72 * 1024 * 1024,
});
const table = Uint32Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function backupCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function bounds(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  )
    throw new Error('Truncated backup ZIP');
}
function pathKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase();
}
function validateEntries(entries: ReadonlyMap<string, Uint8Array>): void {
  if (entries.size > PORTABLE_BACKUP_LIMITS.files)
    throw new Error('Backup exceeds its file count limit');
  let total = 0;
  const keys = new Set<string>();
  for (const [path, data] of entries) {
    validatePortablePath(path);
    const key = pathKey(path);
    if (keys.has(key)) throw new Error('Backup contains duplicate file paths');
    keys.add(key);
    total += data.length;
    if (data.length > PORTABLE_BACKUP_LIMITS.fileBytes || total > PORTABLE_BACKUP_LIMITS.totalBytes)
      throw new Error('Backup exceeds its supported size limit');
  }
  for (const key of keys) {
    const parts = key.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (keys.has(parts.join('/'))) throw new Error('A backup file conflicts with a folder');
    }
  }
}
/** Ordinary, uncompressed ZIP; desktop backup readers can open the same archive. */
export function writeBackupZip(entries: ReadonlyMap<string, Uint8Array>): Uint8Array {
  validateEntries(entries);
  const rows = [...entries].map(([path, bytes]) => ({
    name: new TextEncoder().encode(path),
    bytes,
    crc: backupCrc32(bytes),
    offset: 0,
  }));
  let localSize = 0;
  let centralSize = 0;
  for (const row of rows) {
    row.offset = localSize;
    localSize += 30 + row.name.length + row.bytes.length;
    centralSize += 46 + row.name.length;
  }
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  const u16 = (at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (at: number, value: number) => view.setUint32(at, value, true);
  let central = localSize;
  for (const row of rows) {
    const local = row.offset;
    u32(local, 0x04034b50);
    u16(local + 4, 20);
    u16(local + 6, 0x800);
    u32(local + 14, row.crc);
    u32(local + 18, row.bytes.length);
    u32(local + 22, row.bytes.length);
    u16(local + 26, row.name.length);
    bytes.set(row.name, local + 30);
    bytes.set(row.bytes, local + 30 + row.name.length);
    u32(central, 0x02014b50);
    u16(central + 4, 20);
    u16(central + 6, 20);
    u16(central + 8, 0x800);
    u32(central + 16, row.crc);
    u32(central + 20, row.bytes.length);
    u32(central + 24, row.bytes.length);
    u16(central + 28, row.name.length);
    u32(central + 42, local);
    bytes.set(row.name, central + 46);
    central += 46 + row.name.length;
  }
  u32(central, 0x06054b50);
  u16(central + 8, rows.length);
  u16(central + 10, rows.length);
  u32(central + 12, centralSize);
  u32(central + 16, localSize);
  return bytes;
}
async function inflate(data: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('Compressed backups are not supported by this browser');
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = writer.write(data.slice()).then(() => writer.close());
  // The read side verifies size as it streams, before an attacker can allocate
  // the claimed contents of a compression bomb into one large buffer.
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > expected) throw new Error('Backup entry exceeds its declared size');
      chunks.push(chunk.value);
    }
    await writing;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writing.catch(() => {});
    throw error;
  }
  if (size !== expected) throw new Error('Backup entry size does not match');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
/** Parse and verify every entry before the caller can publish any product data. */
export async function readBackupZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes.length > PORTABLE_BACKUP_LIMITS.archiveBytes || bytes.length < 22)
    throw new Error('Backup exceeds its supported archive size or is not a ZIP');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => {
    bounds(bytes, at, 2);
    return view.getUint16(at, true);
  };
  const u32 = (at: number) => {
    bounds(bytes, at, 4);
    return view.getUint32(at, true);
  };
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)
  )
    end--;
  if (end < Math.max(0, bytes.length - 65557))
    throw new Error('Backup ZIP directory was not found');
  const count = u16(end + 10);
  const centralSize = u32(end + 12);
  const centralOffset = u32(end + 16);
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== count ||
    count > PORTABLE_BACKUP_LIMITS.files ||
    centralOffset + centralSize !== end
  )
    throw new Error('Unsupported split, ZIP64, or oversized backup');
  const entries = new Map<string, Uint8Array>();
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    bounds(bytes, cursor, 46);
    if (u32(cursor) !== 0x02014b50) throw new Error('Invalid backup directory entry');
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const packed = u32(cursor + 20);
    const size = u32(cursor + 24);
    const nameSize = u16(cursor + 28);
    const extraSize = u16(cursor + 30);
    const commentSize = u16(cursor + 32);
    const local = u32(cursor + 42);
    const attributes = u32(cursor + 38);
    const unixType = (attributes >>> 16) & 0xf000;
    if (
      flags & ~0x80e ||
      ![0, 8].includes(method) ||
      u16(cursor + 34) ||
      (unixType && unixType !== 0x8000 && unixType !== 0x4000)
    )
      throw new Error('Encrypted, linked, or unsupported backup entry');
    bounds(bytes, cursor + 46, nameSize + extraSize + commentSize);
    const rawName = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameSize),
    );
    const directory = rawName.endsWith('/');
    const name = validatePortablePath(directory ? rawName.slice(0, -1) : rawName);
    const key = pathKey(name);
    if (names.has(key)) throw new Error('Backup contains duplicate paths');
    names.add(key);
    total += size;
    if (
      size > PORTABLE_BACKUP_LIMITS.fileBytes ||
      total > PORTABLE_BACKUP_LIMITS.totalBytes ||
      (directory && size)
    )
      throw new Error('Backup exceeds its supported size limit');
    bounds(bytes, local, 30);
    if (
      u32(local) !== 0x04034b50 ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u16(local + 26) !== nameSize
    )
      throw new Error('Backup headers disagree');
    const dataOffset = local + 30 + nameSize + u16(local + 28);
    bounds(bytes, local + 30, nameSize);
    if (
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(local + 30, local + 30 + nameSize),
      ) !== rawName ||
      dataOffset + packed > centralOffset
    )
      throw new Error('Invalid backup entry location');
    bounds(bytes, dataOffset, packed);
    ranges.push([local, dataOffset + packed]);
    const content =
      method === 0
        ? bytes.slice(dataOffset, dataOffset + packed)
        : await inflate(bytes.subarray(dataOffset, dataOffset + packed), size);
    if (content.length !== size || backupCrc32(content) !== crc)
      throw new Error('Backup checksum or size does not match');
    if (!directory) entries.set(name, content);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) throw new Error('Backup directory length does not match');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index && range[0] < ranges[index - 1]![1]))
    throw new Error('Backup entries overlap');
  validateEntries(entries);
  return entries;
}
