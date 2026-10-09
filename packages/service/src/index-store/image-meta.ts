/**
 * Zero-dependency image metadata reader — the deterministic, no-model tier of
 * the image pipeline.
 *
 * Two entry points:
 *   - {@link readImageMeta} — dimensions only. Unchanged shape; the content
 *     indexer has depended on it since Phase 5.
 *   - {@link readImageStaticMeta} — everything: hash, PNG text chunks, an EXIF
 *     subset, and a screenshot heuristic. Never returns null, because format
 *     and byte length are always knowable. That's what makes
 *     `status: 'static-only'` a usable answer when no vision model is
 *     available — a ComfyUI PNG's `parameters` chunk is frequently a better
 *     description than a small model would write.
 *
 * Stays dependency-free on purpose: `zlib` and `crypto` are Node built-ins,
 * and pulling in a real image library (`sharp` et al) for header parsing would
 * add a platform-specific native binary to every install.
 */

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { ImageExif, ImageStaticMeta } from '@bendyline/gezel';

export interface ImageMeta {
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  width: number;
  height: number;
}

export function readImageMeta(buf: Buffer): ImageMeta | null {
  if (buf.length < 24) return null;

  // PNG: 8-byte signature, then IHDR (width @16, height @20, big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", width/height little-endian @6/@8.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // JPEG: scan segments for a Start-Of-Frame marker (0xFFC0–C3, C5–C7, C9–CB).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1]!;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb);
      if (isSof) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return { format: 'jpeg', width, height };
      }
      // Skip this segment using its length field.
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
    return null;
  }

  // WebP: "RIFF"...."WEBP" then a VP8 / VP8L / VP8X chunk.
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ' && buf.length >= 30) {
      // Lossy: dimensions are 14-bit at offset 26/28 (mask off the top bits).
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { format: 'webp', width, height };
    }
    if (fourcc === 'VP8L' && buf.length >= 25) {
      // Lossless: 1 signature byte then 14+14 bits packed.
      const b0 = buf[21]!;
      const b1 = buf[22]!;
      const b2 = buf[23]!;
      const b3 = buf[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { format: 'webp', width, height };
    }
    if (fourcc === 'VP8X' && buf.length >= 30) {
      // Extended: 24-bit (value+1) at 24/27.
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { format: 'webp', width, height };
    }
  }

  return null;
}

/** Bounds on PNG text extraction — this content is attacker-authored. */
const MAX_TEXT_KEYS = 32;
const MAX_TEXT_VALUE_CHARS = 4096;

export interface ReadImageStaticMetaOptions {
  /**
   * Include GPS coordinates in the result.
   *
   * Off everywhere except the explicit `read_image_metadata` MCP tool, whose
   * invocation lands in the history log. The chat digest path must never set
   * this: a pasted phone photo carries the user's location, and that digest
   * can be forwarded to a cloud provider.
   */
  includeLocation?: boolean;
  /** The file's name, which tells a DNG/NEF/ARW from a plain TIFF with the same header. */
  fileName?: string;
}

/**
 * Full static metadata. Always succeeds — an unrecognised format still yields
 * `format: 'unknown'` plus byte length and hash.
 */
