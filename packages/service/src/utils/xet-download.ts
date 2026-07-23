/**
 * Xet reconstruction downloader — the fetch/stream/retry/resume half of the
 * Xet support. See `xet.ts` for the protocol overview and the pure decoders.
 *
 * The classic downloader (`download-with-retry.ts`) detects a Xet-backed file
 * from the resolve 302's `X-Xet-Hash` header and hands the `{ xetHash, authUrl }`
 * detection here. `downloadXet` drives the reconstruction: mint a CAS token,
 * fetch the reconstruction manifest, then fetch each term's xorb byte range,
 * decode + decompress the chunks, and stream them to `${destPath}.partial` in
 * term order — with the same event/result contract, resume-from-partial,
 * backoff retry, stall timeout, and abort handling as the classic downloader.
 * The caller still sha256-verifies the finished file, so a corrupt resume is
 * caught and the `.partial` is cleaned by the caller.
 */

import { type WriteStream, createWriteStream } from 'node:fs';
import {
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  type DownloadEvent,
  type DownloadResult,
  GEZEL_DOWNLOAD_UA,
  downloadLog,
  existingPartialSize,
  friendlyFetchError,
  friendlyStatusError,
  friendlyStreamError,
  rawErrorString,
  retryDelayMs,
  sleepRespectingAbort,
} from './download-common.js';
import { type XetReconstruction, decodeSegmentChunks } from './xet.js';

export interface XetDetection {
  xetHash: string;
  /** The rel="xet-auth" token-mint endpoint from the resolve 302's link header. */
  authUrl: string;
}

interface CasToken {
  casUrl: string;
  accessToken: string;
  exp?: number;
}

export interface XetDownloadOptions {
  detection: XetDetection;
  /** Final on-disk path; the helper writes `${destPath}.partial`. */
  destPath: string;
  approxSizeBytes: number;
  fetchImpl: typeof fetch;
  maxRetries?: number;
  chunkTimeoutMs?: number;
  signal?: AbortSignal;
}

export async function* downloadXet(
  opts: XetDownloadOptions,
): AsyncGenerator<DownloadEvent, DownloadResult, void> {
  const partialPath = `${opts.destPath}.partial`;
  const maxAttempts = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  let attempt = 0;
  let lastFriendly = 'Xet download failed';

  while (attempt < maxAttempts) {
    attempt++;
    if (opts.signal?.aborted) return aborted(partialPath);

    const resumeFrom = existingPartialSize(partialPath);
    const result = yield* runXetAttempt(opts, partialPath, resumeFrom);

    if (result.kind === 'ok') return { kind: 'ok', bytesWritten: result.bytesWritten, partialPath };
    if (result.kind === 'aborted') return aborted(partialPath);
    if (result.kind === 'fatal') {
      return {
        kind: 'error',
        error: result.friendlyError,
        attemptsMade: attempt,
        bytesWritten: result.bytesWritten,
      };
    }

    lastFriendly = result.friendlyError;
    downloadLog.warn(
      `[xet] attempt ${attempt}/${maxAttempts} failed: ${result.friendlyError} (rawError=${result.rawError})`,
    );
    if (attempt >= maxAttempts) break;
    const delay = retryDelayMs(attempt - 1);
    yield {
      type: 'retrying',
      attempt: attempt + 1,
      maxAttempts,
      delayMs: delay,
      reason: result.friendlyError,
      resumeFromBytes: result.bytesWritten,
    };
    if (await sleepRespectingAbort(delay, opts.signal)) return aborted(partialPath);
  }

  return {
    kind: 'error',
    error: `${lastFriendly} (gave up after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'})`,
    attemptsMade: attempt,
    bytesWritten: existingPartialSize(partialPath),
  };
}

function aborted(partialPath: string): DownloadResult {
  return { kind: 'aborted', bytesWritten: existingPartialSize(partialPath), partialPath };
}

// ── inner attempt ──────────────────────────────────────────────────

type AttemptResult =
  | { kind: 'ok'; bytesWritten: number }
  | { kind: 'aborted'; bytesWritten: number }
  | { kind: 'fatal'; friendlyError: string; bytesWritten: number }
  | { kind: 'transient'; friendlyError: string; rawError: string; bytesWritten: number };

/** A Xet fetch failure carrying its retryability + friendly copy. */
class XetError extends Error {
  constructor(
    readonly friendly: string,
    readonly transient: boolean,
    readonly raw: string,
    readonly wasAborted = false,
  ) {
    super(friendly);
  }
}

