/**
 * Shared primitives for the model download helpers — the event/result
 * contract, retry/backoff math, partial-file sizing, friendly error mapping,
 * and the honest gezel User-Agent. Both the classic streaming downloader
 * (`download-with-retry.ts`) and the Xet reconstruction downloader
 * (`xet-download.ts`) build on these, so neither has to import the other at
 * runtime (avoids a cycle).
 */

import { statSync } from 'node:fs';
import {
  DEFAULT_BACKOFF_SCHEDULE_MS,
  GEZEL_VERSION,
  backoffDelayMs,
  createLogger,
  sleepWithAbort,
} from '@bendyline/gezel';

export const downloadLog = createLogger('download');

/**
 * Honest User-Agent sent on every model-download request. We identify
 * ourselves as gezel rather than impersonating a browser or the huggingface
 * client — HF's Xet backend serves anonymous public reads, and being
 * transparent about who we are is the right posture for a third-party client
 * fetching public weights on the user's behalf.
 */
export const GEZEL_DOWNLOAD_UA = `gezel/${GEZEL_VERSION} (+https://github.com/bendyline/gezel)`;

/** Upper bound on *consecutive* failed attempts that made no headway. 5 covers
 * the dominant on-device failure modes (transient ISP blip, mid-day
 * congestion, brief HF rate-limit) without giving up too readily. An attempt
 * that moved real bytes refunds this budget — see `DownloadRetryBudget`. */
export const DEFAULT_MAX_RETRIES = 5;

/** Absolute ceiling on attempts for one file, however much progress is being
 * made. A 30 GB download over a link that drops every 200 MB legitimately
 * needs a lot of resumes; this only exists so a pathological
 * fails-after-one-chunk loop can't spin forever. */
export const MAX_TOTAL_ATTEMPTS = 100;

/** Forward progress that counts as "this transfer is alive" and refunds the
 * consecutive-failure budget. Deliberately larger than one HTTP chunk so a
 * server that hands us 64 KiB and hangs up can't refill the budget forever. */
export const PROGRESS_REFUND_BYTES = 4 * 1024 * 1024;

/** Backoff schedule (ms). Index = attempt number (0-based). Jitter is added on
 * top so two parallel downloads don't retry in lockstep. */
const BACKOFF_SCHEDULE_MS = DEFAULT_BACKOFF_SCHEDULE_MS;

/** No-bytes-arrived window before we declare a transfer dead. */
export const DEFAULT_CHUNK_TIMEOUT_MS = 20_000;

export type DownloadEvent =
  | {
      type: 'progress';
      bytesWritten: number;
      totalBytes: number;
    }
  | {
      type: 'retrying';
      /** Which attempt is starting (1-based). */
      attempt: number;
      maxAttempts: number;
      /** Wait before next attempt. */
      delayMs: number;
      /** Friendly description of why the previous attempt failed. */
      reason: string;
      /** Bytes already on disk that the next attempt will resume from. */
      resumeFromBytes: number;
    };

export type DownloadResult =
  | {
      kind: 'ok';
      bytesWritten: number;
      partialPath: string;
      /**
       * sha256 of the file, computed inline while streaming, IFF the whole
       * file was written from offset 0 in a single attempt (HTTP 200, no
       * resume). Absent on resumed/appended transfers and the Xet path,
       * where the inline hasher never saw the earlier bytes — the caller
       * must fall back to reading the file back to verify in those cases.
       */
      sha256?: string;
    }
  | { kind: 'aborted'; bytesWritten: number; partialPath: string }
  | {
      kind: 'error';
      /** User-facing message. Already friendly — don't add prefixes in the UI. */
      error: string;
      /** Attempts taken before giving up. */
      attemptsMade: number;
      /** Whatever bytes are on the `.partial` file at give-up time. */
      bytesWritten: number;
    };

export function existingPartialSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function retryDelayMs(retryIndex: number): number {
  return backoffDelayMs(retryIndex, BACKOFF_SCHEDULE_MS);
}

export async function sleepRespectingAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return sleepWithAbort(ms, signal);
}