export function readImageStaticMeta(
  buf: Buffer,
  opts?: ReadImageStaticMetaOptions,
): ImageStaticMeta {
  const dims = readImageMeta(buf);
  const meta: ImageStaticMeta = {
    format: dims?.format ?? (looksLikeSvg(buf) ? 'svg' : 'unknown'),
    byteLength: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  if (dims) {
    meta.width = dims.width;
    meta.height = dims.height;
  }

  let exifSource: TiffExif | null = null;
  if (meta.format === 'unknown') {
    const heif = readHeifHeader(buf);
    if (heif) {
      meta.format = 'heic';
      if (heif.width && heif.height) {
        meta.width = heif.width;
        meta.height = heif.height;
      }
      const at = heif.exif;
      if (at && at.offset + at.length <= buf.length) {
        exifSource = exifFromHeifItem(buf.subarray(at.offset, at.offset + at.length));
      }
    } else if (isRawHeader(buf, opts?.fileName)) {
      meta.format = 'raw';
      const parsed = buf.toString('ascii', 0, 15) === RAF_MAGIC ? rafExif(buf) : parseTiff(buf, 0);
      if (parsed?.pixels) {
        meta.width = parsed.pixels.width;
        meta.height = parsed.pixels.height;
      }
      exifSource = parsed;
    }
  }

  if (meta.format === 'png') {
    const text = readPngText(buf);
    if (Object.keys(text).length > 0) meta.pngText = text;
  } else if (meta.format === 'jpeg' || exifSource) {
    const exif = exifSource ?? readJpegExif(buf);
    if (exif) {
      if (Object.keys(exif.exif).length > 0) meta.exif = exif.exif;
      // Parsed but withheld by default. See ImageStaticMetaSchema's doc
      // comment: the digest can be forwarded to a cloud provider, and the user
      // pasted a photo to ask a question, not to disclose where they were.
      if (exif.gps) {
        if (opts?.includeLocation) meta.gps = exif.gps;
        else meta.gpsRedacted = true;
      }
    }
  }

  const screenshot = looksLikeScreenshot(meta);
  if (screenshot) meta.likelyScreenshot = true;
  return meta;
}

function looksLikeSvg(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * Walk PNG chunks collecting `tEXt` / `zTXt` / `iTXt`.
 *
 * Text chunks are legal both before and after `IDAT`, so we walk to `IEND`
 * rather than stopping at the first image data — but `IDAT` payloads are
 * skipped by their length field, so a large PNG costs a handful of seeks.
 */
function readPngText(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 8;
  while (off + 8 <= buf.length && Object.keys(out).length < MAX_TEXT_KEYS) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    // A corrupt length must not send us past the buffer or backwards.
    if (len > buf.length - dataStart) break;
    if (type === 'IEND') break;
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const data = buf.subarray(dataStart, dataStart + len);
      const entry = decodeTextChunk(type, data);
      if (entry && !out[entry.key]) out[entry.key] = entry.value;
    }
    off = dataStart + len + 4;
  }
  return out;
}

function decodeTextChunk(type: string, data: Buffer): { key: string; value: string } | null {
  const nul = data.indexOf(0);
  if (nul <= 0) return null;
  const key = data.toString('latin1', 0, nul);
  let value: string;
  try {
    if (type === 'tEXt') {
      value = data.toString('latin1', nul + 1);
    } else if (type === 'zTXt') {
      // keyword \0 compressionMethod(1) compressedText
      value = inflateSync(data.subarray(nul + 2)).toString('latin1');
    } else {
      // iTXt: keyword \0 compressionFlag(1) compressionMethod(1)
      //       languageTag \0 translatedKeyword \0 text
      const compressed = data[nul + 1] === 1;
      const langEnd = data.indexOf(0, nul + 3);
      if (langEnd < 0) return null;
      const transEnd = data.indexOf(0, langEnd + 1);
      if (transEnd < 0) return null;
      const body = data.subarray(transEnd + 1);
      value = compressed ? inflateSync(body).toString('utf8') : body.toString('utf8');
    }
  } catch {
    // Truncated or bogus zlib stream — skip the chunk, keep the rest.
    return null;
  }
  if (!value) return null;
  return { key, value: value.slice(0, MAX_TEXT_VALUE_CHARS) };
}

const EXIF_TAGS = {
  imageDescription: 0x010e,
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  software: 0x0131,
  dateTimeModified: 0x0132,
  artist: 0x013b,
  copyright: 0x8298,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
} as const;

const EXIF_SUB_TAGS = {
  dateTimeOriginal: 0x9003,
  dateTimeDigitized: 0x9004,
  offsetTimeOriginal: 0x9011,
  lensModel: 0xa434,
} as const;
const EXIF_NUMERIC_TAGS = {
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  focalLength: 0x920a,
  focalLengthIn35mmFilm: 0xa405,
  flash: 0x9209,
  whiteBalance: 0xa403,
  exposureProgram: 0x8822,
} as const;
const GPS_TAGS = { latRef: 0x0001, lat: 0x0002, lonRef: 0x0003, lon: 0x0004 } as const;

interface TiffCursor {
  buf: Buffer;
  /** Offsets in EXIF are relative to the TIFF header, not the file. */
  base: number;
  le: boolean;
}

/**
 * Minimal APP1/Exif reader. Reuses the same segment walk the SOF scanner in
 * {@link readImageMeta} does — APP1 is just another marker with a length field.
 */
function readJpegExif(buf: Buffer): TiffExif | null {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1]!;
    // Start of scan — entropy-coded data follows, no more metadata segments.
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;
    if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 10) === 'Exif\0\0') {
      if (off + 2 + len > buf.length) return null;
      return parseTiff(buf.subarray(off + 10, off + 2 + len), 0);
    }
    off += 2 + len;
  }
  return null;
}

