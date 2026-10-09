import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@bendyline/gezel';
import {
  MAX_IMAGE_BYTES,
  type RgbImage,
  decodeImage,
  resizeBicubic,
  resizeBilinear,
  rgbaToRgb,
} from '../memory/image-pixels.js';
import { readImageMeta } from './image-meta.js';
import { toDecodableRaster } from './raster-normalize.js';

const log = createLogger('index');
const execFileAsync = promisify(execFile);
const jpeg = createRequire(import.meta.url)('jpeg-js') as typeof import('jpeg-js');

/** Thumbnail widths served; a request snaps up to the next one so the cache stays small. */
export const THUMB_WIDTHS = [160, 320, 640] as const;
/** The cache's size cap; the least recently served thumbnails go first. */
export const THUMB_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const JPEG_QUALITY = 72;
const SIPS_TIMEOUT_MS = 30_000;
/** Thumbnails made at once; a grid asks for dozens, and each is a decode. */
const MAX_CONCURRENT = 3;
const PRUNE_INTERVAL_MS = 5 * 60_000;
/** Formats a browser shows as they are, when a photo is already small enough. */
const WEB_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);
/** Enough of a photo to find its size: the JPEG frame header can sit behind a large Exif block. */
const HEAD_BYTES = 256 * 1024;

export interface Thumbnail {
  bytes: Buffer;
  mimeType: string;
  /** Changes when the photo or the width does. */
  etag: string;
}

export interface ThumbnailRequest {
  /** The project's thumbnail cache (`projectThumbnailsDir`). */
  cacheDir: string;
  /** Absolute path of the photo, already checked to sit inside the workspace. */
  absPath: string;
  /** Workspace-relative path, part of the cache key. */
  relPath: string;
  width: number;
  platform?: NodeJS.Platform;
}

export function snapThumbWidth(requested: number | undefined): number {
  const w = Number.isFinite(requested) ? Number(requested) : THUMB_WIDTHS[1];
  return THUMB_WIDTHS.find((t) => t >= w) ?? 640;
}

let active = 0;
const waiting: Array<() => void> = [];
const inFlight = new Map<string, Promise<Thumbnail | null>>();
let lastPrune = 0;

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * A small JPEG of a workspace photo, made once and cached per account. On
 * macOS `sips` reads every format the system can (HEIC, RAW, TIFF, WebP);
 * elsewhere JPEG and PNG decode in JavaScript and RAW through its embedded
 * preview. Null when this machine cannot read the format. A photo already no
 * larger than the width is served as it is.
 */
