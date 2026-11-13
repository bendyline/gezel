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
 *
 * Nothing received is thrown away on a bad connection. Bytes reach the file
 * only in term order, so at any moment several xorb segments (up to 64 MiB
 * each) are part-way through arriving in memory. A segment whose connection
 * drops asks for the rest of its byte range rather than starting again, and
 * the segments a failed attempt was holding are handed to the next attempt
 * (`XetTransfer`). Before this, a saturated link that cut every stream a few
 * megabytes in could not finish a single segment: each cut cost a whole-file
 * attempt, discarded about 290 MB in flight, moved the progress bar back, and
 * the fifth cut ended the download (2026-11-12).
 */

import { setMaxListeners } from 'node:events';
import { type WriteStream, createWriteStream } from 'node:fs';
import { backoffDelayMs } from '@bendyline/gezel';
import {
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  type DownloadEvent,
  type DownloadResult,
  DownloadRetryBudget,
  GEZEL_DOWNLOAD_UA,
  PROGRESS_REFUND_BYTES,
  downloadLog,
  existingPartialSize,
  friendlyFetchError,
  friendlyStatusError,
  friendlyStreamError,
  huggingFaceRequestHeaders,
  rawErrorString,
  sleepRespectingAbort,
} from './download-common.js';
import {
  type XetFetchSegment,
  type XetReconstruction,
  type XetTerm,
  decodeSegmentChunks,
} from './xet.js';

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
  /** Most reconstruction terms fetched ahead of the writer. Fewer after trouble. */
  termConcurrency?: number;
  /** Most compressed bytes the terms fetched ahead of the writer may hold. */
  windowBytes?: number;
}

const DEFAULT_XET_TERM_CONCURRENCY = 8;

/**
 * A xorb segment is up to 64 MiB and is buffered whole before it decodes, so
 * what is fetched ahead is bounded in bytes as well as in terms. The default
 * is room for eight of the largest segments and so changes nothing by itself:
 * a link that limits each connection needs all eight streams (halving them
 * halved the speed of a real download, 2026-11-12). It is here so a larger
 * `termConcurrency`, or a host that makes segments larger, cannot grow what is
 * held without limit.
 */
const DEFAULT_XET_WINDOW_BYTES = 512 * 1024 * 1024;

/** Finished segments kept for a later term before the store is trimmed. */
const MAX_IDLE_SEGMENTS = 16;

type PrefetchedTerm = { ok: true; chunks: readonly Buffer[] } | { ok: false; error: unknown };

/** How often progress is reported while the writer waits on the next term. */
const PROGRESS_TICK_MS = 500;
const TICK = Symbol('tick');

/**
 * Compressed bytes received across every in-flight segment, against the total
 * the manifest says this attempt will fetch. Bytes reach the file only in term
 * order, and the eight prefetched terms share the link, so the first term lands
 * after about eight terms' worth of transfer: a 2 GB model read 0% for minutes
 * and then jumped (2026-10-08). Received bytes move the bar while that happens.
 */
class ReceiveMeter {
  constructor(
    private readonly total: number,
    private received = 0,
  ) {}

  /** Negative when a segment has to start again. */
  add(bytes: number): void {
    this.received = Math.max(0, this.received + bytes);
  }

  fraction(): number {
    return this.total > 0 ? Math.min(1, this.received / this.total) : 0;
  }
}

/** One xorb byte range, and how much of it this download holds. */
interface SegmentState {
  readonly hash: string;
  /** Exclusive end of the chunk range the segment covers. */
  readonly chunkEnd: number;
  /** Compressed length of the byte range. */
  readonly size: number;
  /** The range's bytes so far, in order. */
  parts: Buffer[];
  received: number;
  /** The decoded chunks, once the whole range has arrived. `parts` is released then. */
  decoded?: Buffer[];
  /** This attempt's fetch, shared by every term that reads the segment. */
  pending?: Promise<Buffer[]>;
}

function segmentSize(seg: XetFetchSegment): number {
  return seg.url_range.end - seg.url_range.start + 1;
}