interface TiffExif {
  exif: ImageExif;
  gps?: { lat: number; lon: number };
  /** EXIF PixelX/YDimension: the photo's size, where IFD0 may describe a thumbnail. */
  pixels?: { width: number; height: number };
}

function parseTiff(buf: Buffer, base: number): TiffExif | null {
  if (base + 8 > buf.length) return null;
  const bom = buf.toString('ascii', base, base + 2);
  if (bom !== 'II' && bom !== 'MM') return null;
  const le = bom === 'II';
  const cur: TiffCursor = { buf, base, le };
  const ifd0 = readU32(cur, base + 4);
  const entries = readIfd(cur, base + ifd0);
  if (!entries) return null;

  const exif: ImageExif = {};
  const str = (m: Map<number, TiffValue>, tag: number): string | undefined => {
    const v = m.get(tag);
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  exif.imageDescription = str(entries, EXIF_TAGS.imageDescription);
  exif.make = str(entries, EXIF_TAGS.make);
  exif.model = str(entries, EXIF_TAGS.model);
  exif.software = str(entries, EXIF_TAGS.software);
  exif.dateTimeModified = str(entries, EXIF_TAGS.dateTimeModified);
  exif.artist = str(entries, EXIF_TAGS.artist);
  exif.copyright = str(entries, EXIF_TAGS.copyright);
  const orientation = entries.get(EXIF_TAGS.orientation);
  if (typeof orientation === 'number' && orientation >= 1 && orientation <= 8) {
    exif.orientation = orientation;
  }

  let pixels: TiffExif['pixels'];
  const exifPtr = entries.get(EXIF_TAGS.exifIfd);
  if (typeof exifPtr === 'number') {
    const sub = readIfd(cur, base + exifPtr, true);
    const width = sub?.get(0xa002);
    const height = sub?.get(0xa003);
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      pixels = { width, height };
    }
    if (sub) {
      for (const [key, tag] of Object.entries(EXIF_SUB_TAGS)) {
        const value = str(sub, tag);
        if (value !== undefined) exif[key as keyof typeof EXIF_SUB_TAGS] = value;
      }
      for (const [key, tag] of Object.entries(EXIF_NUMERIC_TAGS)) {
        const raw = sub.get(tag);
        const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
        const permitsZero = ['flash', 'whiteBalance', 'exposureProgram'].includes(key);
        if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          (permitsZero ? Number.isInteger(value) && value >= 0 : value > 0)
        ) {
          exif[key as keyof typeof EXIF_NUMERIC_TAGS] = value;
        }
      }
    }
  }
  for (const k of Object.keys(exif) as (keyof ImageExif)[]) {
    if (exif[k] === undefined) delete exif[k];
  }

  let gps: { lat: number; lon: number } | undefined;
  const gpsPtr = entries.get(EXIF_TAGS.gpsIfd);
  if (typeof gpsPtr === 'number') {
    const g = readIfd(cur, base + gpsPtr, true);
    const lat = g?.get(GPS_TAGS.lat);
    const lon = g?.get(GPS_TAGS.lon);
    const latRef = g?.get(GPS_TAGS.latRef);
    const lonRef = g?.get(GPS_TAGS.lonRef);
    if (Array.isArray(lat) && Array.isArray(lon)) {
      const latDeg = dmsToDecimal(lat) * (latRef === 'S' ? -1 : 1);
      const lonDeg = dmsToDecimal(lon) * (lonRef === 'W' ? -1 : 1);
      if (Number.isFinite(latDeg) && Number.isFinite(lonDeg)) {
        gps = { lat: latDeg, lon: lonDeg };
      }
    }
  }

  return { exif, ...(gps ? { gps } : {}), ...(pixels ? { pixels } : {}) };
}

function dmsToDecimal(parts: number[]): number {
  const [d = 0, m = 0, s = 0] = parts;
  return d + m / 60 + s / 3600;
}

type TiffValue = string | number | number[];

function readU16(cur: TiffCursor, at: number): number {
  return cur.le ? cur.buf.readUInt16LE(at) : cur.buf.readUInt16BE(at);
}
function readU32(cur: TiffCursor, at: number): number {
  return cur.le ? cur.buf.readUInt32LE(at) : cur.buf.readUInt32BE(at);
}

