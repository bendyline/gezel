import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DownloadEvent,
  type DownloadResult,
  downloadWithRetry,
} from '@bendyline/gezel-inference/internal/utils/download-with-retry';
import { downloadXet } from '@bendyline/gezel-inference/internal/utils/xet-download';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// A scheme-0 (uncompressed) Xet chunk: 8-byte header + raw payload.
function noneChunk(payload: Buffer): Buffer {
  const l = payload.length;
  const header = Buffer.from([
    0,
    l & 0xff,
    (l >> 8) & 0xff,
    (l >> 16) & 0xff,
    0,
    l & 0xff,
    (l >> 8) & 0xff,
    (l >> 16) & 0xff,
  ]);
  return Buffer.concat([header, payload]);
}

const RESOLVE = 'https://huggingface.co/org/repo/resolve/abc123/model.bin?download=true';
const AUTH = 'https://huggingface.co/api/models/org/repo/xet-read-token/abc123';
const CAS = 'https://cas.example';
const XORB = 'https://transfer.example/xorbs/xorbA';
const XETHASH = 'deadbeefdeadbeef';

/** Build a mock fetch that serves a two-chunk Xet file, honoring the protocol
 * (resolve 302 → token → reconstruction → xorb range). `overrides` can replace
 * any leg (e.g. force a 403 token). */
