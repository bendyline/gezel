import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';

/**
 * Model weights are data, not code, so the app may download them at runtime —
 * but only bytes whose exact length and SHA-256 were pinned at build time ever
 * reach their final name. The shape follows `scripts/stage-gezel-native.cjs`
 * (stream-hash with a size cap into `.partial`, then rename) with what a
 * user-facing download also needs: HTTP Range resume, an idle timeout, and
 * cancellation.
 */

export type DownloadFailure = 'http' | 'size' | 'checksum' | 'timeout' | 'aborted' | 'network';

export class VerifiedDownloadError extends Error {
  constructor(
    readonly failure: DownloadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'VerifiedDownloadError';
  }
}

export interface VerifiedDownloadOptions {
  readonly url: string;
  readonly destination: string;
  readonly sha256: string;
  /** Exact expected length; anything longer is refused mid-stream. */
  readonly size: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** Abort when no bytes arrive for this long. */
  readonly idleTimeoutMs?: number;
  readonly onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
// Refuse to follow a symlink planted at a path we are about to write or trust.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

async function existingSize(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/** Feed the bytes already on disk into `hash`, so a resumed file is hashed whole. */
async function hashPrefix(file: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
  try {
    for await (const chunk of createReadStream('', { fd: handle.fd, autoClose: false })) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
}

/** Parse `Content-Range: bytes <start>-<end>/<total>`; null when it is unusable. */
function rangeStart(header: string | null): number | null {
  const match = header ? /^bytes (\d+)-\d+\/(?:\d+|\*)$/u.exec(header.trim()) : null;
  return match ? Number(match[1]) : null;
}

/**
 * Download `url` to `destination`, verifying length and SHA-256 before the
 * final rename. A previous `.partial` of the same download is resumed when the
 * server honours the range; otherwise it starts over.
 */
export async function verifiedDownload(options: VerifiedDownloadOptions): Promise<void> {
  const {
    url,
    destination,
    sha256,
    size,
    signal,
    fetchImpl = fetch,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    onProgress,
  } = options;
  const partial = `${destination}.partial`;
  if (signal?.aborted) throw new VerifiedDownloadError('aborted', 'Download cancelled.');

  let offset = await existingSize(partial);
  if (offset === size && (await verifyFile(partial, sha256, size))) {
    // A complete partial from an interrupted verify: no need to fetch again.
    await rename(partial, destination);
    onProgress?.(size, size);
    return;
  }
  if (offset >= size) {
    await rm(partial, { force: true });
    offset = 0;
  }

  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const hash = createHash('sha256');
  try {
    armIdle();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
      });
    } catch (error) {
      throw failureFor(error, signal, timedOut);
    }

    // Append only when the server resumed exactly where the partial ends;
    // a plain 200 means it ignored the range, so start over.
    const append =
      offset > 0 &&
      response.status === 206 &&
      rangeStart(response.headers.get('content-range')) === offset;
    if (response.status !== 200 && !append) {
      throw new VerifiedDownloadError('http', `The download server answered ${response.status}.`);
    }
    if (!append) offset = 0;
    if (append && offset > 0) await hashPrefix(partial, hash);

    let received = offset;
    onProgress?.(received, size);
    const handle = await open(
      partial,
      constants.O_WRONLY |
        constants.O_CREAT |
        (append ? constants.O_APPEND : constants.O_TRUNC) |
        NO_FOLLOW,
      0o644,
    );
    try {
      if (response.body) {
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            armIdle();
            received += chunk.byteLength;
            if (received > size) {
              // Not the pinned file; a resume from this prefix could never verify.
              await handle.close().catch(() => undefined);
              await rm(partial, { force: true });
              throw new VerifiedDownloadError('size', 'The download is larger than expected.');
            }
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
              if (bytesWritten === 0) throw new Error('Speech model write made no progress.');
              offset += bytesWritten;
            }
            onProgress?.(received, size);
          }
        } catch (error) {
          if (error instanceof VerifiedDownloadError) throw error;
          throw failureFor(error, signal, timedOut);
        }
      }
    } finally {
      await handle.close();
    }

    if (received !== size) {
      // Keep the partial: the next attempt resumes from it.
      throw new VerifiedDownloadError('network', 'The download ended early.');
    }
    if (hash.digest('hex') !== sha256.toLowerCase()) {
      await rm(partial, { force: true });
      throw new VerifiedDownloadError('checksum', 'The downloaded file failed verification.');
    }
    await rename(partial, destination);
  } finally {
    if (idle) clearTimeout(idle);
    signal?.removeEventListener('abort', onAbort);
  }
}

function failureFor(
  error: unknown,
  signal: AbortSignal | undefined,
  timedOut: boolean,
): VerifiedDownloadError {
  if (timedOut) return new VerifiedDownloadError('timeout', 'The download stalled.');
  if (signal?.aborted) return new VerifiedDownloadError('aborted', 'Download cancelled.');
  const detail = error instanceof Error ? error.message : String(error);
  return new VerifiedDownloadError('network', `The download failed: ${detail}`);
}

/**
 * Stream-hash a file without following symlinks. Resolves false on any
 * mismatch or read failure, so callers can treat "unverifiable" as "absent".
 */
export async function verifyFile(file: string, sha256: string, size: number): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size !== size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream('', { fd: handle.fd, autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex') === sha256.toLowerCase();
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