/**
 * Read one IFD into a tag→value map. `wantRationals` keeps RATIONAL arrays
 * (needed for GPS coordinates); elsewhere they're noise.
 */
function readIfd(
  cur: TiffCursor,
  at: number,
  wantRationals = false,
): Map<number, TiffValue> | null {
  const { buf } = cur;
  if (at + 2 > buf.length) return null;
  const count = readU16(cur, at);
  // A bogus count would make us scan far past the segment.
  if (count > 512) return null;
  const out = new Map<number, TiffValue>();
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > buf.length) break;
    const tag = readU16(cur, e);
    const type = readU16(cur, e + 2);
    const num = readU32(cur, e + 4);
    const size = tiffTypeSize(type);
    if (size === 0 || num === 0) continue;
    const bytes = size * num;
    const valueAt = bytes <= 4 ? e + 8 : cur.base + readU32(cur, e + 8);
    if (valueAt < 0 || valueAt + bytes > buf.length) continue;
    if (type === 2) {
      const raw = buf.toString('latin1', valueAt, valueAt + num);
      out.set(tag, raw.replace(/\0.*$/, '').trim());
    } else if (type === 3) {
      out.set(tag, readU16(cur, valueAt));
    } else if (type === 4) {
      out.set(tag, readU32(cur, valueAt));
    } else if (type === 5 && wantRationals) {
      const vals: number[] = [];
      for (let r = 0; r < num; r++) {
        const den = readU32(cur, valueAt + r * 8 + 4);
        vals.push(den === 0 ? Number.NaN : readU32(cur, valueAt + r * 8) / den);
      }
      out.set(tag, vals);
    }
  }
  return out;
}

function tiffTypeSize(type: number): number {
  switch (type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return 1;
    case 3:
    case 8:
      return 2;
    case 4:
    case 9:
    case 11:
      return 4;
    case 5:
    case 10:
    case 12:
      return 8;
    default:
      return 0;
  }
}

const SCREENSHOT_SOFTWARE =
  /screenshot|screen shot|snipping|greenshot|shottr|cleanshot|flameshot|lightshot|snagit|skitch/i;

/**
 * Cheap, deterministic "is this a screen capture?" guess. Drives `auto` mode
 * selection without paying a classifier call — and a wrong guess degrades into
 * a plain description, which still reads visible text.
 *
 * Photos are JPEG with camera EXIF; document scans are portrait; screen
 * captures are wide PNGs with no camera provenance.
 */
function looksLikeScreenshot(meta: ImageStaticMeta): boolean {
  if (meta.exif?.make || meta.exif?.model) return false;
  const software = meta.pngText?.Software ?? meta.exif?.software;
  if (software && SCREENSHOT_SOFTWARE.test(software)) return true;
  if (meta.format !== 'png') return false;
  if (!meta.width || !meta.height) return false;
  if (meta.width < 1024) return false;
  const aspect = meta.width / meta.height;
  return aspect >= 1.2 && aspect <= 2.2;
}

// ── HEIC / HEIF (ISOBMFF) ──────────────────────────────────────────────

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
  'heif',
]);

/** Where the Exif item sits in a HEIF file, and the primary image's size. */
export interface HeifHeader {
  width?: number;
  height?: number;
  /** Absolute file range of the Exif item's payload, when the file has one. */
  exif?: { offset: number; length: number };
}

interface Box {
  type: string;
  /** Payload start (after the header) and end, absolute. */
  start: number;
  end: number;
}

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size };
    off += size;
  }
}

/**
 * Read a HEIF/HEIC header: the `ftyp` brand, then `meta`'s item info, item
 * locations and image-size properties. Only reads `buf` (the file's head);
 * the Exif payload usually sits in `mdat` further on, so callers fetch
 * `exif` themselves when it falls outside. Null when this is not HEIF.
 */