export async function thumbnailFor(req: ThumbnailRequest): Promise<Thumbnail | null> {
  const info = await stat(req.absPath).catch(() => null);
  if (!info?.isFile()) return null;
  const width = snapThumbWidth(req.width);
  const key = createHash('sha256')
    .update(`${req.relPath}\0${info.size}\0${Math.round(info.mtimeMs)}\0${width}`)
    .digest('hex');
  const etag = `"${key.slice(0, 32)}"`;
  const cached = join(req.cacheDir, key.slice(0, 2), `${key}.jpg`);
  const hit = await readFile(cached).catch(() => null);
  if (hit) {
    const now = new Date();
    void utimes(cached, now, now).catch(() => undefined);
    return { bytes: hit, mimeType: 'image/jpeg', etag };
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = withSlot(async () => {
    const made = await makeThumbnail(req.absPath, info.size, width, req.platform);
    if (!made) return null;
    if (made.mimeType === 'image/jpeg' && made.cache) {
      await writeCached(cached, made.bytes).catch((err: unknown) =>
        log.debug(`[index] thumbnail cache write failed: ${String(err)}`),
      );
      void pruneSoon(req.cacheDir);
    }
    return { bytes: made.bytes, mimeType: made.mimeType, etag };
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function makeThumbnail(
  absPath: string,
  size: number,
  width: number,
  platform: NodeJS.Platform = process.platform,
): Promise<{ bytes: Buffer; mimeType: string; cache: boolean } | null> {
  const head = await readHead(absPath, Math.min(size, HEAD_BYTES));
  const meta = head ? readImageMeta(head) : null;
  if (meta && WEB_FORMATS.has(meta.format) && Math.max(meta.width, meta.height) <= width) {
    const whole = await readFile(absPath).catch(() => null);
    return whole ? { bytes: whole, mimeType: `image/${meta.format}`, cache: false } : null;
  }
  if (platform === 'darwin') {
    const viaSips = await sipsResize(absPath, width);
    if (viaSips) return { bytes: viaSips, mimeType: 'image/jpeg', cache: true };
  }
  const raster = await toDecodableRaster(absPath, new Set(['jpg', 'jpeg', 'png']), {
    platform,
  }).catch(() => null);
  if (!raster) return null;
  try {
    if ((await stat(raster.path)).size > MAX_IMAGE_BYTES) return null;
    const image = rgbaToRgb(decodeImage(await readFile(raster.path)));
    const scale = Math.min(1, width / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const small = scale < 1 ? resizeBilinear(image, w, h) : image;
    return { bytes: encodeJpeg(small, JPEG_QUALITY), mimeType: 'image/jpeg', cache: true };
  } catch (err) {
    log.debug(
      `[index] thumbnail decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    await raster.release();
  }
}

/** Long edge of a photo stored with an album: sharp on a television, small on disk. */
export const ALBUM_PHOTO_MAX_EDGE = 2048;
const ALBUM_JPEG_QUALITY = 86;

/**
 * A copy of a photo to store with an album or slideshow: at most `maxEdge` on
 * the long side, turned upright, and re-encoded as a JPEG with no metadata,
 * so an exported video or a shared album never carries where it was taken.
 * `sips` reads HEIC and RAW on macOS but keeps the EXIF, rotation flag and
 * GPS included, so its output is decoded and re-encoded as well. Null when
 * this machine cannot read the format.
 */
export async function makePhotoRendition(
  absPath: string,
  maxEdge = ALBUM_PHOTO_MAX_EDGE,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer | null> {
  const info = await stat(absPath).catch(() => null);
  if (!info?.isFile()) return null;
  const head = await readHead(absPath, Math.min(info.size, HEAD_BYTES));
  const meta = head ? readImageMeta(head) : null;
  const small = meta && Math.max(meta.width, meta.height) <= maxEdge;
  let source: Buffer | null = null;
  if (platform === 'darwin' && !(small && (meta.format === 'jpeg' || meta.format === 'png'))) {
    source = await sipsResize(absPath, maxEdge, 92);
  }
  if (!source) {
    const raster = await toDecodableRaster(absPath, new Set(['jpg', 'jpeg', 'png']), {
      platform,
    }).catch(() => null);
    if (!raster) return null;
    try {
      if ((await stat(raster.path)).size > MAX_IMAGE_BYTES) return null;
      source = await readFile(raster.path);
    } finally {
      await raster.release();
    }
  }
  try {
    const image = rgbaToRgb(decodeImage(source));
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    return encodeJpeg(scale < 1 ? resizeBicubic(image, w, h) : image, ALBUM_JPEG_QUALITY);
  } catch (err) {
    log.debug(`[index] photo copy failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** RGB pixels to a baseline JPEG; no EXIF, so no rotation flag or location. */
function encodeJpeg(image: RgbImage, quality: number): Buffer {
  const { width: w, height: h } = image;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    rgba[i * 4] = image.data[j]!;
    rgba[i * 4 + 1] = image.data[j + 1]!;
    rgba[i * 4 + 2] = image.data[j + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: rgba, width: w, height: h }, quality).data);
}

/** `sips` resamples on the long edge and upscales, so callers pass only photos larger than `edge`. */
async function sipsResize(
  absPath: string,
  edge: number,
  quality = JPEG_QUALITY,
): Promise<Buffer | null> {
  const scratch = join(tmpdir(), 'gezel-raster');
  const out = join(scratch, `thumb-${randomUUID()}.jpg`);
  try {
    await mkdir(scratch, { recursive: true });
    await execFileAsync(
      'sips',
      [
        '-Z',
        String(edge),
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        String(quality),
        absPath,
        '--out',
        out,
      ],
      { timeout: SIPS_TIMEOUT_MS },
    );
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(out, { force: true });
  }
}

async function writeCached(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

async function readHead(path: string, length: number): Promise<Buffer | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function pruneSoon(cacheDir: string): Promise<void> {
  if (Date.now() - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = Date.now();
  await pruneThumbnailCache(cacheDir, THUMB_CACHE_MAX_BYTES).catch((err: unknown) =>
    log.debug(`[index] thumbnail prune failed: ${String(err)}`),
  );
}

/** Delete the least recently served thumbnails until the cache fits `maxBytes`. */
export async function pruneThumbnailCache(cacheDir: string, maxBytes: number): Promise<number> {
  const files: Array<{ path: string; size: number; at: number }> = [];
  for (const shard of await readdir(cacheDir).catch(() => [])) {
    const dir = join(cacheDir, shard);
    for (const name of await readdir(dir).catch(() => [])) {
      const path = join(dir, name);
      const s = await stat(path).catch(() => null);
      if (s?.isFile()) files.push({ path, size: s.size, at: s.mtimeMs });
    }
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= maxBytes) return 0;
  files.sort((a, b) => a.at - b.at);
  let removed = 0;
  const target = maxBytes * 0.9;
  for (const f of files) {
    if (total <= target) break;
    await rm(f.path, { force: true });
    total -= f.size;
    removed++;
  }
  return removed;
}
