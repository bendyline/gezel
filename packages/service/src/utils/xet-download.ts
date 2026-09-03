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
import { backoffDelayMs } from '@bendyline/gezel';
import {
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  type DownloadEvent,
  type DownloadResult,
  DownloadRetryBudget,
  GEZEL_DOWNLOAD_UA,
  downloadLog,
  existingPartialSize,
  friendlyFetchError,
  friendlyStatusError,
  friendlyStreamError,
  rawErrorString,
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
  /**
   * Hard cap on the reconstructed file. Enforced against an oversized
   * `.partial` before any network call, against the manifest's exact total
   * before streaming, and per term while streaming — the same three gates as
   * the classic downloader, so a bounded caller can take the Xet path.
   */
  maxBytes?: number;
}

export async function* downloadXet(
  opts: XetDownloadOptions,
): AsyncGenerator<DownloadEvent, DownloadResult, void> {
  const partialPath = `${opts.destPath}.partial`;
  const maxAttempts = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (opts.maxBytes !== undefined && existingPartialSize(partialPath) > opts.maxBytes) {
    return {
      kind: 'error',
      error: byteLimitError(opts.maxBytes),
      attemptsMade: 0,
      bytesWritten: existingPartialSize(partialPath),
    };
  }
  const budget = new DownloadRetryBudget(maxAttempts, existingPartialSize(partialPath));
  let lastFriendly = 'Xet download failed';

  while (budget.canAttempt()) {
    budget.beginAttempt();
    if (opts.signal?.aborted) return aborted(partialPath);

    const resumeFrom = existingPartialSize(partialPath);
    const result = yield* runXetAttempt(opts, partialPath, resumeFrom);

    if (result.kind === 'ok') return { kind: 'ok', bytesWritten: result.bytesWritten, partialPath };
    if (result.kind === 'aborted') return aborted(partialPath);
    if (result.kind === 'fatal') {
      return {
        kind: 'error',
        error: result.friendlyError,
        attemptsMade: budget.attemptsMade,
        bytesWritten: result.bytesWritten,
      };
    }

    lastFriendly = result.friendlyError;
    budget.recordFailure(result.bytesWritten);
    downloadLog.warn(
      `[xet] attempt ${budget.attemptsMade} failed at ${result.bytesWritten} bytes: ${result.friendlyError} (rawError=${result.rawError})`,
    );
    if (!budget.canAttempt()) break;
    const delay = budget.nextDelayMs();
    yield {
      type: 'retrying',
      attempt: budget.nextAttemptLabel,
      maxAttempts: budget.maxAttempts,
      delayMs: delay,
      reason: result.friendlyError,
      resumeFromBytes: result.bytesWritten,
    };
    if (await sleepRespectingAbort(delay, opts.signal)) return aborted(partialPath);
  }

  const attemptsMade = budget.attemptsMade;
  return {
    kind: 'error',
    error: `${lastFriendly} (gave up after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'})`,
    attemptsMade,
    bytesWritten: existingPartialSize(partialPath),
  };
}

function byteLimitError(maxBytes: number): string {
  return `Download exceeds the ${maxBytes} byte limit`;
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
  if (opts.maxBytes !== undefined && totalBytes > opts.maxBytes) {
    return {
      kind: 'fatal',
      friendlyError: byteLimitError(opts.maxBytes),
      bytesWritten: resumeFrom,
    };
  }

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
      // A manifest that lies about its total cannot over-deliver past the cap.
      if (opts.maxBytes !== undefined && termEnd > opts.maxBytes) {
        await closeStream(stream);
        return {
          kind: 'fatal',
          friendlyError: byteLimitError(opts.maxBytes),
          bytesWritten: Math.max(written, resumeFrom),
        };
      }

      let data = await termData(term, recon, segCache, fetchImpl, chunkTimeoutMs, signal);
      if (leadingTrim > 0) data = data.subarray(leadingTrim);
      const toWrite = termStart < resumeFrom ? data.subarray(resumeFrom - termStart) : data;
      if (
        opts.maxBytes !== undefined &&
        Math.max(written, resumeFrom) + toWrite.byteLength > opts.maxBytes
      ) {
        await closeStream(stream);
        return {
          kind: 'fatal',
          friendlyError: byteLimitError(opts.maxBytes),
          bytesWritten: Math.max(written, resumeFrom),
        };
      }
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
      return { kind: 'aborted', bytesWritten: Math.max(written, resumeFrom) };
    }
    // The `.partial` genuinely holds `resumeFrom` bytes even when the failure
    // landed inside the term that straddles the resume boundary, so report the
    // larger of the two — the retry budget reads this as forward progress.
    const onDisk = Math.max(written, resumeFrom);
    if (err instanceof XetError) {
      return err.transient
        ? {
            kind: 'transient',
            friendlyError: err.friendly,
            rawError: err.raw,
            bytesWritten: onDisk,
          }
        : { kind: 'fatal', friendlyError: err.friendly, bytesWritten: onDisk };
    }
    return {
      kind: 'transient',
      friendlyError: friendlyStreamError(err),
      rawError: rawErrorString(err),
      bytesWritten: onDisk,
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

/** In-place retries for one xorb segment before the failure escalates. */
const SEGMENT_ATTEMPTS = 3;

/** Tighter than the whole-file schedule: a segment is small and independently
 * re-fetchable, so the useful move is to try again quickly rather than to sit
 * out a multi-second backoff hundreds of times over one file. */
const SEGMENT_BACKOFF_MS: readonly number[] = [400, 1_200, 2_500];

/**
 * Fetch one xorb byte range, retrying transient failures in place.
 *
 * This is the difference between "one dropped packet costs a few seconds" and
 * "one dropped packet costs a whole file attempt". A multi-GB Xet file is
 * reconstructed from hundreds of these segment fetches; before the inner
 * retry, a single blip unwound all the way to the outer loop, which re-minted
 * the CAS token, re-fetched the reconstruction manifest, and re-walked the
 * terms — and, worse, spent one of only five whole-file attempts. On a link
 * that drops even occasionally, the outer budget was guaranteed to run out
 * before the file finished. Segments are small and individually re-fetchable,
 * so retrying at this granularity is nearly free.
 */
async function fetchXorbSegment(
  seg: XetReconstruction['fetch_info'][string][number],
  fetchImpl: typeof fetch,
  chunkTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  let lastError: XetError | undefined;
  for (let attempt = 1; attempt <= SEGMENT_ATTEMPTS; attempt++) {
    try {
      return await fetchXorbSegmentOnce(seg, fetchImpl, chunkTimeoutMs, signal);
    } catch (err) {
      if (!(err instanceof XetError) || !err.transient || err.wasAborted || signal?.aborted) {
        throw err;
      }
      lastError = err;
      if (attempt >= SEGMENT_ATTEMPTS) break;
      const delay = backoffDelayMs(attempt - 1, SEGMENT_BACKOFF_MS);
      downloadLog.debug(
        `[xet] segment fetch attempt ${attempt}/${SEGMENT_ATTEMPTS} failed (${err.raw}); retrying in ${delay}ms`,
      );
      if (await sleepRespectingAbort(delay, signal)) {
        throw new XetError(err.friendly, true, err.raw, true);
      }
    }
  }
  throw lastError ?? new XetError('xorb fetch failed', true, 'segment-exhausted');
}

/** One attempt at a xorb byte range, with a per-read stall timeout. */
async function fetchXorbSegmentOnce(
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