/**
 * The byte range is part of the key: a new manifest that cuts a xorb
 * differently must not be given bytes fetched for the old cut.
 */
function segmentKey(hash: string, seg: XetFetchSegment): string {
  return `${hash}:${seg.range.start}-${seg.range.end}:${seg.url_range.start}-${seg.url_range.end}`;
}

/** The segments a download has started, kept from one attempt to the next. */
class SegmentStore {
  private readonly states = new Map<string, SegmentState>();

  state(hash: string, seg: XetFetchSegment): SegmentState {
    const key = segmentKey(hash, seg);
    let state = this.states.get(key);
    if (!state) {
      state = { hash, chunkEnd: seg.range.end, size: segmentSize(seg), parts: [], received: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  received(key: string): number {
    return this.states.get(key)?.received ?? 0;
  }

  /** Compressed bytes held in memory that have not reached the file. */
  heldBytes(): number {
    let total = 0;
    for (const state of this.states.values()) total += state.received;
    return total;
  }

  /** Forget the last attempt's fetches, and segments the new manifest does not name. */
  beginAttempt(remaining: ReadonlyMap<string, number>): void {
    for (const [key, state] of this.states) {
      if (remaining.has(key)) state.pending = undefined;
      else this.states.delete(key);
    }
  }

  /** Terms are ordered, so nothing later reads a segment that ends by `chunkEnd`. */
  release(hash: string, chunkEnd: number): void {
    for (const [key, state] of this.states) {
      if (state.hash === hash && state.chunkEnd <= chunkEnd) this.states.delete(key);
    }
  }

  /** Drop finished segments no fetched-ahead term is waiting on. One needed again is fetched again. */
  trim(limit: number, inUse: (key: string) => boolean): void {
    if (this.states.size <= limit) return;
    for (const [key, state] of this.states) {
      if (state.decoded && !inUse(key)) this.states.delete(key);
    }
  }
}

/** Shrinks at most this often, so one outage cutting every stream counts once. */
const WINDOW_SHRINK_INTERVAL_MS = 1_000;

/**
 * How many terms are fetched ahead of the writer. Streams that share a
 * struggling link starve each other until none finishes, so trouble halves the
 * count and clean writes win it back one at a time.
 */
class PrefetchWindow {
  private limit: number;
  private clean = 0;
  private lastShrink = Number.NEGATIVE_INFINITY;

  constructor(private readonly max: number) {
    this.limit = max;
  }

  get size(): number {
    return this.limit;
  }

  shrink(): void {
    const now = Date.now();
    if (now - this.lastShrink < WINDOW_SHRINK_INTERVAL_MS) return;
    this.lastShrink = now;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.clean = 0;
  }

  termWritten(): void {
    if (this.limit >= this.max) return;
    this.clean++;
    if (this.clean < this.limit) return;
    this.limit++;
    this.clean = 0;
  }
}

/** Compressed bytes of the segments the fetched-ahead terms read, each counted once. */
class WindowLoad {
  private readonly users = new Map<string, number>();
  bytes = 0;

  has(key: string): boolean {
    return this.users.has(key);
  }

  /** What adding a term that reads `segments` would add. */
  cost(segments: ReadonlyMap<string, number>): number {
    let total = 0;
    for (const [key, size] of segments) if (!this.users.has(key)) total += size;
    return total;
  }

  add(segments: ReadonlyMap<string, number>): void {
    for (const [key, size] of segments) {
      const count = this.users.get(key) ?? 0;
      if (count === 0) this.bytes += size;
      this.users.set(key, count + 1);
    }
  }

  remove(segments: ReadonlyMap<string, number> | undefined): void {
    for (const [key, size] of segments ?? []) {
      const count = this.users.get(key) ?? 0;
      if (count <= 1) {
        if (count === 1) this.bytes -= size;
        this.users.delete(key);
      } else {
        this.users.set(key, count - 1);
      }
    }
  }
}

/** What one download keeps from attempt to attempt. */
interface XetTransfer {
  readonly segments: SegmentStore;
  readonly window: PrefetchWindow;
  /** Highest progress reported, so a new attempt never moves the bar back. */
  reported: number;
}

/** Where a term's bytes land in the output file, after the leading trim. */
interface TermSpan {
  /** Bytes dropped from the front of the term: `offset_into_first_range`, first term only. */
  leadingTrim: number;
  start: number;
  end: number;
}

interface TermLayout {
  spans: (TermSpan | undefined)[];
  /** Exact size of the reconstructed file (drives an accurate progress bar). */
  totalBytes: number;
}

function layoutTerms(recon: XetReconstruction): TermLayout {
  const spans: (TermSpan | undefined)[] = [];
  let totalBytes = 0;
  for (let index = 0; index < recon.terms.length; index++) {
    const term = recon.terms[index];
    if (!term) continue;
    const leadingTrim = index === 0 ? (recon.offset_into_first_range ?? 0) : 0;
    const start = totalBytes;
    totalBytes += Math.max(0, term.unpacked_length - leadingTrim);
    spans[index] = { leadingTrim, start, end: totalBytes };
  }
  return { spans, totalBytes };
}

/** The segments a term reads, keyed as the store keys them, with their compressed sizes. */
function termSegments(term: XetTerm, recon: XetReconstruction): Map<string, number> {
  const segments = new Map<string, number>();
  for (const seg of recon.fetch_info[term.hash] ?? []) {
    if (seg.range.end <= term.range.start || seg.range.start >= term.range.end) continue;
    segments.set(segmentKey(term.hash, seg), segmentSize(seg));
  }
  return segments;
}

/** Every segment the terms still to be written will read. */
function remainingSegments(
  recon: XetReconstruction,
  spans: readonly (TermSpan | undefined)[],
  resumeFrom: number,
): Map<string, number> {
  const remaining = new Map<string, number>();
  recon.terms.forEach((term, index) => {
    const span = spans[index];
    if (!term || !span || span.end <= resumeFrom) return;
    for (const [key, size] of termSegments(term, recon)) remaining.set(key, size);
  });
  return remaining;
}

/** The settled value, or {@link TICK} if `ms` passes first. */
async function settledOrTick<T>(promise: Promise<T>, ms: number): Promise<T | typeof TICK> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = new Promise<typeof TICK>((resolve) => {
    timer = setTimeout(() => resolve(TICK), ms);
  });
  try {
    return await Promise.race([promise, tick]);
  } finally {
    clearTimeout(timer);
  }
}

export async function* downloadXet(
  opts: XetDownloadOptions,
): AsyncGenerator<DownloadEvent, DownloadResult, void> {
  const partialPath = `${opts.destPath}.partial`;
  const maxAttempts = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const startBytes = existingPartialSize(partialPath);
  if (opts.maxBytes !== undefined && startBytes > opts.maxBytes) {
    return {
      kind: 'error',
      error: byteLimitError(opts.maxBytes),
      attemptsMade: 0,
      bytesWritten: startBytes,
    };
  }
  const budget = new DownloadRetryBudget(maxAttempts, startBytes);
  const transfer: XetTransfer = {
    segments: new SegmentStore(),
    window: new PrefetchWindow(
      Math.max(1, Math.floor(opts.termConcurrency ?? DEFAULT_XET_TERM_CONCURRENCY)),
    ),
    reported: startBytes,
  };
  let lastFriendly = 'Xet download failed';

  while (budget.canAttempt()) {
    budget.beginAttempt();
    if (opts.signal?.aborted) return aborted(partialPath);

    const resumeFrom = existingPartialSize(partialPath);
    const headwayBefore = resumeFrom + transfer.segments.heldBytes();
    const result = yield* runXetAttempt(opts, partialPath, resumeFrom, transfer);

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
    // Bytes held for the next attempt are headway as much as bytes on disk:
    // a slow link can spend a whole attempt on segments it has not finished.
    const headway = result.bytesWritten + transfer.segments.heldBytes();
    budget.recordFailure(headway);
    if (result.linksExpired && headway >= headwayBefore + PROGRESS_REFUND_BYTES) {
      // Segment links last an hour and a large file on a slow link outlives
      // them. Nothing is wrong, so there is no wait and nothing to tell anyone.
      // Links that lapse before any data moves are a failure like any other.
      downloadLog.info(
        `[xet] download links expired at ${result.bytesWritten} bytes; fetching new ones`,
      );
      continue;
    }
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
  | {
      kind: 'transient';
      friendlyError: string;
      rawError: string;
      bytesWritten: number;
      /** The segment links stopped being accepted; a new manifest carries new ones. */
      linksExpired?: boolean;
    };

/** A Xet fetch failure carrying its retryability + friendly copy. */
class XetError extends Error {
  constructor(
    readonly friendly: string,
    readonly transient: boolean,
    readonly raw: string,
    readonly wasAborted = false,
    readonly linksExpired = false,
  ) {
    super(friendly);
  }
}

async function* runXetAttempt(
  opts: XetDownloadOptions,
  partialPath: string,
  resumeFrom: number,
  transfer: XetTransfer,
): AsyncGenerator<DownloadEvent, AttemptResult, void> {
  const { detection, fetchImpl, signal } = opts;

  // 1. Mint a CAS token (anonymous for public repos). A 4xx here (other than
  //    rate-limit / timeout) means a gated repo — fatal, no point retrying.
  let token: CasToken;
  try {
    const tr = await fetchImpl(detection.authUrl, {
      headers: huggingFaceRequestHeaders(detection.authUrl),
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

  const layout = layoutTerms(recon);
  if (opts.maxBytes !== undefined && layout.totalBytes > opts.maxBytes) {
    return {
      kind: 'fatal',
      friendlyError: byteLimitError(opts.maxBytes),
      bytesWritten: resumeFrom,
    };
  }

  // 3. Stream terms to `.partial`. Every fetch the attempt starts ends with
  //    it: the next attempt resumes the same segments, and a fetch left
  //    running would still be adding bytes to them.
  const attempt = new AbortController();
  // One listener per segment in flight; a caller may ask for more than ten.
  setMaxListeners(0, attempt.signal);
  const endAttempt = (): void => attempt.abort();
  signal?.addEventListener('abort', endAttempt);
  if (signal?.aborted) attempt.abort();
  try {
    return yield* writeTerms(
      opts,
      partialPath,
      resumeFrom,
      transfer,
      recon,
      layout,
      attempt.signal,
    );
  } finally {
    signal?.removeEventListener('abort', endAttempt);
    attempt.abort();
  }
}

/** Fetch terms ahead of the writer and append them to `.partial` in order. */
async function* writeTerms(
  opts: XetDownloadOptions,
  partialPath: string,
  resumeFrom: number,
  transfer: XetTransfer,
  recon: XetReconstruction,
  layout: TermLayout,
  attemptSignal: AbortSignal,
): AsyncGenerator<DownloadEvent, AttemptResult, void> {
  const { signal } = opts;
  const { spans, totalBytes } = layout;
  const maxWindowBytes = Math.max(1, opts.windowBytes ?? DEFAULT_XET_WINDOW_BYTES);

  const stream = createWriteStream(partialPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
  let streamError: Error | null = null;
  stream.on('error', (e) => {
    streamError ??= e;
  });

  const remaining = remainingSegments(recon, spans, resumeFrom);
  transfer.segments.beginAttempt(remaining);
  let fetchBytes = 0;
  let carriedOver = 0;
  for (const [key, size] of remaining) {
    fetchBytes += size;
    carriedOver += transfer.segments.received(key);
  }
  const meter = new ReceiveMeter(fetchBytes, carriedOver);
  const io: SegmentIo = {
    store: transfer.segments,
    fetchImpl: opts.fetchImpl,
    chunkTimeoutMs: opts.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS,
    signal: attemptSignal,
    onBytes: (bytes) => meter.add(bytes),
    onTrouble: () => transfer.window.shrink(),
  };

  const progress = (bytes: number): DownloadEvent => {
    transfer.reported = Math.max(transfer.reported, Math.min(totalBytes, bytes));
    return { type: 'progress', bytesWritten: transfer.reported, totalBytes };
  };
  const estimate = () => resumeFrom + Math.floor((totalBytes - resumeFrom) * meter.fraction());

  const prefetched = new Map<number, Promise<PrefetchedTerm>>();
  const windowTerms = new Map<number, Map<string, number>>();
  const load = new WindowLoad();
  let nextToPrefetch = 0;

  const fillPrefetchWindow = (): void => {
    while (prefetched.size < transfer.window.size && nextToPrefetch < recon.terms.length) {
      const index = nextToPrefetch;
      const term = recon.terms[index];
      const span = spans[index];
      if (!term || !span || span.end <= resumeFrom) {
        nextToPrefetch++;
        continue;
      }
      const segments = termSegments(term, recon);
      // The term the writer waits on is always admitted, whatever its size.
      if (prefetched.size > 0 && load.bytes + load.cost(segments) > maxWindowBytes) break;
      nextToPrefetch++;
      load.add(segments);
      windowTerms.set(index, segments);
      prefetched.set(
        index,
        termChunks(term, recon, io).then(
          (chunks): PrefetchedTerm => ({ ok: true, chunks: dropLeading(chunks, span.leadingTrim) }),
          (error: unknown): PrefetchedTerm => ({ ok: false, error }),
        ),
      );
    }
  };

  fillPrefetchWindow();
  let written = 0; // logical output-file offset processed so far
  let lastReport = Date.now();

  try {
    for (let termIndex = 0; termIndex < recon.terms.length; termIndex++) {
      const term = recon.terms[termIndex];
      const span = spans[termIndex];
      if (!term || !span) continue;
      if (signal?.aborted) {
        await closeStream(stream);
        return { kind: 'aborted', bytesWritten: Math.max(written, resumeFrom) };
      }

      // The partial file already contains this entire term. The manifest
      // carries every term's unpacked length, so the resume boundary is found
      // without downloading or decoding the xorbs before it. An earlier
      // implementation fetched + decoded them and discarded the bytes, making
      // a 16 GB resume silently re-download 16 GB while the progress bar
      // appeared frozen at the saved offset.
      if (span.end <= resumeFrom) {
        written = span.end;
        continue;
      }
      // A manifest that lies about its total cannot over-deliver past the cap.
      if (opts.maxBytes !== undefined && span.end > opts.maxBytes) {
        await closeStream(stream);
        return {
          kind: 'fatal',
          friendlyError: byteLimitError(opts.maxBytes),
          bytesWritten: Math.max(written, resumeFrom),
        };
      }

      const pending = prefetched.get(termIndex);
      if (!pending)
        throw new XetError('reconstruction term was not prefetched', false, 'term-missing');
      let fetched = await settledOrTick(pending, PROGRESS_TICK_MS);
      while (fetched === TICK) {
        // Only when bytes arrived. A notice that the connection dropped stays
        // up until data moves again, not until the next timer tick.
        const estimated = estimate();
        if (estimated > transfer.reported) {
          lastReport = Date.now();
          yield progress(estimated);
        }
        fetched = await settledOrTick(pending, PROGRESS_TICK_MS);
      }
      prefetched.delete(termIndex);
      load.remove(windowTerms.get(termIndex));
      windowTerms.delete(termIndex);
      fillPrefetchWindow();
      if (!fetched.ok) throw fetched.error;
      const toWrite =
        span.start < resumeFrom
          ? dropLeading(fetched.chunks, resumeFrom - span.start)
          : fetched.chunks;
      if (
        opts.maxBytes !== undefined &&
        Math.max(written, resumeFrom) + byteLength(toWrite) > opts.maxBytes
      ) {
        await closeStream(stream);
        return {
          kind: 'fatal',
          friendlyError: byteLimitError(opts.maxBytes),
          bytesWritten: Math.max(written, resumeFrom),
        };
      }
      await writeChunks(stream, toWrite);
      if (streamError) throw streamError;
      written = span.end;
      transfer.window.termWritten();
      transfer.segments.release(term.hash, term.range.end);
      transfer.segments.trim(MAX_IDLE_SEGMENTS, (key) => load.has(key));

      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        yield progress(Math.max(written, estimate()));
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
            linksExpired: err.linksExpired,
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

  yield progress(totalBytes);
  return { kind: 'ok', bytesWritten: written };
}

/** `chunks` without its first `bytes` bytes. Nothing is copied. */
function dropLeading(chunks: readonly Buffer[], bytes: number): readonly Buffer[] {
  if (bytes <= 0) return chunks;
  const kept: Buffer[] = [];
  let skip = bytes;
  for (const chunk of chunks) {
    if (skip >= chunk.length) {
      skip -= chunk.length;
      continue;
    }
    kept.push(skip > 0 ? chunk.subarray(skip) : chunk);
    skip = 0;
  }
  return kept;
}

function byteLength(chunks: readonly Buffer[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

// ── segments ───────────────────────────────────────────────────────

/** What a segment fetch needs from the attempt it belongs to. */
interface SegmentIo {
  store: SegmentStore;
  fetchImpl: typeof fetch;
  chunkTimeoutMs: number;
  /** Aborted when the attempt ends, for whatever reason. */
  signal: AbortSignal;
  /** Compressed bytes received; negative when a segment has to start again. */
  onBytes(bytes: number): void;
  /** A fetch failed in a way that says the link is struggling. */
  onTrouble(): void;
}

/**
 * A term's decoded chunks, in order. They are the segment's own buffers: a
 * term used to be copied into one contiguous buffer, which held every fetched
 * term in memory twice.
 */
async function termChunks(
  term: XetTerm,
  recon: XetReconstruction,
  io: SegmentIo,
): Promise<Buffer[]> {
  const segs = recon.fetch_info[term.hash];
  if (!segs)
    throw new XetError(
      `reconstruction missing xorb ${term.hash.slice(0, 12)}`,
      false,
      'missing-xorb',
    );
  const chunks: Buffer[] = [];
  for (let idx = term.range.start; idx < term.range.end; idx++) {
    const seg = segs.find((s) => s.range.start <= idx && idx < s.range.end);
    if (!seg) throw new XetError(`no segment covers chunk ${idx}`, false, 'missing-segment');
    const decoded = await segmentChunks(term.hash, seg, io);
    chunks.push(decoded[idx - seg.range.start]!);
  }
  return chunks;
}

function segmentChunks(hash: string, seg: XetFetchSegment, io: SegmentIo): Promise<Buffer[]> {
  const state = io.store.state(hash, seg);
  if (state.decoded) return Promise.resolve(state.decoded);
  state.pending ??= fetchXorbSegment(seg, state, io).then((bytes) => {
    if (io.signal.aborted) throw abortedError();
    let decoded: Buffer[];
    try {
      decoded = decodeSegmentChunks(bytes, seg.range.end - seg.range.start);
    } catch (err) {
      // Bytes that do not decode are not a prefix worth resuming from.
      restartSegment(state, io);
      throw new XetError('Downloaded data was damaged in transit', true, rawErrorString(err));
    }
    state.decoded = decoded;
    state.parts = [];
    return decoded;
  });
  return state.pending;
}

function restartSegment(state: SegmentState, io: SegmentIo): void {
  if (state.received > 0) io.onBytes(-state.received);
  state.parts = [];
  state.received = 0;
}

function abortedError(): XetError {
  return new XetError('Download was cancelled', true, 'aborted', true);
}

/** `XetError.raw` of a connection that stopped sending. */
const STALL_ERROR = 'chunk-timeout';

/** Tries in a row that added almost nothing before the failure escalates. */
const SEGMENT_ATTEMPTS = 3;

/** What a try must add to the segment for the connection to count as alive. */
const SEGMENT_PROGRESS_BYTES = 64 * 1024;

/** Tighter than the whole-file schedule: a segment is small and independently
 * re-fetchable, so the useful move is to try again quickly rather than to sit
 * out a multi-second backoff hundreds of times over one file. */
const SEGMENT_BACKOFF_MS: readonly number[] = [400, 1_200, 2_500];

/**
 * Fetch one xorb byte range, recovering from transient failures in place.
 *
 * This is the difference between "one dropped packet costs a few seconds" and
 * "one dropped packet costs a whole file attempt". A multi-GB Xet file is
 * reconstructed from hundreds of these segment fetches, and an attempt that
 * fails re-mints the CAS token, re-fetches the reconstruction manifest and
 * re-walks the terms.
 *
 * Each try asks only for the bytes the segment still lacks, so a try that
 * moved data is progress and does not count against the segment: a link that
 * cuts every connection after a few megabytes still finishes a 64 MiB
 * segment. Only tries that add nothing escalate, after `SEGMENT_ATTEMPTS`.
 */
async function fetchXorbSegment(
  seg: XetFetchSegment,
  state: SegmentState,
  io: SegmentIo,
): Promise<Buffer> {
  let idleTries = 0;
  while (state.received < state.size) {
    const before = state.received;
    try {
      await receiveXorbSegment(seg, state, io);
    } catch (err) {
      if (
        !(err instanceof XetError) ||
        !err.transient ||
        err.wasAborted ||
        err.linksExpired ||
        io.signal.aborted
      ) {
        throw err;
      }
      const moved = state.received - before >= SEGMENT_PROGRESS_BYTES;
      idleTries = moved ? 0 : idleTries + 1;
      // A connection cut after it carried data says little about the link. One
      // that carried nothing, or went silent, says the link is struggling.
      if (!moved || err.raw === STALL_ERROR) io.onTrouble();
      if (idleTries >= SEGMENT_ATTEMPTS) throw err;
      const delay = backoffDelayMs(Math.max(0, idleTries - 1), SEGMENT_BACKOFF_MS);
      downloadLog.debug(
        `[xet] segment fetch failed at ${state.received}/${state.size} bytes (${err.raw}); retrying in ${delay}ms`,
      );
      if (await sleepRespectingAbort(delay, io.signal)) {
        throw new XetError(err.friendly, true, err.raw, true);
      }
    }
  }
  // Decoding wants one buffer. Keep that instead of the pieces, not as well as.
  if (state.parts.length !== 1) state.parts = [Buffer.concat(state.parts, state.received)];
  return state.parts[0]!;
}

/** First byte of a `Content-Range: bytes 10-20/30` header. */
function contentRangeStart(res: Response): number | undefined {
  const match = /^bytes\s+(\d+)-/i.exec(res.headers.get('content-range') ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * One request for the bytes a segment still lacks, appended as they arrive.
 * Throws on any failure, leaving what was received in `state` for the next
 * request to continue from.
 */
async function receiveXorbSegment(
  seg: XetFetchSegment,
  state: SegmentState,
  io: SegmentIo,
): Promise<void> {
  const ac = new AbortController();
  let reader: BodyReader | undefined;
  // Cancelling the reader ends a read that is waiting on a silent connection.
  // A fetch that fails its body on abort does that by itself; not every
  // `fetchImpl` does.
  const stop = (): void => {
    ac.abort();
    reader?.cancel().catch(() => undefined);
  };
  io.signal.addEventListener('abort', stop);
  if (io.signal.aborted) ac.abort();
  try {
    // The link is signed for the segment's range. The host serves any tail of
    // it, but refuses an open-ended range or none (403), so the end is always
    // the signed end.
    const from = seg.url_range.start + state.received;
    let res: Response;
    try {
      res = await io.fetchImpl(seg.url, {
        headers: {
          Range: `bytes=${from}-${seg.url_range.end}`,
          'User-Agent': GEZEL_DOWNLOAD_UA,
        },
        signal: ac.signal,
      });
    } catch (err) {
      throw new XetError(friendlyFetchError(err), true, rawErrorString(err), io.signal.aborted);
    }
    if (io.signal.aborted) throw abortedError();
    if (res.status !== 200 && res.status !== 206) {
      // 403 mid-download ≈ the link's hour is up → a new manifest has new links.
      const linksExpired = res.status === 403;
      const transient =
        linksExpired || res.status >= 500 || res.status === 429 || res.status === 408;
      throw new XetError(
        friendlyStatusError(res.status, res.statusText, seg.url),
        transient,
        `xorb HTTP ${res.status}`,
        false,
        linksExpired,
      );
    }
    if (!res.body) throw new XetError('xorb response had no body', true, 'no-body');

    // Where the body starts. A host that ignores Range answers 200 with the
    // whole xorb; one that does not say is taken to start at the segment, as
    // a first request always has been. Either way the bytes held are no
    // longer the prefix of what is arriving.
    const start = res.status === 206 ? contentRangeStart(res) : 0;
    let skip = 0;
    if (res.status === 200) {
      restartSegment(state, io);
      skip = seg.url_range.start;
    } else if (start === undefined || start === seg.url_range.start) {
      if (state.received > 0) restartSegment(state, io);
    } else if (start !== from) {
      throw new XetError('Model host sent a different part of the file', true, 'range-mismatch');
    }

    const body = res.body.getReader();
    reader = body;
    try {
      while (state.received < state.size) {
        const read = await readOrStall(body, io.chunkTimeoutMs);
        if (io.signal.aborted) throw abortedError();
        if (read === STALLED) {
          ac.abort();
          throw new XetError(
            `connection stalled — no data for ${Math.round(io.chunkTimeoutMs / 1000)}s`,
            true,
            STALL_ERROR,
          );
        }
        if (read.done) break;
        let bytes = Buffer.from(read.value);
        if (skip > 0) {
          const dropped = Math.min(skip, bytes.length);
          skip -= dropped;
          bytes = bytes.subarray(dropped);
        }
        const room = state.size - state.received;
        if (bytes.length > room) bytes = bytes.subarray(0, room);
        if (bytes.length === 0) continue;
        state.parts.push(bytes);
        state.received += bytes.length;
        io.onBytes(bytes.length);
      }
    } catch (err) {
      if (err instanceof XetError) throw err;
      // A body that dies part-way: "terminated", ECONNRESET, a length that
      // does not match its header. The commonest failure on a congested link.
      throw new XetError(friendlyStreamError(err), true, rawErrorString(err), io.signal.aborted);
    } finally {
      body.cancel().catch(() => undefined);
    }
    if (state.received < state.size) {
      throw new XetError(
        'Connection dropped mid-download',
        true,
        `short-body ${state.received}/${state.size}`,
      );
    }
  } finally {
    io.signal.removeEventListener('abort', stop);
  }
}

const STALLED = Symbol('stalled');

type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

/** The next read, or {@link STALLED} when nothing arrives for `ms`. */
async function readOrStall(
  reader: BodyReader,
  ms: number,
): Promise<Awaited<ReturnType<BodyReader['read']>> | typeof STALLED> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<typeof STALLED>((resolve) => {
        timeout = setTimeout(() => resolve(STALLED), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Queue every chunk and wait for the last to be accepted. */
function writeChunks(stream: WriteStream, chunks: readonly Buffer[]): Promise<void> {
  const last = chunks.at(-1);
  if (!last) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    stream.cork();
    for (let index = 0; index < chunks.length - 1; index++) stream.write(chunks[index]!);
    stream.write(last, (err) => (err ? reject(err) : resolve()));
    stream.uncork();
  });
}

async function closeStream(stream: WriteStream): Promise<void> {
  if (!stream.destroyed) stream.destroy();
  if (stream.closed) return;
  await new Promise<void>((resolve) => stream.once('close', () => resolve()));
}