/**
 * Attempt accounting for a resumable download.
 *
 * The naive "5 attempts per file, then give up" budget is what made the
 * first-run model install fail with a bare "network error": a 12 GB GGUF over
 * a link that drops every couple of minutes burns all five attempts inside the
 * first ten minutes and quits — even though every one of those attempts moved
 * hundreds of megabytes onto disk and the transfer was, in the only sense the
 * user cares about, working.
 *
 * So the budget counts *consecutive failures that made no headway*. An attempt
 * that pushed the byte high-water mark forward by at least
 * `PROGRESS_REFUND_BYTES` resets the counter (and the backoff schedule with
 * it, since the network clearly isn't down). `MAX_TOTAL_ATTEMPTS` is the
 * backstop for a server that hands us a little data and dies every single
 * time.
 *
 * A budget constructed with `maxConsecutive <= 1` never refunds, so callers
 * that pass `maxRetries: 1` still get exactly one attempt.
 */
export class DownloadRetryBudget {
  private consecutiveFailures = 0;
  private attemptsStarted = 0;
  private highWaterBytes: number;

  constructor(
    private readonly maxConsecutive: number,
    startBytes = 0,
    private readonly maxTotal: number = MAX_TOTAL_ATTEMPTS,
  ) {
    this.highWaterBytes = startBytes;
  }

  /** True while another attempt is permitted. */
  canAttempt(): boolean {
    return this.consecutiveFailures < this.maxConsecutive && this.attemptsStarted < this.maxTotal;
  }

  /** Call once at the top of each attempt. */
  beginAttempt(): number {
    return ++this.attemptsStarted;
  }

  /** Total attempts started so far — reported in the terminal error. */
  get attemptsMade(): number {
    return this.attemptsStarted;
  }

  /** Record a transient failure at `bytesWritten` bytes of on-disk progress. */
  recordFailure(bytesWritten: number): void {
    const refundable =
      this.maxConsecutive > 1 && bytesWritten >= this.highWaterBytes + PROGRESS_REFUND_BYTES;
    if (bytesWritten > this.highWaterBytes) this.highWaterBytes = bytesWritten;
    this.consecutiveFailures = refundable ? 0 : this.consecutiveFailures + 1;
  }

  /** Wait to serve before the next attempt, based on the consecutive streak. */
  nextDelayMs(): number {
    return retryDelayMs(Math.max(0, this.consecutiveFailures - 1));
  }

  /** 1-based number of the attempt about to start, for `retrying` events. */
  get nextAttemptLabel(): number {
    return this.consecutiveFailures + 1;
  }

  get maxAttempts(): number {
    return this.maxConsecutive;
  }
}

/**
 * Map raw fetch/network errors to a single user-readable sentence.
 * Keep these short — the UI shows them inline in a small banner.
 */
export function friendlyFetchError(err: unknown): string {
  const raw = rawErrorString(err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return "Couldn't reach the model host — your internet may be offline";
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return 'Model host refused the connection';
  }
  if (/ETIMEDOUT|ETIMEOUT|UND_ERR_CONNECT_TIMEOUT/i.test(raw)) {
    return 'Connection timed out';
  }
  if (/ECONNRESET|UND_ERR_SOCKET|socket hang up/i.test(raw)) {
    return 'Connection was dropped';
  }
  if (/CERT|certificate|self.?signed/i.test(raw)) {
    return 'TLS certificate error reaching the model host';
  }
  return 'Network error reaching the model host';
}

export function friendlyStreamError(err: unknown): string {
  const raw = rawErrorString(err);
  if (/ECONNRESET|premature close|aborted/i.test(raw)) {
    return 'Connection dropped mid-download';
  }
  if (/ENOSPC/i.test(raw)) {
    return 'Out of disk space while downloading';
  }
  if (/ETIMEDOUT|UND_ERR_/i.test(raw)) {
    return 'Connection timed out mid-download';
  }
  return 'Download stream failed';
}

export function friendlyStatusError(status: number, statusText: string, _url: string): string {
  if (status === 404) return 'Model file not found on the host (404)';
  if (status === 401 || status === 403) {
    return `Access denied by the model host (${status}) — gated repo or expired token?`;
  }
  if (status === 429) return 'Model host is rate-limiting us (429) — will retry';
  if (status === 408) return 'Model host timed out (408)';
  if (status >= 500) return `Model host returned a server error (${status})`;
  return `Download failed with HTTP ${status} ${statusText || ''}`.trim();
}

export function rawErrorString(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeStr = cause instanceof Error ? ` (cause: ${cause.message})` : '';
    return `${err.name}: ${err.message}${causeStr}`;
  }
  return String(err);
}

/** Friendly-error helpers so providers that build their own non-fetch error
 * events can produce consistent copy. */
export const friendlyErrors = {
  fetch: friendlyFetchError,
  stream: friendlyStreamError,
  status: friendlyStatusError,
};
