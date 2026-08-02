/**
 * Shared resumable-download helper used by every model installer.
 *
 * Before this existed, llama-cpp / mlx / sd-cpp each had their own
 * fetch-and-stream-to-file loop with subtly different behavior:
 *   - none of them implemented HTTP Range resumption, so a 9 GB-of-10 GB
 *     network failure burned the whole transfer.
 *   - error messages bubbled out as raw Node errno strings like
 *     `getaddrinfo ENOTFOUND` or "fetch failed", which the UI then
 *     rendered verbatim. The user sees "network error" and has no
 *     useful action.
 *   - no retry. One transient ECONNRESET = full restart.
 *
 * Shared helper:
 *   - Resumable via `Range: bytes=N-` when the previous partial file
 *     is present. HuggingFace CDN honors this; falls back gracefully
 *     when the server replies with `200` instead of `206` (mid-file
 *     restart).
 *   - Auto-retry with exponential backoff + jitter. The budget counts
 *     *consecutive failures that made no headway* (default 5) rather than
 *     attempts-per-file, so a big transfer over a flaky link keeps resuming
 *     as long as it is actually advancing. Yields `retrying` events so the UI
 *     can surface "Retrying in 4s (attempt 3/5)…" instead of a stuck banner.
 *   - Per-chunk idle-timeout — a stalled connection that returns no
 *     bytes for `chunkTimeoutMs` aborts and is retried.
 *   - Friendly error mapping for the common cases (DNS, refused,
 *     reset, timeout). Raw errors logged at debug; the surfaced
 *     message is user-readable.
 *   - Honors `AbortSignal`. On abort: no retry, no `.partial` cleanup
 *     (leave the file so a resumed run can pick up).
 *
 * The helper does NOT do sha256 verification, manifest writes, or
 * post-download rename. Those stay in the per-provider installer
 * because they have provider-specific shapes (multi-file MLX, GGUF
 * metadata extraction for llama-cpp). The helper is purely
 * "stream this URL to this path, resume if you can, retry if it
 * fails, yield progress so the caller can stream events".
 */

import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  type DownloadEvent,
  type DownloadResult,
  DownloadRetryBudget,
  GEZEL_DOWNLOAD_UA,
  existingPartialSize,
  friendlyErrors,
  friendlyFetchError,
  friendlyStatusError,
  friendlyStreamError,
  downloadLog as log,
  rawErrorString,
  sleepRespectingAbort,
} from './download-common.js';
import { type XetDetection, downloadXet } from './xet-download.js';
import { parseLinkHeader } from './xet.js';

// Public re-exports: external consumers import the event/result contract and
// friendly-error helpers from here (the primary download entry point).
export { type DownloadEvent, type DownloadResult, friendlyErrors } from './download-common.js';

export interface DownloadOptions {
  url: string;
  /** Final on-disk path. The helper writes to `${destPath}.partial`
   * and leaves the rename to the caller (so caller can verify sha256
   * before publishing). */
  destPath: string;
  /** Approximate size from the catalog manifest — used as the
   * progress denominator when the server doesn't return
   * Content-Length (e.g. some HF mirrors). */
  approxSizeBytes: number;
  fetchImpl?: typeof fetch;
  /** Give up after this many CONSECUTIVE failed attempts that made no
   * forward progress. 1 = no retry. Progressing attempts refund the budget,
   * bounded by `MAX_TOTAL_ATTEMPTS`. */
  maxRetries?: number;
  /** Per-chunk idle timeout. */
  chunkTimeoutMs?: number;
  /** Caller cancellation. On abort: no retry, no `.partial` cleanup. */
  signal?: AbortSignal;
}

/**
 * Drive the download. Yields `progress` + `retrying` events; the
 * async-generator's RETURN value carries the terminal outcome.
 *
 * Typical caller pattern:
 *
 *   ```ts
 *   const gen = downloadWithRetry({ url, destPath, approxSizeBytes });
 *   while (true) {
 *     const next = await gen.next();
 *     if (next.done) {
 *       if (next.value.kind === 'ok') ... finalize, rename, sha256 check, etc.
 *       if (next.value.kind === 'aborted') ... bail, leave .partial for resume
 *       if (next.value.kind === 'error') ... yield to caller's SSE
 *       break;
 *     }
 *     // forward progress / retrying event up the chain
 *     yieldUpstream(next.value);
 *   }
 *   ```
 */
