import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DownloadEvent,
  type DownloadResult,
  downloadWithRetry,
} from './download-with-retry.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Small async iterator helper to drain the generator + collect events. */
async function runDownload(
  gen: AsyncGenerator<DownloadEvent, DownloadResult, void>,
): Promise<{ events: DownloadEvent[]; result: DownloadResult }> {
  const events: DownloadEvent[] = [];
  while (true) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

function makeFetchSequence(scripts: Array<() => Promise<Response>>): {
  fetchImpl: typeof fetch;
  callCount: () => number;
  callLog: { url: string; range: string | null }[];
} {
  let idx = 0;
  const callLog: { url: string; range: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    let range: string | null = null;
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        range = init.headers.get('Range');
      } else if (Array.isArray(init.headers)) {
        // Headers entries are [name, value] tuples in Fetch's types,
        // but tsc widens them to string[] here; cast and check.
        const arr = init.headers as unknown as ReadonlyArray<readonly string[]>;
        const matched = arr.find((entry) => entry[0]?.toLowerCase() === 'range');
        range = matched?.[1] ?? null;
      } else {
        const h = init.headers as Record<string, string>;
        range = h.Range ?? h.range ?? null;
      }
    }
    callLog.push({ url, range });
    const script = scripts[idx++];
    if (!script) {
      throw new Error(`fetch called ${idx} times but only ${scripts.length} scripts registered`);
    }
    return script();
  };
  return { fetchImpl, callCount: () => idx, callLog };
}

