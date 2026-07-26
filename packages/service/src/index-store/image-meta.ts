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

/**
 * Full static metadata. Always succeeds — an unrecognised format still yields
 * `format: 'unknown'` plus byte length and hash.
 */
export function readImageStaticMeta(buf: Buffer): ImageStaticMeta {
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

  if (meta.format === 'png') {
    const text = readPngText(buf);
    if (Object.keys(text).length > 0) meta.pngText = text;
  } else if (meta.format === 'jpeg') {
    const exif = readJpegExif(buf);
    if (exif) {
      if (Object.keys(exif.exif).length > 0) meta.exif = exif.exif;
      // Parsed but withheld. See ImageStaticMetaSchema's doc comment: the
      // digest can be forwarded to a cloud provider, and the user pasted a
      // photo to ask a question, not to disclose where they were.
      if (exif.gps) meta.gpsRedacted = true;
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
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
} as const;

const EXIF_SUB_TAGS = { dateTimeOriginal: 0x9003, lensModel: 0xa434 } as const;
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
function readJpegExif(buf: Buffer): { exif: ImageExif; gps?: { lat: number; lon: number } } | null {
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
      return parseTiff(buf, off + 10);
    }
    off += 2 + len;
  }
  return null;
}

function parseTiff(
  buf: Buffer,
  base: number,
): { exif: ImageExif; gps?: { lat: number; lon: number } } | null {
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
  const orientation = entries.get(EXIF_TAGS.orientation);
  if (typeof orientation === 'number' && orientation >= 1 && orientation <= 8) {
    exif.orientation = orientation;
  }

  const exifPtr = entries.get(EXIF_TAGS.exifIfd);
  if (typeof exifPtr === 'number') {
    const sub = readIfd(cur, base + exifPtr);
    if (sub) {
      exif.dateTimeOriginal = str(sub, EXIF_SUB_TAGS.dateTimeOriginal);
      exif.lensModel = str(sub, EXIF_SUB_TAGS.lensModel);
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

  return gps ? { exif, gps } : { exif };
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
    if (size === 0) continue;
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
        vals.push(den === 0 ? 0 : readU32(cur, valueAt + r * 8) / den);
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
