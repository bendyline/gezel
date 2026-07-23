/**
 * Shared primitives for the model download helpers — the event/result
 * contract, retry/backoff math, partial-file sizing, friendly error mapping,
 * and the honest gezel User-Agent. Both the classic streaming downloader
 * (`download-with-retry.ts`) and the Xet reconstruction downloader
 * (`xet-download.ts`) build on these, so neither has to import the other at
 * runtime (avoids a cycle).
 */

import { statSync } from 'node:fs';
import { GEZEL_VERSION, createLogger } from '@bendyline/gezel';

export const downloadLog = createLogger('download');

/**
 * Honest User-Agent sent on every model-download request. We identify
 * ourselves as gezel rather than impersonating a browser or the huggingface
 * client — HF's Xet backend serves anonymous public reads, and being
 * transparent about who we are is the right posture for a third-party client
 * fetching public weights on the user's behalf.
 */
export const GEZEL_DOWNLOAD_UA = `gezel/${GEZEL_VERSION} (+https://github.com/bendyline/gezel)`;

/** Default upper bound on retry attempts (per file). 5 covers the dominant
 * on-device failure modes (transient ISP blip, mid-day congestion, brief HF
 * rate-limit) without giving up too readily. */
export const DEFAULT_MAX_RETRIES = 5;

/** Backoff schedule (ms). Index = attempt number (0-based). Jitter is added on
 * top so two parallel downloads don't retry in lockstep. */
const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000, 6_000, 8_000];

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
  | { kind: 'ok'; bytesWritten: number; partialPath: string }
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
  const base = BACKOFF_SCHEDULE_MS[Math.min(retryIndex, BACKOFF_SCHEDULE_MS.length - 1)] ?? 8_000;
  // ±20% jitter so concurrent transfers don't retry in lockstep.
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.round(base + jitter);
}

export async function sleepRespectingAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted) return true;
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
