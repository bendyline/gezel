import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@bendyline/gezel';
import { RAW_EXTS, rawPreviewJpeg, readHeifHeader } from './image-meta.js';

const log = createLogger('index');
const execFileAsync = promisify(execFile);

/** HEIC and HEIF: decoded with the system's own tools, macOS only for now. */
export const HEIF_EXTS = new Set(['heic', 'heif']);

/** RAW files run to 100 MB on high-resolution cameras; past this, skip. */
const MAX_RAW_BYTES = 200 * 1024 * 1024;
/** Long edge of a converted HEIC: enough to describe and embed, small enough to stay quick. */
const HEIF_MAX_EDGE = 2048;
const SIPS_TIMEOUT_MS = 60_000;
/** Where a HEIC's `meta` box (and so its size) lives. */
const HEIF_HEAD_BYTES = 256 * 1024;

export interface DecodableRaster {
  /** A PNG or JPEG path every pixel consumer can read: the original, or a temporary copy. */
  path: string;
  mimeType: string;
  /** Delete the temporary copy, if one was made. */
  release(): Promise<void>;
}

function ext(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Whether a photo of this format can become a decodable raster here: RAW
 * anywhere (its embedded JPEG preview), HEIC only on macOS (`sips`).
 */
export function canNormalizeRaster(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const e = ext(path);
  return RAW_EXTS.has(e) || (HEIF_EXTS.has(e) && platform === 'darwin');
}

/**
 * A raster the pure-JS decoders and the vision model can read, for a photo
 * that may be HEIC or camera RAW. Decodes on the fly into a temporary file and
 * never keeps a full-size copy: the caller releases it once read.
 *
 * - `accepts` (extensions, no dot) pass through untouched.
 * - RAW: the largest embedded JPEG preview (what the camera shows on its own
 *   screen), found by walking the file's IFDs.
 * - HEIC on macOS: `sips` to a JPEG capped at {@link HEIF_MAX_EDGE}. Elsewhere
 *   there is no decoder yet, and the answer is null.
 */
export async function toDecodableRaster(
  absPath: string,
  accepts: ReadonlySet<string>,
  opts: { platform?: NodeJS.Platform; scratchDir?: string } = {},
): Promise<DecodableRaster | null> {
  const e = ext(absPath);
  if (accepts.has(e)) {
    return { path: absPath, mimeType: e === 'png' ? 'image/png' : 'image/jpeg', release: noop };
  }
  const scratch = opts.scratchDir ?? join(tmpdir(), 'gezel-raster');
  if (RAW_EXTS.has(e)) {
    const size = await stat(absPath)
      .then((s) => s.size)
      .catch(() => 0);
    if (size === 0 || size > MAX_RAW_BYTES) return null;
    const preview = rawPreviewJpeg(await readFile(absPath));
    if (!preview) return null;
    return writeScratch(scratch, preview);
  }
  if (HEIF_EXTS.has(e) && (opts.platform ?? process.platform) === 'darwin') {
    await mkdir(scratch, { recursive: true });
    const out = join(scratch, `${randomUUID()}.jpg`);
    // sips scales up as readily as down: shrink only a photo past the cap.
    const header = readHeifHeader(
      await readHead(absPath, HEIF_HEAD_BYTES).catch(() => Buffer.alloc(0)),
    );
    const longEdge = Math.max(header?.width ?? 0, header?.height ?? 0);
    const resample =
      longEdge > HEIF_MAX_EDGE ? ['--resampleHeightWidthMax', String(HEIF_MAX_EDGE)] : [];
    try {
      await execFileAsync('sips', ['-s', 'format', 'jpeg', ...resample, absPath, '--out', out], {
        timeout: SIPS_TIMEOUT_MS,
      });
      return { path: out, mimeType: 'image/jpeg', release: () => rm(out, { force: true }) };
    } catch (err) {
      log.warn(`[index] could not convert ${absPath} for reading: ${String(err)}`);
      await rm(out, { force: true }).catch(() => {});
      return null;
    }
  }
  return null;
}

async function writeScratch(dir: string, jpeg: Buffer): Promise<DecodableRaster> {
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${randomUUID()}.jpg`);
  await writeFile(out, jpeg);
  return { path: out, mimeType: 'image/jpeg', release: () => rm(out, { force: true }) };
}

function noop(): Promise<void> {
  return Promise.resolve();
}

async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
