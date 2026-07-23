import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DownloadEvent,
  type DownloadResult,
  downloadWithRetry,
} from './download-with-retry.js';

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
}): typeof fetch {
  const half = Math.ceil(opts.file.length / 2);
  const seg = Buffer.concat([
    noneChunk(opts.file.subarray(0, half)),
    noneChunk(opts.file.subarray(half)),
  ]);
  const recon = {
    offset_into_first_range: opts.offsetIntoFirstRange ?? 0,
    terms: [{ hash: 'xorbA', unpacked_length: opts.file.length, range: { start: 0, end: 2 } }],
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
  failOnceAt?: number;
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
  let failed = false;

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
      if (index === opts.failOnceAt && !failed) {
        failed = true;
        return new Response(null, { status: 503 });
      }
      const segment = segments[index];
      if (!segment) throw new Error(`unexpected xorb index: ${index}`);
      return new Response(new Uint8Array(segment), { status: 206 });
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

  it('skips completed Xet terms when an automatic retry resumes the same pull', async () => {
    const parts = [Buffer.from('AAAA'), Buffer.from('BBBB'), Buffer.from('CCCC')];
    const full = Buffer.concat(parts);
    const requested: number[] = [];
    const destPath = join(dir, 'retried.bin');

    const { events, result } = await run(
      downloadWithRetry({
        url: RESOLVE,
        destPath,
        approxSizeBytes: full.length,
        fetchImpl: segmentedXetFetch({ parts, requested, failOnceAt: 1 }),
      }),
    );

    expect(result.kind).toBe('ok');
    expect(readFileSync(`${destPath}.partial`)).toEqual(full);
    expect(events.some((event) => event.type === 'retrying')).toBe(true);
    // The first term completed before term 1 transiently failed. The retry
    // starts at term 1 rather than silently re-downloading term 0.
    expect(requested).toEqual([0, 1, 1, 2]);
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