export function readHeifHeader(buf: Buffer): HeifHeader | null {
  if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const ftypSize = buf.readUInt32BE(0);
  const brands: string[] = [];
  for (let o = 8; o + 4 <= Math.min(ftypSize, buf.length); o += 4) {
    if (o === 12) continue;
    brands.push(buf.toString('latin1', o, o + 4));
  }
  if (!brands.some((b) => HEIF_BRANDS.has(b))) return null;

  const out: HeifHeader = {};
  for (const top of boxes(buf, 0, buf.length)) {
    if (top.type !== 'meta') continue;
    const metaStart = top.start + 4;
    let exifItem: number | null = null;
    const locations = new Map<number, { offset: number; length: number }>();
    let largest = 0;
    for (const box of boxes(buf, metaStart, top.end)) {
      if (box.type === 'iinf') exifItem = heifExifItemId(buf, box);
      else if (box.type === 'iloc') readIloc(buf, box, locations);
      else if (box.type === 'iprp') {
        for (const ipco of boxes(buf, box.start, box.end)) {
          if (ipco.type !== 'ipco') continue;
          for (const prop of boxes(buf, ipco.start, ipco.end)) {
            if (prop.type !== 'ispe' || prop.start + 12 > prop.end) continue;
            const width = buf.readUInt32BE(prop.start + 4);
            const height = buf.readUInt32BE(prop.start + 8);
            // The primary image is the largest; tiles and thumbnails are smaller.
            if (width * height > largest) {
              largest = width * height;
              out.width = width;
              out.height = height;
            }
          }
        }
      }
    }
    if (exifItem !== null) {
      const at = locations.get(exifItem);
      if (at) out.exif = at;
    }
    break;
  }
  return out;
}