async function* runXetAttempt(
  opts: XetDownloadOptions,
  partialPath: string,
  resumeFrom: number,
): AsyncGenerator<DownloadEvent, AttemptResult, void> {
  const { detection, fetchImpl, signal } = opts;
  const chunkTimeoutMs = opts.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;

  // 1. Mint a CAS token (anonymous for public repos). A 4xx here (other than
  //    rate-limit / timeout) means a gated repo — fatal, no point retrying.
  let token: CasToken;
  try {
    const tr = await fetchImpl(detection.authUrl, {
      headers: { 'User-Agent': GEZEL_DOWNLOAD_UA },
      signal,
    });
    if (!tr.ok) {
      const fatal = tr.status >= 400 && tr.status < 500 && tr.status !== 429 && tr.status !== 408;
      return {
        kind: fatal ? 'fatal' : 'transient',
        friendlyError: friendlyStatusError(tr.status, tr.statusText, detection.authUrl),
        rawError: `xet-auth HTTP ${tr.status}`,
        bytesWritten: resumeFrom,
      };
    }
    token = (await tr.json()) as CasToken;
  } catch (err) {
    if (signal?.aborted) return { kind: 'aborted', bytesWritten: resumeFrom };
    return {
      kind: 'transient',
      friendlyError: friendlyFetchError(err),
      rawError: rawErrorString(err),
      bytesWritten: resumeFrom,
    };
  }

  // 2. Fetch the reconstruction manifest.
  let recon: XetReconstruction;
  try {
    const rr = await fetchImpl(`${token.casUrl}/v1/reconstructions/${detection.xetHash}`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, 'User-Agent': GEZEL_DOWNLOAD_UA },
      signal,
    });
    if (!rr.ok) {
      // 403 with a just-minted token → treat as transient (re-mint next pass).
      const transient =
        rr.status >= 500 || rr.status === 429 || rr.status === 408 || rr.status === 403;
      return {
        kind: transient ? 'transient' : 'fatal',
        friendlyError: friendlyStatusError(rr.status, rr.statusText, 'reconstruction'),
        rawError: `reconstruction HTTP ${rr.status}`,
        bytesWritten: resumeFrom,
      };
    }
    recon = (await rr.json()) as XetReconstruction;
  } catch (err) {
    if (signal?.aborted) return { kind: 'aborted', bytesWritten: resumeFrom };
    return {
      kind: 'transient',
      friendlyError: friendlyFetchError(err),
      rawError: rawErrorString(err),
      bytesWritten: resumeFrom,
    };
  }

  // Exact total from the manifest (drives an accurate progress bar).
  const totalBytes =
    recon.terms.reduce((n, t) => n + t.unpacked_length, 0) - (recon.offset_into_first_range ?? 0);

  // 3. Stream terms to `.partial`, resuming past bytes already on disk.
  const stream = createWriteStream(partialPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
  let streamError: Error | null = null;
  stream.on('error', (e) => {
    streamError ??= e;
  });

  const segCache = new Map<string, { end: number; chunks: Buffer[] }>();
  let written = 0; // logical output-file offset processed so far
  let lastReport = Date.now();

  try {
    for (let termIndex = 0; termIndex < recon.terms.length; termIndex++) {
      const term = recon.terms[termIndex];
      if (!term) continue;
      if (signal?.aborted) {
        await closeStream(stream);
        return { kind: 'aborted', bytesWritten: Math.max(written, resumeFrom) };
      }

      // `offset_into_first_range` trims bytes from the first reconstruction
      // term before it becomes file output. Because the manifest already
      // carries every term's unpacked length, we can locate the resume
      // boundary without downloading or decoding the preceding xorbs.
      const leadingTrim = termIndex === 0 ? (recon.offset_into_first_range ?? 0) : 0;
      const termLength = Math.max(0, term.unpacked_length - leadingTrim);
      const termStart = written;
      const termEnd = termStart + termLength;

      // The partial file already contains this entire term. The previous
      // implementation still fetched + decoded it and merely discarded the
      // bytes, making a 16 GB resume silently re-download 16 GB while the
      // progress bar appeared frozen at the saved offset.
      if (termEnd <= resumeFrom) {
        written = termEnd;
        continue;
      }

      let data = await termData(term, recon, segCache, fetchImpl, chunkTimeoutMs, signal);
      if (leadingTrim > 0) data = data.subarray(leadingTrim);
      const toWrite = termStart < resumeFrom ? data.subarray(resumeFrom - termStart) : data;
      await writeChunk(stream, toWrite);
      if (streamError) throw streamError;
      written = termEnd;

      // Evict fully-consumed segments of this xorb (terms are ordered).
      for (const [key, entry] of segCache) {
        if (key.startsWith(`${term.hash}:`) && entry.end <= term.range.end) segCache.delete(key);
      }
      if (segCache.size > 16) segCache.clear();

      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        yield { type: 'progress', bytesWritten: Math.max(written, resumeFrom), totalBytes };
      }
    }
  } catch (err) {
    await closeStream(stream);
    if (signal?.aborted || (err instanceof XetError && err.wasAborted)) {
      return { kind: 'aborted', bytesWritten: written };
    }
    if (err instanceof XetError) {
      return err.transient
        ? {
            kind: 'transient',
            friendlyError: err.friendly,
            rawError: err.raw,
            bytesWritten: written,
          }
        : { kind: 'fatal', friendlyError: err.friendly, bytesWritten: written };
    }
    return {
      kind: 'transient',
      friendlyError: friendlyStreamError(err),
      rawError: rawErrorString(err),
      bytesWritten: written,
    };
  }

  try {
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    if (streamError) throw streamError;
  } catch (err) {
    await closeStream(stream);
    return {
      kind: 'transient',
      friendlyError: friendlyStreamError(err),
      rawError: rawErrorString(err),
      bytesWritten: written,
    };
  }

  yield { type: 'progress', bytesWritten: Math.max(written, resumeFrom), totalBytes };
  return { kind: 'ok', bytesWritten: written };
}

