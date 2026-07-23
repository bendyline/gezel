/**
 * Zip-bomb / decompression-DoS guard for ZIP-container documents (OOXML:
 * docx/pptx/xlsx). It inspects the ZIP central directory — fixed-layout
 * metadata — to learn each entry's declared compressed and uncompressed size
 * *without inflating anything*. A classic zip bomb declares a tiny compressed
 * payload that expands to gigabytes; we reject before the parser ever calls
 * inflate. Reading the central directory is structurally safe (no content is
 * decompressed), so this runs in-process as the cheap first line of defense
 * ahead of the out-of-process parse sandbox.
 */

export interface ArchiveLimits {
  maxEntries: number;
  /** Largest allowed declared uncompressed size for any single entry. */
  maxEntryUncompressedBytes: number;
  /** Largest allowed sum of declared uncompressed sizes across all entries. */
  maxTotalUncompressedBytes: number;
  /** Largest allowed uncompressed/compressed expansion ratio (per archive). */
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 4096,
  maxEntryUncompressedBytes: 100 * 1024 * 1024, // 100 MB
  maxTotalUncompressedBytes: 500 * 1024 * 1024, // 500 MB
  maxCompressionRatio: 200,
};

export interface ArchiveGuardResult {
  ok: boolean;
  /** Human-readable rejection reason, set only when `ok` is false. */
  reason?: string;
  entries?: number;
  totalUncompressed?: number;
  totalCompressed?: number;
}

const EOCD_SIG = 0x06054b50; // End of Central Directory
const CDFH_SIG = 0x02014b50; // Central Directory File Header
const ZIP64_EOCD_SIG = 0x06064b50; // ZIP64 End of Central Directory
const ZIP64_LOCATOR_SIG = 0x07064b50; // ZIP64 EOCD locator
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/**
 * Inspect a ZIP container's central directory against `limits`. Returns
 * `{ ok: false, reason }` for malformed archives and for anything exceeding a
 * limit — the caller should refuse to parse and keep the raw bytes quarantined.
 */
export function guardZipArchive(
  bytes: Uint8Array,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ArchiveGuardResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  if (!eocd) return { ok: false, reason: 'no ZIP end-of-central-directory record' };

  let entryCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  // ZIP64: sentinel values in the classic EOCD point at a ZIP64 record.
  if (entryCount === U16_MAX || cdOffset === U32_MAX) {
    const z64 = findZip64Eocd(bytes, view, eocd);
    if (!z64) return { ok: false, reason: 'ZIP64 archive without a parseable ZIP64 EOCD' };
    entryCount = z64.entryCount;
    cdOffset = z64.cdOffset;
  }

  if (entryCount > limits.maxEntries) {
    return { ok: false, reason: `archive has ${entryCount} entries (limit ${limits.maxEntries})` };
  }

  let totalUncompressed = 0;
  let totalCompressed = 0;
  let offset = cdOffset;
  let seen = 0;
  while (seen < entryCount) {
    if (offset + 46 > bytes.length) {
      return { ok: false, reason: 'central directory truncated' };
    }
    if (view.getUint32(offset, true) !== CDFH_SIG) {
      return { ok: false, reason: 'corrupt central directory header' };
    }
    let compressed = view.getUint32(offset + 20, true);
    let uncompressed = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);

    if (compressed === U32_MAX || uncompressed === U32_MAX) {
      const z64 = readZip64Extra(view, offset + 46 + nameLen, extraLen, uncompressed, compressed);
      uncompressed = z64.uncompressed;
      compressed = z64.compressed;
    }

    if (uncompressed > limits.maxEntryUncompressedBytes) {
      return {
        ok: false,
        reason: `entry expands to ${uncompressed} bytes (limit ${limits.maxEntryUncompressedBytes})`,
      };
    }
    totalUncompressed += uncompressed;
    totalCompressed += compressed;
    seen++;
    offset += 46 + nameLen + extraLen + commentLen;
  }

  if (totalUncompressed > limits.maxTotalUncompressedBytes) {
    return {
      ok: false,
      reason: `archive expands to ${totalUncompressed} bytes total (limit ${limits.maxTotalUncompressedBytes})`,
      entries: entryCount,
      totalUncompressed,
      totalCompressed,
    };
  }
  // Ratio guard — the signature of a bomb is a huge expansion factor. Ignore
  // tiny archives where the ratio is noise (stored metadata, near-zero bytes).
  if (totalCompressed > 1024 && totalUncompressed / totalCompressed > limits.maxCompressionRatio) {
    return {
      ok: false,
      reason: `archive compression ratio ${Math.round(totalUncompressed / totalCompressed)}:1 exceeds ${limits.maxCompressionRatio}:1`,
      entries: entryCount,
      totalUncompressed,
      totalCompressed,
    };
  }

  return { ok: true, entries: entryCount, totalUncompressed, totalCompressed };
}

/** Scan backward from EOF for the EOCD signature (it may trail a comment). */
function findEocd(bytes: Uint8Array, view: DataView): number | null {
  const min = 22;
  if (bytes.length < min) return null;
  // The comment can be up to 65535 bytes; bound the search window.
  const start = Math.max(0, bytes.length - (min + U16_MAX));
  for (let i = bytes.length - min; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return null;
}

function findZip64Eocd(
  bytes: Uint8Array,
  view: DataView,
  eocd: number,
): { entryCount: number; cdOffset: number } | null {
  // The ZIP64 EOCD locator sits 20 bytes before the classic EOCD.
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIG) return null;
  // 64-bit offset of the ZIP64 EOCD; we only support archives within 2^53-1.
  const z64Lo = view.getUint32(locator + 8, true);
  const z64Hi = view.getUint32(locator + 12, true);
  const z64 = z64Hi * 0x1_0000_0000 + z64Lo;
  if (z64 + 56 > bytes.length || view.getUint32(z64, true) !== ZIP64_EOCD_SIG) return null;
  const countLo = view.getUint32(z64 + 32, true);
  const countHi = view.getUint32(z64 + 36, true);
  const cdLo = view.getUint32(z64 + 48, true);
  const cdHi = view.getUint32(z64 + 52, true);
  return {
    entryCount: countHi * 0x1_0000_0000 + countLo,
    cdOffset: cdHi * 0x1_0000_0000 + cdLo,
  };
}

/** Pull true sizes from the ZIP64 extended-information extra field (id 0x0001). */
function readZip64Extra(
  view: DataView,
  extraStart: number,
  extraLen: number,
  uncompressed32: number,
  compressed32: number,
): { uncompressed: number; compressed: number } {
  let p = extraStart;
  const end = extraStart + extraLen;
  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const size = view.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      let uncompressed = uncompressed32;
      let compressed = compressed32;
      // The ZIP64 record carries only the fields that overflowed, in order:
      // uncompressed, then compressed.
      if (uncompressed32 === U32_MAX && q + 8 <= end) {
        uncompressed = Number(view.getBigUint64(q, true));
        q += 8;
      }
      if (compressed32 === U32_MAX && q + 8 <= end) {
        compressed = Number(view.getBigUint64(q, true));
      }
      return { uncompressed, compressed };
    }
    p += 4 + size;
  }
  // No ZIP64 extra despite the sentinel — treat the sentinel as the size so the
  // single-entry cap trips rather than silently undercounting.
  return { uncompressed: uncompressed32, compressed: compressed32 };
}