function bytesResponse(
  bytes: Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  // Build a real ReadableStream so the generator's reader.read() drains
  // chunk-by-chunk. We deliver in one chunk; that's fine for tests.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : status === 206 ? 'Partial Content' : 'Generated',
    headers: {
      'content-length': String(bytes.byteLength),
      ...headers,
    },
  });
}

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gezel-download-test-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('downloadWithRetry', () => {
  it('happy path: streams to .partial and returns ok', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { fetchImpl } = makeFetchSequence([async () => bytesResponse(payload)]);
    const destPath = join(workDir, 'weights.bin');
    const { result, events } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 8,
        fetchImpl,
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.bytesWritten).toBe(8);
      expect(result.partialPath).toBe(`${destPath}.partial`);
      // A clean single-pass (200) transfer hashes inline, so the caller
      // can skip re-reading the file to verify.
      expect(result.sha256).toBe(sha256(Buffer.from(payload)));
    }
    expect(readFileSync(`${destPath}.partial`)).toEqual(Buffer.from(payload));
    // At least one progress event, none of them `retrying`.
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(events.every((e) => e.type !== 'retrying')).toBe(true);
  });

  it('retries on transient fetch failure and yields a retrying event before the next attempt', async () => {
    const payload = new Uint8Array([0xa, 0xb, 0xc, 0xd]);
    const { fetchImpl, callLog } = makeFetchSequence([
      async () => {
        throw new Error('fetch failed');
      },
      async () => bytesResponse(payload),
    ]);
    const destPath = join(workDir, 'weights.bin');
    const { events, result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 4,
        fetchImpl,
        chunkTimeoutMs: 100, // keep tests fast
      }),
    );
    expect(result.kind).toBe('ok');
    const retryingEvents = events.filter(
      (e): e is Extract<DownloadEvent, { type: 'retrying' }> => e.type === 'retrying',
    );
    expect(retryingEvents.length).toBe(1);
    const retryEvent = retryingEvents[0];
    expect(retryEvent).toBeDefined();
    if (retryEvent) {
      expect(retryEvent.attempt).toBe(2);
      expect(retryEvent.maxAttempts).toBe(5);
      expect(retryEvent.reason).toMatch(/network|reach|connection/i);
    }
    // First call had no Range; second call should have Range too if
    // some bytes had been written. Since the first attempt threw on
    // fetch() (zero bytes received), the Range header should still
    // be absent.
    expect(callLog[0]?.range).toBeNull();
    expect(callLog[1]?.range).toBeNull();
  });

  it('gives up cleanly after maxRetries with a friendly error message', async () => {
    // 3 attempts, each throws. maxRetries: 3 → 3 attempts, then error.
    const { fetchImpl, callCount } = makeFetchSequence([
      async () => {
        throw new Error('getaddrinfo ENOTFOUND huggingface.co');
      },
      async () => {
        throw new Error('getaddrinfo ENOTFOUND huggingface.co');
      },
      async () => {
        throw new Error('getaddrinfo ENOTFOUND huggingface.co');
      },
    ]);
    const destPath = join(workDir, 'weights.bin');
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 100,
        fetchImpl,
        maxRetries: 3,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.attemptsMade).toBe(3);
      expect(result.error).toMatch(/Couldn't reach|gave up after 3 attempts/);
      // No leak of raw Node errno strings — friendliness check.
      expect(result.error).not.toMatch(/ENOTFOUND/);
    }
    expect(callCount()).toBe(3);
  });

  it('treats 404 as fatal — no retry', async () => {
    const { fetchImpl, callCount } = makeFetchSequence([
      async () => new Response(null, { status: 404, statusText: 'Not Found' }),
    ]);
    const destPath = join(workDir, 'weights.bin');
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/missing',
        destPath,
        approxSizeBytes: 100,
        fetchImpl,
        maxRetries: 5,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toMatch(/404|not found/i);
    }
    // No retry; one attempt only.
    expect(callCount()).toBe(1);
  });

  it('treats 429 as transient — retries with backoff', async () => {
    const payload = new Uint8Array([0xee]);
    const { fetchImpl, callCount } = makeFetchSequence([
      async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
      async () => bytesResponse(payload),
    ]);
    const destPath = join(workDir, 'weights.bin');
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 1,
        fetchImpl,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('ok');
    expect(callCount()).toBe(2);
  });

  it('resumes from existing .partial via Range header on retry', async () => {
    const destPath = join(workDir, 'weights.bin');
    const partialPath = `${destPath}.partial`;
    // Seed a .partial with 4 bytes from a prior attempt.
    writeFileSync(partialPath, Buffer.from([0x01, 0x02, 0x03, 0x04]));
    // Mock: fail once, then 206 Partial Content with the remaining 4 bytes.
    const { fetchImpl, callLog } = makeFetchSequence([
      async () => {
        throw new Error('socket hang up');
      },
      async () =>
        bytesResponse(new Uint8Array([0x05, 0x06, 0x07, 0x08]), 206, {
          'content-range': 'bytes 4-7/8',
          'content-length': '4',
        }),
    ]);
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 8,
        fetchImpl,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.bytesWritten).toBe(8);
      // A 206 resume appended to bytes the inline hasher never saw, so no
      // inline digest — the caller must read the file back to verify.
      expect(result.sha256).toBeUndefined();
    }
    // First attempt should have Range (we already had bytes on disk).
    // Second attempt should also have Range (the failed first didn't
    // mutate the .partial because the fetch threw before any byte
    // arrived).
    expect(callLog[0]?.range).toBe('bytes=4-');
    expect(callLog[1]?.range).toBe('bytes=4-');
    // Final file should be the concatenation of the seeded + retry payload.
    expect(readFileSync(partialPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('caps the file at the server-declared size when the body over-delivers', async () => {
    // A quirky CDN / Xet reconstruction streams MORE bytes than Content-Length
    // claims. The write cap must stop at the declared size so the `.partial`
    // can never end up larger than the real file (which would fail sha256
    // forever). Body = 10 bytes, Content-Length = 8.
    const tenBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { fetchImpl } = makeFetchSequence([
      async () => bytesResponse(tenBytes, 200, { 'content-length': '8' }),
    ]);
    const destPath = join(workDir, 'weights.bin');
    const { result } = await runDownload(
      downloadWithRetry({ url: 'https://hf.test/foo', destPath, approxSizeBytes: 8, fetchImpl }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.bytesWritten).toBe(8);
      // Inline digest must cover exactly the 8 kept bytes, not the 10 streamed.
      expect(result.sha256).toBe(sha256(Buffer.from(tenBytes.subarray(0, 8))));
    }
    expect(statSync(`${destPath}.partial`).size).toBe(8);
    expect(readFileSync(`${destPath}.partial`)).toEqual(Buffer.from(tenBytes.subarray(0, 8)));
  });

  it('repairs an over-sized .partial on 416 by truncating to the server size', async () => {
    // A partial left over-sized by an old (pre-cap) resume. On the next
    // attempt the server 416s (our Range start is past EOF) and reports the
    // true size via Content-Range; we trim the excess instead of re-downloading
    // gigabytes.
    const destPath = join(workDir, 'weights.bin');
    const partialPath = `${destPath}.partial`;
    writeFileSync(partialPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])); // 10 B, real is 6
    const { fetchImpl } = makeFetchSequence([
      async () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */6' } }),
    ]);
    const { result } = await runDownload(
      downloadWithRetry({ url: 'https://hf.test/foo', destPath, approxSizeBytes: 6, fetchImpl }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.bytesWritten).toBe(6);
    expect(statSync(partialPath).size).toBe(6);
    expect(readFileSync(partialPath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it('leaves the .partial intact on 416 when the server omits the total size', async () => {
    // No Content-Range → we can't know the true size, so keep the file and let
    // the caller's sha256 check arbitrate (don't nuke a possibly-complete
    // download).
    const destPath = join(workDir, 'weights.bin');
    const partialPath = `${destPath}.partial`;
    writeFileSync(partialPath, Buffer.from([1, 2, 3, 4]));
    const { fetchImpl } = makeFetchSequence([async () => new Response(null, { status: 416 })]);
    const { result } = await runDownload(
      downloadWithRetry({ url: 'https://hf.test/foo', destPath, approxSizeBytes: 4, fetchImpl }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.bytesWritten).toBe(4);
    expect(statSync(partialPath).size).toBe(4);
  });

  it('handles 200 OK after we sent Range (server ignored resume): restarts from byte zero', async () => {
    const destPath = join(workDir, 'weights.bin');
    const partialPath = `${destPath}.partial`;
    writeFileSync(partialPath, Buffer.from([0x99, 0x99, 0x99])); // 3 bytes from a prior attempt
    const fullPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 8 bytes
    const { fetchImpl } = makeFetchSequence([async () => bytesResponse(fullPayload, 200)]);
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 8,
        fetchImpl,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Server ignored Range and sent a full 200 body from byte 0, so the
      // whole file was written fresh — the inline digest is valid.
      expect(result.sha256).toBe(sha256(Buffer.from(fullPayload)));
    }
    expect(readFileSync(partialPath)).toEqual(Buffer.from(fullPayload));
  });

  it('honors AbortSignal: returns aborted without retry, leaves .partial intact', async () => {
    const ac = new AbortController();
    const { fetchImpl, callCount } = makeFetchSequence([
      async () => {
        // Simulate a slow response, then abort mid-way.
        ac.abort();
        const e = new Error('aborted');
        (e as { name?: string }).name = 'AbortError';
        throw e;
      },
    ]);
    const destPath = join(workDir, 'weights.bin');
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 100,
        fetchImpl,
        signal: ac.signal,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('aborted');
    // No retry happened.
    expect(callCount()).toBe(1);
  });

  it('chunk timeout triggers transient retry with a clear message', async () => {
    // Stream that yields nothing and never closes — simulates a stall.
    const stalledResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(_controller) {
          // never enqueue, never close
        },
      }),
      { status: 200, headers: { 'content-length': '100' } },
    );
    const goodResponse = bytesResponse(new Uint8Array([1, 2, 3]));
    const { fetchImpl } = makeFetchSequence([
      async () => stalledResponse,
      async () => goodResponse,
    ]);
    const destPath = join(workDir, 'weights.bin');
    const { events, result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/foo',
        destPath,
        approxSizeBytes: 3,
        fetchImpl,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('ok');
    const retry = events.find(
      (e): e is Extract<DownloadEvent, { type: 'retrying' }> => e.type === 'retrying',
    );
    expect(retry).toBeDefined();
    if (retry) expect(retry.reason).toMatch(/stall/i);
  });

  it('a file-stream write error surfaces as an error result, never an uncaught exception', async () => {
    // Regression: the WriteStream had no 'error' listener, so when the
    // download destroyed/closed it mid-flight (stalled chunk, cancel, or a
    // genuine I/O failure) the pending fs write completed against a
    // destroyed stream and emitted ERR_STREAM_DESTROYED as an *uncaught*
    // exception in the main process. Here we force a real write error by
    // pointing destPath at a missing directory (createWriteStream open
    // ENOENTs) and assert the download fails gracefully with no uncaught
    // exception / unhandled rejection escaping.
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => void uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    try {
      const { fetchImpl } = makeFetchSequence([
        async () => bytesResponse(new Uint8Array([1, 2, 3, 4])),
      ]);
      // Parent dir does not exist → the write stream can't open the file.
      const destPath = join(workDir, 'no-such-dir', 'weights.bin');
      const { result } = await runDownload(
        downloadWithRetry({
          url: 'https://hf.test/foo',
          destPath,
          approxSizeBytes: 4,
          fetchImpl,
          maxRetries: 1,
        }),
      );
      expect(result.kind).toBe('error');
      // Let any deferred fs callback (the async write-after-destroy path)
      // fire before we assert nothing escaped.
      await new Promise((r) => setTimeout(r, 20));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
    }
  });

  it('keeps resuming past maxRetries while each attempt makes real progress', async () => {
    // The first-run regression: `maxRetries` used to mean "attempts per file",
    // so a big model over a link that drops every few minutes exhausted the
    // budget and surfaced a bare "network error" — even though every attempt
    // had written megabytes to disk. The budget now counts CONSECUTIVE
    // failures that made no headway, so a transfer that is advancing keeps
    // going. Three failures here, against a budget of two.
    const step = 5 * 1024 * 1024; // > PROGRESS_REFUND_BYTES
    const failures = 3;
    const total = step * (failures + 1);
    const full = Buffer.alloc(total, 0x5a);

    // A range server that hands over `step` bytes and then drops the socket,
    // until the final attempt, which delivers the rest.
    let served = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const from = Number.parseInt(/bytes=(\d+)-/.exec(headers?.Range ?? '')?.[1] ?? '0', 10);
      const lastAttempt = served >= failures;
      served++;
      const slice = full.subarray(from, lastAttempt ? total : Math.min(from + step, total));
      // `controller.error()` discards anything still queued, so the drop has
      // to land on the *next* pull — after the consumer has taken the bytes.
      let delivered = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(new Uint8Array(slice));
            return;
          }
          if (lastAttempt) controller.close();
          else controller.error(new Error('socket hang up'));
        },
      });
      return new Response(body, {
        status: from > 0 ? 206 : 200,
        headers: {
          'content-length': String(slice.byteLength),
          ...(from > 0 ? { 'content-range': `bytes ${from}-${total - 1}/${total}` } : {}),
        },
      });
    };

    const destPath = join(workDir, 'flaky.bin');
    const { result, events } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/flaky',
        destPath,
        approxSizeBytes: total,
        fetchImpl,
        maxRetries: 2,
        chunkTimeoutMs: 2_000,
      }),
    );

    expect(result.kind).toBe('ok');
    expect(statSync(`${destPath}.partial`).size).toBe(total);
    // Compare by digest — `toEqual` on a 20 MB buffer OOMs the differ.
    expect(sha256(readFileSync(`${destPath}.partial`))).toBe(sha256(full));
    const retries = events.filter((e) => e.type === 'retrying');
    expect(retries).toHaveLength(failures);
    // Each retry resumes from where the last one stopped, and the refunded
    // budget shows the attempt counter back at 1 rather than creeping to 3/2.
    expect(retries.every((e) => e.type === 'retrying' && e.attempt === 1)).toBe(true);
    expect(retries.map((e) => (e.type === 'retrying' ? e.resumeFromBytes : 0))).toEqual([
      step,
      step * 2,
      step * 3,
    ]);
  });

  it('still gives up when repeated failures make no headway', async () => {
    // The refund must not turn a genuinely dead link into an infinite loop.
    const { fetchImpl } = makeFetchSequence(
      Array.from({ length: 3 }, () => async () => {
        throw new Error('socket hang up');
      }),
    );
    const destPath = join(workDir, 'dead.bin');
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/dead',
        destPath,
        approxSizeBytes: 4096,
        fetchImpl,
        maxRetries: 3,
        chunkTimeoutMs: 100,
      }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.attemptsMade).toBe(3);
      expect(result.error).toMatch(/gave up after 3 attempts/);
    }
  });

  it('respects backpressure across many chunks and writes the full payload', async () => {
    // Deliver several large chunks so fileStream.write() returns false and
    // the awaitDrain() backpressure path is exercised; the on-disk result
    // must still match the streamed bytes exactly.
    const chunk = new Uint8Array(256 * 1024).fill(7);
    const chunks = 8;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunks; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const total = chunk.byteLength * chunks;
    const { fetchImpl } = makeFetchSequence([
      async () => new Response(body, { status: 200, headers: { 'content-length': String(total) } }),
    ]);
    const destPath = join(workDir, 'big.bin');
    const { result } = await runDownload(
      downloadWithRetry({
        url: 'https://hf.test/big',
        destPath,
        approxSizeBytes: total,
        fetchImpl,
      }),
    );
    expect(result.kind).toBe('ok');
    expect(statSync(`${destPath}.partial`).size).toBe(total);
  });
});