/** Decode one term's chunk range into a contiguous buffer. */
async function termData(
  term: XetReconstruction['terms'][number],
  recon: XetReconstruction,
  segCache: Map<string, { end: number; chunks: Buffer[] }>,
  fetchImpl: typeof fetch,
  chunkTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const segs = recon.fetch_info[term.hash];
  if (!segs)
    throw new XetError(
      `reconstruction missing xorb ${term.hash.slice(0, 12)}`,
      false,
      'missing-xorb',
    );
  const parts: Buffer[] = [];
  for (let idx = term.range.start; idx < term.range.end; idx++) {
    const seg = segs.find((s) => s.range.start <= idx && idx < s.range.end);
    if (!seg) throw new XetError(`no segment covers chunk ${idx}`, false, 'missing-segment');
    const key = `${term.hash}:${seg.range.start}`;
    let entry = segCache.get(key);
    if (!entry) {
      const buf = await fetchXorbSegment(seg, fetchImpl, chunkTimeoutMs, signal);
      entry = {
        end: seg.range.end,
        chunks: decodeSegmentChunks(buf, seg.range.end - seg.range.start),
      };
      segCache.set(key, entry);
    }
    parts.push(entry.chunks[idx - seg.range.start]!);
  }
  return Buffer.concat(parts);
}

/** Fetch one xorb byte range, with a per-read stall timeout. */
async function fetchXorbSegment(
  seg: XetReconstruction['fetch_info'][string][number],
  fetchImpl: typeof fetch,
  chunkTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const ac = new AbortController();
  const forward = (): void => ac.abort();
  signal?.addEventListener('abort', forward);
  try {
    let res: Response;
    try {
      res = await fetchImpl(seg.url, {
        headers: {
          Range: `bytes=${seg.url_range.start}-${seg.url_range.end}`,
          'User-Agent': GEZEL_DOWNLOAD_UA,
        },
        signal: ac.signal,
      });
    } catch (err) {
      throw new XetError(
        friendlyFetchError(err),
        true,
        rawErrorString(err),
        Boolean(signal?.aborted),
      );
    }
    if (res.status !== 200 && res.status !== 206) {
      // 403 mid-download ≈ expired CAS token → transient (re-mint next attempt).
      const transient =
        res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 403;
      throw new XetError(
        friendlyStatusError(res.status, res.statusText, seg.url),
        transient,
        `xorb HTTP ${res.status}`,
      );
    }
    if (!res.body) throw new XetError('xorb response had no body', true, 'no-body');

    const reader = res.body.getReader();
    const parts: Buffer[] = [];
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const raced = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), chunkTimeoutMs);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (raced === 'timeout') {
        ac.abort();
        throw new XetError(
          `connection stalled — no data for ${Math.round(chunkTimeoutMs / 1000)}s`,
          true,
          'chunk-timeout',
        );
      }
      if (raced.done) break;
      if (raced.value) parts.push(Buffer.from(raced.value));
    }
    return Buffer.concat(parts);
  } finally {
    signal?.removeEventListener('abort', forward);
  }
}

function writeChunk(stream: WriteStream, buf: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

async function closeStream(stream: WriteStream): Promise<void> {
  if (!stream.destroyed) stream.destroy();
  if (stream.closed) return;
  await new Promise<void>((resolve) => stream.once('close', () => resolve()));
}