export async function* downloadWithRetry(
  opts: DownloadOptions,
): AsyncGenerator<DownloadEvent, DownloadResult, void> {
  const partialPath = `${opts.destPath}.partial`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxAttempts = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const chunkTimeoutMs = opts.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;

  const budget = new DownloadRetryBudget(maxAttempts, existingPartialSize(partialPath));
  let lastFriendlyError = 'download failed';
  while (budget.canAttempt()) {
    budget.beginAttempt();
    if (opts.signal?.aborted) {
      return {
        kind: 'aborted',
        bytesWritten: existingPartialSize(partialPath),
        partialPath,
      };
    }

    const resumeFrom = existingPartialSize(partialPath);
    const attemptResult = yield* runSingleAttempt({
      url: opts.url,
      partialPath,
      approxSizeBytes: opts.approxSizeBytes,
      fetchImpl,
      chunkTimeoutMs,
      resumeFrom,
      signal: opts.signal,
    });

    if (attemptResult.kind === 'xet') {
      // HuggingFace serves this file via Xet content-addressed storage; the
      // reconstruction downloader speaks that protocol and drives its own
      // retry/resume from here.
      return yield* downloadXet({
        detection: attemptResult.detection,
        destPath: opts.destPath,
        approxSizeBytes: opts.approxSizeBytes,
        fetchImpl,
        maxRetries: opts.maxRetries,
        chunkTimeoutMs: opts.chunkTimeoutMs,
        signal: opts.signal,
      });
    }
    if (attemptResult.kind === 'ok') {
      return {
        kind: 'ok',
        bytesWritten: attemptResult.bytesWritten,
        partialPath,
      };
    }
    if (attemptResult.kind === 'aborted') {
      return {
        kind: 'aborted',
        bytesWritten: attemptResult.bytesWritten,
        partialPath,
      };
    }
    if (attemptResult.kind === 'fatal') {
      // Non-retryable: 4xx, sha mismatch, malformed Content-Length, etc.
      return {
        kind: 'error',
        error: attemptResult.friendlyError,
        attemptsMade: budget.attemptsMade,
        bytesWritten: attemptResult.bytesWritten,
      };
    }
    // Transient — schedule a retry (or give up if we're out of attempts).
    lastFriendlyError = attemptResult.friendlyError;
    budget.recordFailure(attemptResult.bytesWritten);
    log.warn(
      `[download] attempt ${budget.attemptsMade} failed at ${attemptResult.bytesWritten} bytes: ${attemptResult.friendlyError} (rawError=${attemptResult.rawError})`,
    );
    if (!budget.canAttempt()) break;
    const delay = budget.nextDelayMs();
    yield {
      type: 'retrying',
      attempt: budget.nextAttemptLabel,
      maxAttempts: budget.maxAttempts,
      delayMs: delay,
      reason: attemptResult.friendlyError,
      resumeFromBytes: attemptResult.bytesWritten,
    };
    const aborted = await sleepRespectingAbort(delay, opts.signal);
    if (aborted) {
      return {
        kind: 'aborted',
        bytesWritten: existingPartialSize(partialPath),
        partialPath,
      };
    }
  }

  const attemptsMade = budget.attemptsMade;
  return {
    kind: 'error',
    error: `${lastFriendlyError} (gave up after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'})`,
    attemptsMade,
    bytesWritten: existingPartialSize(partialPath),
  };
}

// ── Inner attempt loop ─────────────────────────────────────────────

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

type AttemptResult =
  | { kind: 'ok'; bytesWritten: number }
  | { kind: 'aborted'; bytesWritten: number }
  | { kind: 'fatal'; friendlyError: string; bytesWritten: number }
  | { kind: 'transient'; friendlyError: string; rawError: string; bytesWritten: number }
  // The resolve URL is Xet-backed — the classic stream can't read it. Bubble
  // the detection up so `downloadWithRetry` hands off to the reconstruction
  // downloader (which owns its own retry/resume loop).
  | { kind: 'xet'; detection: XetDetection };

