import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlamaVisionProvider } from './llama-vision.js';

/**
 * The pre-model reader has to survive its own budget.
 *
 * Wild-caught: a healthy granite-vision-4b decoding at ~26 tok/s was cut off
 * at exactly 45s having produced 953 tokens of correct transcription, all of
 * which was discarded — because `ocr` permits 1600 tokens and 1600 tokens do
 * not fit in 45 seconds at that speed. The turn then reached the chat model
 * with no description of the screenshot at all.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-vision-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
        );
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** A stream that emits `chunks`, then hangs forever without closing. */
function sseThenHang(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
        );
      }
      // Never closes — the model has gone silent mid-transcription.
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function provider(fetchImpl: typeof fetch, timeoutMs?: number): LlamaVisionProvider {
  return new LlamaVisionProvider({
    baseUrl: 'http://vision.test',
    modelsRoot: home,
    modelId: 'granite-vision-4.1-4b-q4',
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('LlamaVisionProvider — streaming and partial salvage', () => {
  it('streams a complete transcription and reports ok', async () => {
    const p = provider((async () => sse(['Score: ', '1200', '\nLives: 3'])) as typeof fetch);
    const out = await p.recognize({ bytes: PNG, mimeType: 'image/png', mode: 'ocr' });

    expect(out.status).toBe('ok');
    expect(out.ocrText).toBe('Score: 1200\nLives: 3');
    expect(out.failureReason).toBeUndefined();
  });

  it('requests a stream — a non-streaming POST cannot be salvaged', async () => {
    let body: Record<string, unknown> = {};
    const p = provider((async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return sse(['ok']);
    }) as unknown as typeof fetch);
    await p.recognize({ bytes: PNG, mimeType: 'image/png', mode: 'ocr' });
    expect(body.stream).toBe(true);
  });

  it('keeps what streamed when the ceiling cuts a still-producing model', async () => {
    // The exact 2026-08-30 shape: real output, then the budget expires.
    const p = provider(
      (async () => sseThenHang(['Browser state: ', '1 console event captured'])) as typeof fetch,
      1_500,
    );
    const out = await p.recognize({ bytes: PNG, mimeType: 'image/png', mode: 'ocr' });

    // Partial, not failed — and the text survives.
    expect(out.status).toBe('partial');
    expect(out.ocrText).toBe('Browser state: 1 console event captured');
    expect(out.failureReason).toMatch(/incomplete/);
    expect(out.failureReason).toMatch(/ceiling/);
  }, 20_000);

  it('still fails when the engine produced nothing at all', async () => {
    const p = provider((async () => sseThenHang([])) as typeof fetch, 1_500);
    const out = await p.recognize({ bytes: PNG, mimeType: 'image/png', mode: 'ocr' });

    // Nothing to salvage — this really is a failure, and the caller's
    // static-metadata floor takes over.
    expect(out.status).toBe('failed');
    expect(out.ocrText).toBeUndefined();
  }, 20_000);

  it('surfaces a transport failure as failed, not as an empty partial', async () => {
    const p = provider((async () => {
      throw new Error('connection refused');
    }) as typeof fetch);
    const out = await p.recognize({ bytes: PNG, mimeType: 'image/png', mode: 'ocr' });

    expect(out.status).toBe('failed');
    expect(out.failureReason).toMatch(/connection refused/);
  });

  it('surfaces a non-200 verbatim rather than swallowing it as a partial', async () => {
    const p = provider(
      (async () => new Response('no mmproj loaded', { status: 500 })) as typeof fetch,
    );
    const out = await p.recognize({ bytes: PNG, mimeType: 'image/png', mode: 'ocr' });

    expect(out.status).toBe('failed');
    expect(out.failureReason).toMatch(/500/);
    expect(out.failureReason).toMatch(/no mmproj loaded/);
  });
});