function heifExifItemId(buf: Buffer, iinf: Box): number | null {
  const version = buf[iinf.start]!;
  const entriesAt = iinf.start + 4 + (version === 0 ? 2 : 4);
  for (const infe of boxes(buf, entriesAt, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = buf[infe.start]!;
    if (v < 2) continue;
    const idSize = v === 2 ? 2 : 4;
    const id = idSize === 2 ? buf.readUInt16BE(infe.start + 4) : buf.readUInt32BE(infe.start + 4);
    const typeAt = infe.start + 4 + idSize + 2;
    if (typeAt + 4 > infe.end) continue;
    if (buf.toString('latin1', typeAt, typeAt + 4) === 'Exif') return id;
  }
  return null;
}

function readUInt(buf: Buffer, at: number, size: number): number {
  if (size === 0) return 0;
  if (size === 4) return buf.readUInt32BE(at);
  if (size === 8) return Number(buf.readBigUInt64BE(at));
  return buf.readUInt16BE(at);
}

function readIloc(
  buf: Buffer,
  iloc: Box,
  out: Map<number, { offset: number; length: number }>,
): void {
  const version = buf[iloc.start]!;
  let at = iloc.start + 4;
  const sizes = buf.readUInt16BE(at);
  at += 2;
  const offsetSize = (sizes >> 12) & 0xf;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf;
  const indexSize = version === 1 || version === 2 ? sizes & 0xf : 0;
  const idSize = version < 2 ? 2 : 4;
  const count = version < 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
  at += version < 2 ? 2 : 4;
  for (let i = 0; i < count && at < iloc.end; i++) {
    const id = readUInt(buf, at, idSize);
    at += idSize;
    let method = 0;
    if (version === 1 || version === 2) {
      method = buf.readUInt16BE(at) & 0xf;
      at += 2;
    }
    at += 2; // data_reference_index
    const base = readUInt(buf, at, baseOffsetSize);
    at += baseOffsetSize;
    const extents = buf.readUInt16BE(at);
    at += 2;
    for (let e = 0; e < extents; e++) {
      at += indexSize;
      const offset = readUInt(buf, at, offsetSize);
      at += offsetSize;
      const length = readUInt(buf, at, lengthSize);
      at += lengthSize;
      // File-offset items with one extent: the only layout Exif uses in practice.
      if (e === 0 && method === 0) out.set(id, { offset: base + offset, length });
    }
  }
}

/** A HEIF Exif item: a 4-byte offset to the TIFF header, then the Exif block. */
export function exifFromHeifItem(item: Buffer): TiffExif | null {
  if (item.length < 12) return null;
  const tiffAt = 4 + item.readUInt32BE(0);
  return tiffAt < item.length ? parseTiff(item, tiffAt) : null;
}

// ── Camera RAW ───────────────────────────────────────────────────────────

const RAF_MAGIC = 'FUJIFILMCCD-RAW';

/** Camera RAW extensions gezel reads; CR3 is ISOBMFF and not among them yet. */
export const RAW_EXTS = new Set(['dng', 'cr2', 'nef', 'arw', 'raf', 'orf', 'rw2']);

/**
 * A camera RAW: Fujifilm RAF, Olympus ORF, Panasonic RW2 and Canon CR2 by
 * their own magic; DNG, NEF and ARW share a plain TIFF header, so those count
 * only when `fileName` carries a RAW extension. A TIFF is not a RAW.
 */
export function isRawHeader(buf: Buffer, fileName?: string): boolean {
  if (buf.length < 16) return false;
  if (buf.toString('ascii', 0, 15) === RAF_MAGIC) return true;
  const head = buf.toString('latin1', 0, 4);
  if (head === 'IIRO' || head === 'IIRS' || head === 'MMOR' || head === 'IIU\0') return true;
  if (head !== 'II*\0' && head !== 'MM\0*') return false;
  if (buf.toString('latin1', 8, 10) === 'CR') return true;
  const ext = fileName?.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return ext !== undefined && RAW_EXTS.has(ext);
}

/** RAF keeps its metadata in the JPEG preview's APP1 segment. */
function rafExif(buf: Buffer): TiffExif | null {
  const preview = rafPreview(buf);
  return preview ? readJpegExif(preview) : null;
}

function rafPreview(buf: Buffer): Buffer | null {
  if (buf.length < 92) return null;
  return jpegAt(buf, buf.readUInt32BE(84), buf.readUInt32BE(88));
}

function jpegAt(buf: Buffer, offset: number, length: number): Buffer | null {
  if (offset <= 0 || length < 4 || offset + length > buf.length) return null;
  if (buf[offset] !== 0xff || buf[offset + 1] !== 0xd8) return null;
  return buf.subarray(offset, offset + length);
}

/**
 * The largest JPEG preview a RAW file carries: what a camera shows on its own
 * screen, and plenty to describe or embed. Walks IFD0, the next-IFD chain and
 * SubIFDs for JPEGInterchangeFormat pairs and old-style JPEG strips, plus the
 * RAF header and RW2's JpgFromRaw. Needs the whole file. Null when none.
 */
export function rawPreviewJpeg(buf: Buffer): Buffer | null {
  if (buf.toString('ascii', 0, 15) === RAF_MAGIC) return rafPreview(buf);
  const head = buf.toString('latin1', 0, 4);
  if (!['II*\0', 'MM\0*', 'IIRO', 'IIRS', 'MMOR', 'IIU\0'].includes(head)) return null;
  const le = buf[0] === 0x49;
  const cur: TiffCursor = { buf, base: 0, le };
  const found: Buffer[] = [];
  const seen = new Set<number>();
  const visit = (at: number, depth: number): void => {
    if (depth > 6 || at <= 0 || at + 2 > buf.length || seen.has(at)) return;
    seen.add(at);
    const count = readU16(cur, at);
    if (count === 0 || count > 512) return;
    let jpegOffset = 0;
    let jpegLength = 0;
    let stripOffset = 0;
    let stripLength = 0;
    let compression = 0;
    const subIfds: number[] = [];
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = readU16(cur, e);
      const type = readU16(cur, e + 2);
      const num = readU32(cur, e + 4);
      const inline = (type === 3 ? 2 : 4) * num <= 4;
      const value = type === 3 && inline ? readU16(cur, e + 8) : readU32(cur, e + 8);
      if (tag === 0x0201) jpegOffset = value;
      else if (tag === 0x0202) jpegLength = value;
      else if (tag === 0x0103) compression = value;
      else if (tag === 0x0111 && num === 1) stripOffset = value;
      else if (tag === 0x0117 && num === 1) stripLength = value;
      else if (tag === 0x002e && type === 7) {
        const jpeg = jpegAt(buf, value, num);
        if (jpeg) found.push(jpeg);
      } else if (tag === 0x014a) {
        if (num === 1) subIfds.push(value);
        else {
          for (let n = 0; n < num && value + n * 4 + 4 <= buf.length; n++) {
            subIfds.push(readU32(cur, value + n * 4));
          }
        }
      }
    }
    const preview = jpegAt(buf, jpegOffset, jpegLength);
    if (preview) found.push(preview);
    // Compression 6 is a displayable JPEG (CR2's full-size preview); 7 is a
    // DNG's lossless sensor data, which no viewer can show.
    if (compression === 6) {
      const strip = jpegAt(buf, stripOffset, stripLength);
      if (strip) found.push(strip);
    }
    for (const sub of subIfds) visit(sub, depth + 1);
    const nextAt = at + 2 + count * 12;
    if (nextAt + 4 <= buf.length) visit(readU32(cur, nextAt), depth + 1);
  };
  visit(readU32(cur, 4), 0);
  return found.sort((a, b) => b.length - a.length)[0] ?? null;
}
