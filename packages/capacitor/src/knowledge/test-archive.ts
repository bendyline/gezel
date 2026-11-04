/** Test archives: STORED zips laid out as knowledge/src/archive/write.ts writes them. */
export interface TestEntry {
  readonly name: string;
  readonly data?: Uint8Array | string;
  readonly method?: number;
  readonly flags?: number;
  /** Unix mode, stored in the high half of the external attributes. */
  readonly mode?: number;
  /** A declared compressed size that differs from the data's. */
  readonly compressedSize?: number;
}

const encoder = new TextEncoder();
const GEZK = 'application/vnd.gezk+zip';

/** A zip of `entries`; with `zip64`, every size and offset lives in ZIP64 records. */
export function storedZip(entries: readonly TestEntry[], { zip64 = false } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  const view = (length: number) => new DataView(new ArrayBuffer(length));
  const bytes = (data: DataView) => new Uint8Array(data.buffer);
  const central: Uint8Array[] = [];
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data =
      typeof entry.data === 'string'
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    const compressed = entry.compressedSize ?? data.length;
    const at = offset;
    const local = view(30);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, entry.flags ?? 0, true);
    local.setUint16(8, entry.method ?? 0, true);
    local.setUint32(18, compressed, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    push(bytes(local));
    push(name);
    push(data);
    const header = view(46);
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 0x0314, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, entry.flags ?? 0, true);
    header.setUint16(10, entry.method ?? 0, true);
    header.setUint32(20, zip64 ? 0xffffffff : compressed, true);
    header.setUint32(24, zip64 ? 0xffffffff : data.length, true);
    header.setUint16(28, name.length, true);
    header.setUint16(30, zip64 ? 28 : 0, true);
    header.setUint32(38, ((entry.mode ?? 0o100644) << 16) >>> 0, true);
    header.setUint32(42, zip64 ? 0xffffffff : at, true);
    central.push(bytes(header), name);
    if (zip64) {
      const extra = view(28);
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, 24, true);
      extra.setBigUint64(4, BigInt(data.length), true);
      extra.setBigUint64(12, BigInt(compressed), true);
      extra.setBigUint64(20, BigInt(at), true);
      central.push(bytes(extra));
    }
  }
  const directoryAt = offset;
  for (const part of central) push(part);
  const directoryLength = offset - directoryAt;
  if (zip64) {
    const recordAt = offset;
    const record = view(56);
    record.setUint32(0, 0x06064b50, true);
    record.setBigUint64(4, BigInt(44), true);
    record.setBigUint64(24, BigInt(entries.length), true);
    record.setBigUint64(32, BigInt(entries.length), true);
    record.setBigUint64(40, BigInt(directoryLength), true);
    record.setBigUint64(48, BigInt(directoryAt), true);
    push(bytes(record));
    const locator = view(20);
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(recordAt), true);
    locator.setUint32(16, 1, true);
    push(bytes(locator));
  }
  const end = view(22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, zip64 ? 0xffff : entries.length, true);
  end.setUint16(10, zip64 ? 0xffff : entries.length, true);
  end.setUint32(12, zip64 ? 0xffffffff : directoryLength, true);
  end.setUint32(16, zip64 ? 0xffffffff : directoryAt, true);
  push(bytes(end));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A catalog archive: the mimetype first, a manifest, then `entries`. */
export function catalogArchive(entries: readonly TestEntry[] = [], options?: { zip64?: boolean }) {
  return storedZip(
    [{ name: 'mimetype', data: GEZK }, { name: 'manifest.json', data: '{}' }, ...entries],
    options,
  );
}