async function* runSingleAttempt(opts: {
  url: string;
  partialPath: string;
  approxSizeBytes: number;
  fetchImpl: typeof fetch;
  chunkTimeoutMs: number;
  resumeFrom: number;
  signal: AbortSignal | undefined;
}): AsyncGenerator<DownloadEvent, AttemptResult, void> {
  const { url, partialPath, approxSizeBytes, fetchImpl, chunkTimeoutMs, resumeFrom, signal } = opts;

  // Build per-attempt AbortController so a stalled chunk can cancel the
  // fetch without losing the caller's signal.
  const ac = new AbortController();
  const abortFromCaller = (): void => ac.abort();
  signal?.addEventListener('abort', abortFromCaller);

  const headers: Record<string, string> = { 'User-Agent': GEZEL_DOWNLOAD_UA };
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

  // Fetch with manual redirect so we can inspect the 302 before following it.
  // HuggingFace `/resolve/` URLs 302 to either a classic CDN blob (follow it)
  // or, for Xet-backed files, a CAS bridge with an `X-Xet-Hash` header that a
  // plain GET can't read (it 403s) — in that case we bubble a `xet` sentinel
  // so the caller delegates to the reconstruction downloader. Non-redirect
  // (2xx / small git-blob) responses are streamed directly.
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, redirect: 'manual', signal: ac.signal });
    let hops = 0;
    while (isRedirect(res.status) && hops++ < 5) {
      const xetHash = res.headers.get('x-xet-hash');
      if (xetHash) {
        const authUrl = parseLinkHeader(res.headers.get('link'))['xet-auth'];
        try {
          await res.body?.cancel();
        } catch {
          /* redirect body may already be closed */
        }
        if (authUrl) {
          signal?.removeEventListener('abort', abortFromCaller);
          return { kind: 'xet', detection: { xetHash, authUrl } };
        }
        // Xet without an auth link — fall through and try to follow anyway.
      }
      const location = res.headers.get('location');
      if (!location) break; // not a followable redirect; let status mapping handle it
      try {
        await res.body?.cancel();
      } catch {
        /* */
      }
      res = await fetchImpl(new URL(location, url).toString(), {
        headers,
        redirect: 'manual',
        signal: ac.signal,
      });
    }
  } catch (err) {
    signal?.removeEventListener('abort', abortFromCaller);
    if (signal?.aborted) {
      return { kind: 'aborted', bytesWritten: resumeFrom };
    }
    return {
      kind: 'transient',
      friendlyError: friendlyFetchError(err),
      rawError: rawErrorString(err),
      bytesWritten: resumeFrom,
    };
  }

  // Status mapping:
  //   206 Partial Content → server honored Range; append to .partial.
  //   200 OK → server ignored Range (or no Range sent). Start over.
  //   416 Range Not Satisfiable → file already complete on server side
  //     OR our resumeFrom is past EOF. Treat as "we have everything";
  //     caller's sha256 check decides if the on-disk file is valid.
  //   4xx (other) → fatal; bad URL / auth / missing file. No retry.
  //   5xx → transient; retry.
  if (res.status === 416 && resumeFrom > 0) {
    // Server says we already have everything. Let the caller validate.
    signal?.removeEventListener('abort', abortFromCaller);
    return { kind: 'ok', bytesWritten: resumeFrom };
  }
  if (res.status === 200 && resumeFrom > 0) {
    // Server ignored Range — start fresh.
    await rm(partialPath, { force: true });
  }
  if (!res.ok || !res.body) {
    signal?.removeEventListener('abort', abortFromCaller);
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      return {
        kind: 'fatal',
        friendlyError: friendlyStatusError(res.status, res.statusText, url),
        bytesWritten: resumeFrom,
      };
    }
    return {
      kind: 'transient',
      friendlyError: friendlyStatusError(res.status, res.statusText, url),
      rawError: `HTTP ${res.status}`,
      bytesWritten: resumeFrom,
    };
  }

  // Establish the total-bytes denominator for progress reporting.
  // When resuming, Content-Length is the REMAINING bytes; Content-Range
  // (`bytes 100-499/500`) carries the full total. Prefer Content-Range
  // when present.
  const contentRange = res.headers.get('content-range');
  const contentLength = res.headers.get('content-length');
  let bytesWritten = res.status === 200 ? 0 : resumeFrom;
  let totalBytes = approxSizeBytes;
  if (contentRange) {
    const m = contentRange.match(/\/(\d+)$/);
    if (m?.[1]) totalBytes = Number.parseInt(m[1], 10);
  } else if (contentLength && res.status === 200) {
    totalBytes = Number.parseInt(contentLength, 10);
  } else if (contentLength && res.status === 206) {
    totalBytes = resumeFrom + Number.parseInt(contentLength, 10);
  }

  // Append-mode stream so a resumed download just keeps writing.
  const fileStream = createWriteStream(partialPath, {
    flags: res.status === 200 ? 'w' : 'a',
  });

  // Capture stream errors instead of letting them surface as uncaught
  // exceptions in the (Electron) main process. The common case is benign:
  // when we `destroy()` the stream on a stalled chunk, a caller cancel, or
  // a read error, any in-flight `fs` write completes against the destroyed
  // stream and emits ERR_STREAM_DESTROYED. The flag also lets the write
  // loop notice a *real* I/O failure (e.g. disk full) and bail into the
  // retry path instead of silently reporting success.
  let streamError: Error | null = null;
  fileStream.on('error', (err) => {
    streamError ??= err;
  });

  // Destroy the stream and wait for it to fully close. The permanent
  // 'error' handler above swallows the ERR_STREAM_DESTROYED that destroy()
  // triggers on a pending write. Idempotent.
  const closeStream = async (): Promise<void> => {
    if (!fileStream.destroyed) fileStream.destroy();
    if (fileStream.closed) return;
    await new Promise<void>((resolve) => fileStream.once('close', () => resolve()));
  };

  // Wait for the stream to drain (backpressure) before pulling more bytes,
  // so a fast CDN can't outrun a slower disk and balloon memory on a
  // multi-GB GGUF. Resolves immediately if the stream already errored or
  // was destroyed, so we never hang waiting for a 'drain' that won't come.
  const awaitDrain = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (streamError || fileStream.destroyed) return resolve();
      const cleanup = (): void => {
        fileStream.off('drain', onDone);
        fileStream.off('error', onDone);
      };
      const onDone = (): void => {
        cleanup();
        resolve();
      };
      fileStream.once('drain', onDone);
      fileStream.once('error', onDone);
    });

  const reader = res.body.getReader();
  let lastReportedAt = Date.now();

  try {
    while (true) {
      // Chunk timeout: race the reader.read() against a timer. If the
      // timer fires first, we treat it as a stall and bail with a
      // transient error so the outer loop can retry.
      const readPromise = reader.read();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), chunkTimeoutMs);
      });
      const raced = await Promise.race([readPromise, timeoutPromise]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if ('timedOut' in raced) {
        try {
          ac.abort();
        } catch {
          /* */
        }
        await closeStream();
        signal?.removeEventListener('abort', abortFromCaller);
        return {
          kind: 'transient',
          friendlyError: `connection stalled — no data for ${Math.round(chunkTimeoutMs / 1000)}s`,
          rawError: 'chunk-timeout',
          bytesWritten,
        };
      }
      const { value, done } = raced;
      if (done) break;
      if (value) {
        // A real write error (disk full, etc.) recorded by the 'error'
        // handler — surface it so the catch below turns it into a retry.
        if (streamError) throw streamError;
        bytesWritten += value.byteLength;
        if (!fileStream.write(value)) await awaitDrain();
        if (streamError) throw streamError;
        const now = Date.now();
        if (now - lastReportedAt > 250) {
          lastReportedAt = now;
          yield { type: 'progress', bytesWritten, totalBytes };
        }
      }
    }
  } catch (err) {
    await closeStream();
    signal?.removeEventListener('abort', abortFromCaller);
    if (signal?.aborted) {
      return { kind: 'aborted', bytesWritten };
    }
    return {
      kind: 'transient',
      friendlyError: friendlyStreamError(err),
      rawError: rawErrorString(err),
      bytesWritten,
    };
  }

  signal?.removeEventListener('abort', abortFromCaller);

  // Flush + close. A failure here (or any error the 'error' handler caught
  // along the way, e.g. the open ENOENT'd or the disk filled) becomes a
  // transient retry rather than a thrown generator / uncaught exception.
  try {
    await new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    if (streamError) throw streamError;
  } catch (err) {
    await closeStream();
    return {
      kind: 'transient',
      friendlyError: friendlyStreamError(err),
      rawError: rawErrorString(err),
      bytesWritten,
    };
  }

  // Emit one final progress event so the UI shows 100% before the
  // caller's verification phase begins. Many CDNs deliver the final
  // chunk on the close signal, after our 250ms throttle has fired
  // for the second-to-last chunk.
  yield { type: 'progress', bytesWritten, totalBytes };
  return { kind: 'ok', bytesWritten };
}