function xetFetch(opts: {
  file: Buffer;
  offsetIntoFirstRange?: number;
  tokenStatus?: number;
  uaSeen?: string[];
  /** Lie about the term's size (a hostile or buggy manifest). */
  declaredLength?: number;
}): typeof fetch {
  const half = Math.ceil(opts.file.length / 2);
  const seg = Buffer.concat([
    noneChunk(opts.file.subarray(0, half)),
    noneChunk(opts.file.subarray(half)),
  ]);
  const recon = {
    offset_into_first_range: opts.offsetIntoFirstRange ?? 0,
    terms: [
      {
        hash: 'xorbA',
        unpacked_length: opts.declaredLength ?? opts.file.length,
        range: { start: 0, end: 2 },
      },
    ],
    fetch_info: {
      xorbA: [
        { range: { start: 0, end: 2 }, url: XORB, url_range: { start: 0, end: seg.length - 1 } },
      ],
    },
  };
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const ua = (init?.headers as Record<string, string> | undefined)?.['User-Agent'];
    if (ua) opts.uaSeen?.push(ua);
    if (url.includes('/resolve/')) {
      return new Response(null, {
        status: 302,
        headers: { 'x-xet-hash': XETHASH, link: `<${AUTH}>; rel="xet-auth"` },
      });
    }
    if (url === AUTH) {
      return new Response(JSON.stringify({ casUrl: CAS, accessToken: 'tok', exp: 9999999999 }), {
        status: opts.tokenStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith(`${CAS}/v1/reconstructions/`)) {
      return new Response(JSON.stringify(recon), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === XORB) {
      return new Response(new Uint8Array(seg), { status: 206 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

/** Xet fixture with one independently fetchable xorb per reconstruction term.
 * This lets resume tests prove that terms wholly covered by `.partial` never
 * hit the network again. */
function segmentedXetFetch(opts: {
  parts: Buffer[];
  requested: number[];
  /** Xorb index that answers 503 for its first `failTimes` requests. */
  failAt?: number;
  failTimes?: number;
  delayMs?: number;
  /** Xorb index that answers only after `slowMs`, holding up the in-order writer. */
  slowAt?: number;
  slowMs?: number;
  concurrency?: { active: number; maxActive: number };
}): typeof fetch {
  const segments = opts.parts.map((part) => noneChunk(part));
  const recon = {
    offset_into_first_range: 0,
    terms: opts.parts.map((part, index) => ({
      hash: `xorb${index}`,
      unpacked_length: part.length,
      range: { start: 0, end: 1 },
    })),
    fetch_info: Object.fromEntries(
      segments.map((segment, index) => [
        `xorb${index}`,
        [
          {
            range: { start: 0, end: 1 },
            url: `${XORB}/${index}`,
            url_range: { start: 0, end: segment.length - 1 },
          },
        ],
      ]),
    ),
  };
  const budget = opts.failTimes ?? 1;
  let failures = 0;

  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/resolve/')) {
      return new Response(null, {
        status: 302,
        headers: { 'x-xet-hash': XETHASH, link: `<${AUTH}>; rel="xet-auth"` },
      });
    }
    if (url === AUTH) {
      return new Response(JSON.stringify({ casUrl: CAS, accessToken: 'tok', exp: 9999999999 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith(`${CAS}/v1/reconstructions/`)) {
      return new Response(JSON.stringify(recon), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith(`${XORB}/`)) {
      const index = Number.parseInt(url.slice(`${XORB}/`.length), 10);
      opts.requested.push(index);
      if (opts.concurrency) {
        opts.concurrency.active++;
        opts.concurrency.maxActive = Math.max(opts.concurrency.maxActive, opts.concurrency.active);
      }
      try {
        if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        if (index === opts.slowAt && opts.slowMs) {
          await new Promise((resolve) => setTimeout(resolve, opts.slowMs));
        }
        if (index === opts.failAt && failures < budget) {
          failures++;
          return new Response(null, { status: 503 });
        }
        const segment = segments[index];
        if (!segment) throw new Error(`unexpected xorb index: ${index}`);
        return new Response(new Uint8Array(segment), { status: 206 });
      } finally {
        if (opts.concurrency) opts.concurrency.active--;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function run(
  gen: AsyncGenerator<DownloadEvent, DownloadResult, void>,
): Promise<{ events: DownloadEvent[]; result: DownloadResult }> {
  const events: DownloadEvent[] = [];
  while (true) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

describe('downloadWithRetry — Xet path', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-xet-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects a Xet 302, reconstructs the file, and writes .partial', async () => {
    const file = Buffer.from('HELLO-XET-WORLD-this-was-reconstructed-from-chunks!');
    const uaSeen: string[] = [];
    const destPath = join(dir, 'model.bin');
    const { events, result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: file.length,
        fetchImpl: xetFetch({ file, uaSeen }),
      }),
    );
    expect(result.kind).toBe('ok');
    expect(readFileSync(`${destPath}.partial`)).toEqual(file);
    // progress reported against the exact reconstructed total
    const lastProgress = [...events].reverse().find((e) => e.type === 'progress');
    expect(lastProgress).toMatchObject({ bytesWritten: file.length, totalBytes: file.length });
    // honest gezel User-Agent on every leg
    expect(uaSeen.length).toBeGreaterThan(0);
    expect(uaSeen.every((ua) => ua.startsWith('gezel/'))).toBe(true);
  });

  it('honors offset_into_first_range (drops leading bytes)', async () => {
    const full = Buffer.from('0123456789abcdef');
    const destPath = join(dir, 'off.bin');
    // The reconstruction covers `full`, but the file starts 4 bytes in.
    const { result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: xetFetch({ file: full, offsetIntoFirstRange: 4 }),
      }),
    );
    expect(result.kind).toBe('ok');
    expect(readFileSync(`${destPath}.partial`)).toEqual(full.subarray(4));
  });

  it('resumes from a partial file without fetching completed Xet terms again', async () => {
    const parts = [Buffer.from('AAAA'), Buffer.from('BBBB'), Buffer.from('CCCC')];
    const full = Buffer.concat(parts);
    const resumeFrom = Buffer.concat([parts[0]!, parts[1]!.subarray(0, 2)]);
    const requested: number[] = [];
    const destPath = join(dir, 'resumed.bin');
    writeFileSync(`${destPath}.partial`, resumeFrom);

    const { events, result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: segmentedXetFetch({ parts, requested }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(readFileSync(`${destPath}.partial`)).toEqual(full);
    // Term 0 is wholly present and must not be fetched. Term 1 contains the
    // resume boundary, so it is reconstructed once and sliced before append.
    expect(requested).toEqual([1, 2]);
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((event) => event.bytesWritten > resumeFrom.length)).toBe(true);
  });

  it('absorbs a single xorb failure in place, without spending a whole-file attempt', async () => {
    // Regression: a segment blip used to unwind to the outer loop, re-mint the
    // CAS token, re-fetch the reconstruction manifest, and — the part that
    // actually broke first-run installs — burn one of only five whole-file
    // attempts. A multi-GB file is hundreds of segments, so an occasional
    // blip exhausted the budget long before the file finished.
    const parts = [Buffer.from('AAAA'), Buffer.from('BBBB'), Buffer.from('CCCC')];
    const full = Buffer.concat(parts);
    const requested: number[] = [];
    const destPath = join(dir, 'inner-retry.bin');

    const { events, result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: segmentedXetFetch({ parts, requested, failAt: 1, failTimes: 1 }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(readFileSync(`${destPath}.partial`)).toEqual(full);
    // Only the failed segment is re-requested; the walk continues from there.
    expect(requested.filter((index) => index === 0)).toHaveLength(1);
    expect(requested.filter((index) => index === 1)).toHaveLength(2);
    expect(requested.filter((index) => index === 2)).toHaveLength(1);
    // No outer retry — the whole-file attempt was never restarted.
    expect(events.some((event) => event.type === 'retrying')).toBe(false);
  });

  it('skips completed Xet terms when an automatic retry resumes the same pull', async () => {
    const parts = [Buffer.from('AAAA'), Buffer.from('BBBB'), Buffer.from('CCCC')];
    const full = Buffer.concat(parts);
    const requested: number[] = [];
    const destPath = join(dir, 'retried.bin');

    // Fail term 1 past the in-place segment budget so the failure escalates to
    // the whole-file retry loop.
    const { events, result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: segmentedXetFetch({ parts, requested, failAt: 1, failTimes: 3 }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(readFileSync(`${destPath}.partial`)).toEqual(full);
    expect(events.some((event) => event.type === 'retrying')).toBe(true);
    // The first term completed before term 1 transiently failed. The retry
    // starts at term 1 rather than silently re-downloading term 0.
    expect(requested.filter((index) => index === 0)).toHaveLength(1);
    expect(requested.filter((index) => index === 1)).toHaveLength(4);
    // Term 2 had arrived and was waiting its turn behind term 1. The retry
    // keeps it; it used to be fetched a second time.
    expect(requested.filter((index) => index === 2)).toHaveLength(1);
  });

  it('prefetches independent terms concurrently while preserving output order', async () => {
    const parts = [Buffer.from('AAAA'), Buffer.from('BBBB'), Buffer.from('CCCC')];
    const requested: number[] = [];
    const concurrency = { active: 0, maxActive: 0 };
    const destPath = join(dir, 'parallel.bin');

    const { result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: 12,
        fetchImpl: segmentedXetFetch({
          parts,
          requested,
          delayMs: 20,
          concurrency,
        }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(concurrency.maxActive).toBeGreaterThan(1);
    expect(readFileSync(`${destPath}.partial`)).toEqual(Buffer.concat(parts));
  });

  // Bytes reach the file only in term order. With the first term slow, the
  // bar read 0% while the rest of the file arrived (a 2 GB model, 2026-10-08).
  it('moves progress with bytes received while the first term is still arriving', async () => {
    const parts = [Buffer.alloc(4000, 1), Buffer.alloc(4000, 2), Buffer.alloc(4000, 3)];
    const destPath = join(dir, 'slow-head.bin');

    const { events, result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: 12_000,
        fetchImpl: segmentedXetFetch({ parts, requested: [], slowAt: 0, slowMs: 1_300 }),
      }),
    );

    expect(result.kind).toBe('ok');
    const written = events.flatMap((e) => (e.type === 'progress' ? [e.bytesWritten] : []));
    expect(written.some((b) => b > 0 && b < 12_000)).toBe(true);
    expect(written).toEqual([...written].sort((a, b) => a - b));
    expect(written.at(-1)).toBe(12_000);
    expect(readFileSync(`${destPath}.partial`)).toEqual(Buffer.concat(parts));
  });

  it('treats a 403 from the token endpoint as fatal (gated repo — no endless retry)', async () => {
    const file = Buffer.from('secret');
    const destPath = join(dir, 'gated.bin');
    const { result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: file.length,
        fetchImpl: xetFetch({ file, tokenStatus: 403 }),
        maxRetries: 3,
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toMatch(/Access denied/i);
      expect(result.attemptsMade).toBe(1); // fatal → no retries burned
    }
  });
});

/** What one request for a xorb does instead of serving its byte range whole. */
interface Fault {
  /** Send this many bytes, then fail the body the way a dropped connection does. */
  cutAfter?: number;
  /** Send this many bytes, then end the body as if it were complete. */
  shortAfter?: number;
  /** Send this many bytes, then nothing more, without closing. */
  stallAfter?: number;
  /** Answer with this status and no body. */
  status?: number;
  /** Serve bytes that are not Xet chunks. */
  garbage?: boolean;
}

interface RangedRequest {
  index: number;
  /** The Range header as sent. */
  range: string;
  /** Which manifest the link came from (1-based). */
  links: number;
  /** Requests in flight when this one started, itself included. Set when `concurrency` is. */
  inFlight?: number;
}

/**
 * A Xet host that behaves like the real one where a bad connection matters: it
 * serves the byte range asked for and says which (`Content-Range`), each
 * manifest carries new links, and a link can stop being accepted. One xorb per
 * term unless `recon` is given.
 */
function rangedXetFetch(opts: {
  parts: Buffer[];
  requests: RangedRequest[];
  /** Per xorb: one fault per request, in order. Requests past the list are served. */
  faults?: Record<number, Fault[]>;
  /** Serve the whole segment whatever range is asked for, and do not say which. */
  ignoreRange?: boolean;
  /** Refuse (403) links to this xorb that come from a manifest older than `links`. */
  expire?: { index: number; links: number };
  delayMs?: number;
  concurrency?: { active: number; maxActive: number };
  manifests?: { count: number };
}): typeof fetch {
  const segments = opts.parts.map((part) => noneChunk(part));
  const faults = new Map(Object.entries(opts.faults ?? {}).map(([k, v]) => [Number(k), [...v]]));
  let manifests = 0;

  const body = (bytes: Buffer, fault: Fault | undefined): ReadableStream<Uint8Array> => {
    const limit = fault?.cutAfter ?? fault?.shortAfter ?? fault?.stallAfter ?? bytes.length;
    let sent = 0;
    // Pulled a piece at a time: a stream that errors drops what it has queued,
    // and the bytes before a dropped connection do arrive.
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < Math.min(limit, bytes.length)) {
          const end = Math.min(sent + 16_384, limit, bytes.length);
          controller.enqueue(new Uint8Array(bytes.subarray(sent, end)));
          sent = end;
          return;
        }
        if (fault?.cutAfter !== undefined) controller.error(new TypeError('terminated'));
        else if (fault?.stallAfter !== undefined) return new Promise<void>(() => undefined);
        else controller.close();
      },
    });
  };

  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === AUTH) {
      return new Response(JSON.stringify({ casUrl: CAS, accessToken: 'tok', exp: 9999999999 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith(`${CAS}/v1/reconstructions/`)) {
      manifests++;
      if (opts.manifests) opts.manifests.count = manifests;
      const recon = {
        offset_into_first_range: 0,
        terms: opts.parts.map((part, index) => ({
          hash: `xorb${index}`,
          unpacked_length: part.length,
          range: { start: 0, end: 1 },
        })),
        fetch_info: Object.fromEntries(
          segments.map((segment, index) => [
            `xorb${index}`,
            [
              {
                range: { start: 0, end: 1 },
                url: `${XORB}/${index}?links=${manifests}`,
                url_range: { start: 0, end: segment.length - 1 },
              },
            ],
          ]),
        ),
      };
      return new Response(JSON.stringify(recon), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const match = /\/(\d+)\?links=(\d+)$/.exec(url);
    if (!url.startsWith(`${XORB}/`) || !match) throw new Error(`unexpected fetch: ${url}`);
    const index = Number(match[1]);
    const links = Number(match[2]);
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? '';
    const request: RangedRequest = { index, range, links };
    opts.requests.push(request);
    if (opts.concurrency) {
      opts.concurrency.active++;
      opts.concurrency.maxActive = Math.max(opts.concurrency.maxActive, opts.concurrency.active);
      request.inFlight = opts.concurrency.active;
    }
    try {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      if (opts.expire?.index === index && links < opts.expire.links) {
        return new Response(null, { status: 403 });
      }
      const fault = faults.get(index)?.shift();
      if (fault?.status) return new Response(null, { status: fault.status });
      const segment = segments[index];
      if (!segment) throw new Error(`unexpected xorb index: ${index}`);
      if (opts.ignoreRange) return new Response(body(segment, fault), { status: 206 });
      const asked = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!asked) return new Response(null, { status: 403 });
      const start = Number(asked[1]);
      const end = Number(asked[2]);
      const bytes = fault?.garbage
        ? Buffer.alloc(end - start + 1, 9)
        : segment.subarray(start, end + 1);
      return new Response(body(bytes, fault), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${segment.length}` },
      });
    } finally {
      if (opts.concurrency) opts.concurrency.active--;
    }
  }) as typeof fetch;
}

/** `length` bytes that differ from part to part and from byte to byte. */
function patterned(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 97 + (i >> 8)) & 0xff;
  return out;
}

function rangesOf(requests: RangedRequest[], index: number): string[] {
  return requests.filter((request) => request.index === index).map((request) => request.range);
}

/**
 * Whether the file at `path` holds exactly `expected`. Not `toEqual`, which walks
 * a buffer key by key: a second for these files, and for the 10 MB one more
 * memory than the worker's heap.
 */
function sameBytes(path: string, expected: Buffer): boolean {
  return readFileSync(path).equals(expected);
}

describe('downloadXet — a bad connection', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-xet-flaky-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const detection = { xetHash: XETHASH, authUrl: AUTH };
  const parts = [patterned(200_000, 1), patterned(200_000, 2), patterned(200_000, 3)];
  const full = Buffer.concat(parts);
  /** A noneChunk segment is its payload plus an 8-byte header. */
  const lastByte = 200_000 + 8 - 1;

  // The failure that ended first-run installs on a saturated link (2026-11-12):
  // a body that dies part-way was not a failure the in-place retry recognised,
  // so each one cost a whole-file attempt and everything in flight.
  it('continues a segment from the byte where its connection dropped', async () => {
    const requests: RangedRequest[] = [];
    const destPath = join(dir, 'dropped.bin');
    const { events, result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: rangedXetFetch({ parts, requests, faults: { 1: [{ cutAfter: 100_000 }] } }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, full)).toBe(true);
    expect(rangesOf(requests, 1)).toEqual([`bytes=0-${lastByte}`, `bytes=100000-${lastByte}`]);
    expect(rangesOf(requests, 0)).toHaveLength(1);
    expect(rangesOf(requests, 2)).toHaveLength(1);
    expect(events.some((event) => event.type === 'retrying')).toBe(false);
  });

  it('finishes a segment on a link that cuts every connection', async () => {
    const requests: RangedRequest[] = [];
    const destPath = join(dir, 'every-connection.bin');
    // More cuts than a segment may fail in a row; each one moved data.
    const cuts = Array.from({ length: 2 }, () => ({ cutAfter: 70_000 }));
    const { events, result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: rangedXetFetch({
          parts,
          requests,
          faults: { 0: [...cuts], 1: [...cuts], 2: [...cuts] },
        }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, full)).toBe(true);
    expect(rangesOf(requests, 0)).toEqual([
      `bytes=0-${lastByte}`,
      `bytes=70000-${lastByte}`,
      `bytes=140000-${lastByte}`,
    ]);
    expect(events.some((event) => event.type === 'retrying')).toBe(false);
  });

  it('continues a segment whose body ended early or stopped arriving', async () => {
    const requests: RangedRequest[] = [];
    const destPath = join(dir, 'short-and-stalled.bin');
    const { result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        chunkTimeoutMs: 150,
        fetchImpl: rangedXetFetch({
          parts,
          requests,
          faults: { 0: [{ shortAfter: 80_000 }], 2: [{ stallAfter: 120_000 }] },
        }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, full)).toBe(true);
    expect(rangesOf(requests, 0)).toEqual([`bytes=0-${lastByte}`, `bytes=80000-${lastByte}`]);
    expect(rangesOf(requests, 2)).toEqual([`bytes=0-${lastByte}`, `bytes=120000-${lastByte}`]);
  });

  it('starts a segment again when the host does not serve the rest of it', async () => {
    const requests: RangedRequest[] = [];
    const destPath = join(dir, 'ignores-range.bin');
    const { result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: rangedXetFetch({
          parts,
          requests,
          ignoreRange: true,
          faults: { 1: [{ cutAfter: 100_000 }] },
        }),
      }),
    );

    // The second answer is the whole segment again, not the half asked for. The
    // first half held must be dropped, not written before it.
    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, full)).toBe(true);
  });

  it('keeps what an attempt received, and never moves progress back, when the file is retried', async () => {
    const requests: RangedRequest[] = [];
    const destPath = join(dir, 'retried-whole.bin');
    // Term 1 gets half-way, then the host fails it three times in a row: the
    // segment gives up and the whole-file attempt is retried.
    const { events, result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: rangedXetFetch({
          parts,
          requests,
          faults: {
            1: [{ cutAfter: 100_000 }, { status: 503 }, { status: 503 }, { status: 503 }],
          },
        }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, full)).toBe(true);
    expect(events.filter((event) => event.type === 'retrying')).toHaveLength(1);
    // The new attempt has new links and asks only for the half still missing.
    const term1 = requests.filter((request) => request.index === 1);
    expect(term1.at(-1)).toEqual({ index: 1, range: `bytes=100000-${lastByte}`, links: 2 });
    // Term 2 had arrived whole behind it and is not fetched again.
    expect(rangesOf(requests, 2)).toHaveLength(1);
    expect(rangesOf(requests, 0)).toHaveLength(1);

    const retryAt = events.findIndex((event) => event.type === 'retrying');
    const written = (list: DownloadEvent[]) =>
      list.flatMap((event) => (event.type === 'progress' ? [event.bytesWritten] : []));
    const before = written(events.slice(0, retryAt));
    const after = written(events.slice(retryAt));
    // Before the retry the bar counted term 0 on disk and what had been
    // received of terms 1 and 2. It read 1% after a retry (2026-11-12).
    expect(Math.max(...before)).toBeGreaterThan(parts[0]!.length + 100_000);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(Math.max(...before));
    expect(written(events)).toEqual([...written(events)].sort((a, b) => a - b));
  });

  it('fetches a damaged segment again from its first byte', async () => {
    const requests: RangedRequest[] = [];
    const destPath = join(dir, 'damaged.bin');
    const { events, result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: rangedXetFetch({ parts, requests, faults: { 2: [{ garbage: true }] } }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, full)).toBe(true);
    expect(events.filter((event) => event.type === 'retrying')).toHaveLength(1);
    expect(rangesOf(requests, 2)).toEqual([`bytes=0-${lastByte}`, `bytes=0-${lastByte}`]);
  });

  // Segment links last an hour. A large file on a slow link outlives them.
  it('fetches new links when they expire mid-download, without a retry notice', async () => {
    const big = [patterned(5 * 1024 * 1024, 4), patterned(5 * 1024 * 1024, 5), patterned(1024, 6)];
    const requests: RangedRequest[] = [];
    const manifests = { count: 0 };
    const destPath = join(dir, 'expired-links.bin');
    const { events, result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: 10 * 1024 * 1024,
        fetchImpl: rangedXetFetch({
          parts: big,
          requests,
          manifests,
          expire: { index: 2, links: 2 },
        }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, Buffer.concat(big))).toBe(true);
    expect(manifests.count).toBe(2);
    expect(events.some((event) => event.type === 'retrying')).toBe(false);
    // One refused request, not three: asking again with the same link cannot work.
    expect(requests.filter((request) => request.index === 2)).toEqual([
      expect.objectContaining({ links: 1 }),
      expect.objectContaining({ links: 2 }),
    ]);
    expect(rangesOf(requests, 0)).toHaveLength(1);
    expect(rangesOf(requests, 1)).toHaveLength(1);
  });

  it('gives up on links that new ones do not cure', async () => {
    const requests: RangedRequest[] = [];
    const destPath = join(dir, 'refused.bin');
    const { events, result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        maxRetries: 2,
        fetchImpl: rangedXetFetch({ parts, requests, expire: { index: 0, links: 99 } }),
      }),
    );

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toMatch(/Access denied/);
      expect(result.attemptsMade).toBe(2);
    }
    expect(events.filter((event) => event.type === 'retrying')).toHaveLength(1);
  });

  it('stops at once when cancelled while a segment is arriving', async () => {
    const requests: RangedRequest[] = [];
    const controller = new AbortController();
    const destPath = join(dir, 'cancelled.bin');
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);
    const { result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        signal: controller.signal,
        fetchImpl: rangedXetFetch({ parts, requests, faults: { 1: [{ stallAfter: 50_000 }] } }),
      }),
    );

    expect(result.kind).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(2_000);
    // Term 0 was written before the cancel and is there to resume from.
    expect(sameBytes(`${destPath}.partial`, parts[0]!)).toBe(true);
  });

  it('opens fewer streams after a connection carries nothing, not after one that was cut', async () => {
    const many = Array.from({ length: 16 }, (_, index) => patterned(100_000, index));
    /** Most requests in flight at once among the terms fetched after the first eight. */
    const laterStreams = async (name: string, faults: Record<number, Fault[]>) => {
      const requests: RangedRequest[] = [];
      const destPath = join(dir, name);
      const { result } = await run(
        downloadXet({
          detection,
          destPath,
          approxSizeBytes: 1_600_000,
          fetchImpl: rangedXetFetch({
            parts: many,
            requests,
            faults,
            delayMs: 60,
            concurrency: { active: 0, maxActive: 0 },
          }),
        }),
      );
      expect(result.kind).toBe('ok');
      expect(sameBytes(`${destPath}.partial`, Buffer.concat(many))).toBe(true);
      return Math.max(...requests.filter((r) => r.index >= 8).map((r) => r.inFlight ?? 0));
    };

    // Eight terms are fetched ahead of the writer.
    expect(await laterStreams('steady.bin', {})).toBe(8);
    // A connection cut after it carried data says nothing about the link.
    expect(await laterStreams('cut.bin', { 0: [{ cutAfter: 80_000 }] })).toBe(8);
    // One that carried nothing does: half as many, won back a term at a time.
    const afterTrouble = await laterStreams('refused.bin', { 0: [{ status: 503 }] });
    expect(afterTrouble).toBeGreaterThanOrEqual(4);
    expect(afterTrouble).toBeLessThanOrEqual(6);
  });

  it('holds no more than its byte allowance ahead of the writer', async () => {
    const small = Array.from({ length: 6 }, (_, index) => patterned(4_000, index));
    const concurrency = { active: 0, maxActive: 0 };
    const destPath = join(dir, 'bounded-window.bin');
    const { result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: 24_000,
        // Room for two 4 KB segments, not the eight terms otherwise fetched ahead.
        windowBytes: 9_000,
        fetchImpl: rangedXetFetch({ parts: small, requests: [], delayMs: 25, concurrency }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, Buffer.concat(small))).toBe(true);
    expect(concurrency.maxActive).toBe(2);
  });

  it('admits a term larger than the whole allowance, alone', async () => {
    const destPath = join(dir, 'oversized-term.bin');
    const concurrency = { active: 0, maxActive: 0 };
    const { result } = await run(
      downloadXet({
        detection,
        destPath,
        approxSizeBytes: full.length,
        windowBytes: 1_000,
        fetchImpl: rangedXetFetch({ parts, requests: [], delayMs: 10, concurrency }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, full)).toBe(true);
    expect(concurrency.maxActive).toBe(1);
  });
});

// Real files are not one xorb per term: a term reads across segments, segments
// start part-way into a xorb, and a later term reads a xorb again.
describe('downloadXet — terms that span segments and share a xorb', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-xet-shared-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const chunks = [patterned(1_000, 1), patterned(2_000, 2), patterned(1_500, 3), patterned(500, 4)];
  const [c0, c1, c2, c3] = chunks as [Buffer, Buffer, Buffer, Buffer];
  const other = patterned(800, 5);
  const segmentA = Buffer.concat([noneChunk(c0), noneChunk(c1)]);
  const segmentB = Buffer.concat([noneChunk(c2), noneChunk(c3)]);
  const xorbX = Buffer.concat([segmentA, segmentB]);
  const xorbY = noneChunk(other);
  const LEADING_TRIM = 300;
  const expected = Buffer.concat([c0, c1, c2, other, c1, c2, c3]).subarray(LEADING_TRIM);
  const recon = {
    offset_into_first_range: LEADING_TRIM,
    terms: [
      { hash: 'X', unpacked_length: 4_500, range: { start: 0, end: 3 } },
      { hash: 'Y', unpacked_length: 800, range: { start: 0, end: 1 } },
      { hash: 'X', unpacked_length: 4_000, range: { start: 1, end: 4 } },
    ],
    fetch_info: {
      X: [
        {
          range: { start: 0, end: 2 },
          url: `${XORB}/X`,
          url_range: { start: 0, end: segmentA.length - 1 },
        },
        {
          range: { start: 2, end: 4 },
          url: `${XORB}/X`,
          url_range: { start: segmentA.length, end: xorbX.length - 1 },
        },
      ],
      Y: [{ range: { start: 0, end: 1 }, url: `${XORB}/Y`, url_range: { start: 0, end: 807 } }],
    },
  };

  /** Serves the byte range asked for. `cutSecondSegmentAt` drops its first request there. */
  function sharedFetch(ranges: string[], cutSecondSegmentAt?: number): typeof fetch {
    let cut = cutSecondSegmentAt;
    return (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === AUTH) {
        return new Response(JSON.stringify({ casUrl: CAS, accessToken: 'tok' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith(`${CAS}/v1/reconstructions/`)) {
        return new Response(JSON.stringify(recon), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const xorb = url === `${XORB}/X` ? xorbX : url === `${XORB}/Y` ? xorbY : undefined;
      const range = (init?.headers as Record<string, string> | undefined)?.Range ?? '';
      const asked = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!xorb || !asked) throw new Error(`unexpected fetch: ${url} ${range}`);
      ranges.push(`${url.slice(-1)} ${range}`);
      const start = Number(asked[1]);
      const end = Number(asked[2]);
      let bytes = xorb.subarray(start, end + 1);
      let dropped = false;
      if (cut !== undefined && url === `${XORB}/X` && start === segmentA.length) {
        bytes = bytes.subarray(0, cut);
        cut = undefined;
        dropped = true;
      }
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array(bytes));
          } else if (dropped) {
            controller.error(new TypeError('terminated'));
          } else {
            controller.close();
          }
        },
      });
      return new Response(body, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${xorb.length}` },
      });
    }) as typeof fetch;
  }

  it('reassembles the file, fetching each segment once for the terms that share it', async () => {
    const ranges: string[] = [];
    const destPath = join(dir, 'shared.bin');
    const { result } = await run(
      downloadXet({
        detection: { xetHash: XETHASH, authUrl: AUTH },
        destPath,
        approxSizeBytes: expected.length,
        fetchImpl: sharedFetch(ranges),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, expected)).toBe(true);
    expect([...ranges].sort()).toEqual([
      `X bytes=0-${segmentA.length - 1}`,
      `X bytes=${segmentA.length}-${xorbX.length - 1}`,
      'Y bytes=0-807',
    ]);
  });

  it('resumes inside the last term, and inside a segment that starts part-way into its xorb', async () => {
    const ranges: string[] = [];
    const destPath = join(dir, 'shared-resumed.bin');
    // On disk: terms 0 and 1, and the first 1,700 bytes of term 2.
    const onDisk = 4_500 - LEADING_TRIM + 800 + 1_700;
    writeFileSync(`${destPath}.partial`, expected.subarray(0, onDisk));

    const { result } = await run(
      downloadXet({
        detection: { xetHash: XETHASH, authUrl: AUTH },
        destPath,
        approxSizeBytes: expected.length,
        fetchImpl: sharedFetch(ranges, 700),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(sameBytes(`${destPath}.partial`, expected)).toBe(true);
    // Xorb Y is wholly on disk and is not fetched. The second segment's dropped
    // request is continued from the byte it reached within the xorb.
    expect([...ranges].sort()).toEqual([
      `X bytes=0-${segmentA.length - 1}`,
      `X bytes=${segmentA.length}-${xorbX.length - 1}`,
      `X bytes=${segmentA.length + 700}-${xorbX.length - 1}`,
    ]);
  });
});

describe('downloadWithRetry — Xet path with a byte cap', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gezel-xet-cap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes the reconstruction path for a bounded download that fits the cap', async () => {
    const file = Buffer.from('bounded download through xet');
    const dest = join(dir, 'model.bin');
    const { result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath: dest,
        approxSizeBytes: file.length,
        maxBytes: file.length,
        fetchImpl: xetFetch({ file }),
      }),
    );
    expect(result.kind).toBe('ok');
    expect(readFileSync(`${dest}.partial`)).toEqual(file);
  });

  it('refuses a reconstruction whose exact total exceeds the cap before streaming', async () => {
    const file = Buffer.from('this file is larger than the caller allows');
    const dest = join(dir, 'model.bin');
    const { result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath: dest,
        approxSizeBytes: file.length,
        maxBytes: file.length - 1,
        fetchImpl: xetFetch({ file }),
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error).toMatch(/byte limit/);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it('stops a manifest that under-declares its size from over-delivering past the cap', async () => {
    const file = Buffer.from('forty bytes of payload, declared as twenty!!');
    const dest = join(dir, 'model.bin');
    const { result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath: dest,
        approxSizeBytes: 20,
        maxBytes: 20,
        fetchImpl: xetFetch({ file, declaredLength: 20 }),
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error).toMatch(/byte limit/);
  });

  it('refuses an oversized .partial before touching the network', async () => {
    const dest = join(dir, 'model.bin');
    writeFileSync(`${dest}.partial`, Buffer.alloc(64));
    const fetchImpl = (async () => {
      throw new Error('network must not be touched');
    }) as unknown as typeof fetch;
    const { result } = await run(
      downloadXet({
        detection: { xetHash: XETHASH, authUrl: AUTH },
        destPath: dest,
        approxSizeBytes: 64,
        maxBytes: 32,
        fetchImpl,
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error).toMatch(/byte limit/);
  });
});
