import type { NativeEngineResolveEvent } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import {
  GezelApiError,
  GezelClient,
  type LlamaCppInstallEvent,
  type MlxInstallEvent,
} from './client.js';

/**
 * Build a fetch that streams the given SSE frames then closes the body.
 * Each frame is JSON-encoded into a `data: …\n\n` event. When
 * `terminate` is false the stream simply ends after the frames — the
 * "interrupted install" case the install methods must turn into an
 * error instead of a silent success.
 */
function streamingFetch(frames: object[], onRequest?: (url: string) => void): typeof fetch {
  return (async (input: string | URL | Request) => {
    onRequest?.(String(input));
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) {
          c.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
        }
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

function silentFetch(): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch): GezelClient {
  return new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });
}

describe('installMlxModel terminal-frame handling', () => {
  it('throws when the stream closes without a done/error frame', async () => {
    // A progress frame, then the socket just closes — exactly the
    // failure mode that used to revert the catalog card to "Download"
    // with no explanation.
    const client = makeClient(
      streamingFetch([
        {
          type: 'progress',
          fileIndex: 0,
          fileCount: 3,
          file: 'model-00001.safetensors',
          bytesWritten: 1024,
          totalBytes: 4096,
          bytesWrittenAll: 1024,
          totalBytesAll: 12288,
        },
      ]),
    );
    const events: MlxInstallEvent[] = [];
    await expect(
      client.installMlxModel('gemma4-12b-q8', (ev) => events.push(ev)),
    ).rejects.toBeInstanceOf(GezelApiError);
    // The progress event was still delivered before the throw.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('progress');
  });

  it('resolves when the stream ends with a done frame', async () => {
    const client = makeClient(
      streamingFetch([{ type: 'extracting-metadata' }, { type: 'done', id: 'gemma4-12b-q8' }]),
    );
    const events: MlxInstallEvent[] = [];
    await expect(
      client.installMlxModel('gemma4-12b-q8', (ev) => events.push(ev)),
    ).resolves.toBeUndefined();
    expect(events.at(-1)?.type).toBe('done');
  });

  it('resolves (no throw) when the stream ends with an error frame', async () => {
    // An `error` frame is a *terminal* outcome the UI handles — the
    // client must not additionally throw "interrupted".
    const client = makeClient(streamingFetch([{ type: 'error', error: 'sha256 mismatch' }]));
    const events: MlxInstallEvent[] = [];
    await expect(
      client.installMlxModel('gemma4-12b-q8', (ev) => events.push(ev)),
    ).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'sha256 mismatch' });
  });
});

describe('installLlamaCppModel companion handling', () => {
  it('accepts image-recognition companion progress before the primary done frame', async () => {
    const client = makeClient(
      streamingFetch([
        { type: 'extracting-metadata' },
        {
          type: 'companion',
          kind: 'image-recognition',
          id: 'minicpm-v',
          name: 'MiniCPM-V',
          bytesWritten: 1024,
          totalBytes: 4096,
        },
        { type: 'done', id: 'qwen3.5-2b-q4' },
      ]),
    );
    const events: LlamaCppInstallEvent[] = [];

    await expect(
      client.installLlamaCppModel('qwen3.5-2b-q4', (event) => events.push(event)),
    ).resolves.toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(['extracting-metadata', 'companion', 'done']);
  });

  it('can suppress the implicit image reader for callers with an explicit bundle plan', async () => {
    let requestedUrl = '';
    const client = makeClient(
      streamingFetch([{ type: 'done', id: 'qwen3.5-2b-q4' }], (url) => {
        requestedUrl = url;
      }),
    );

    await client.installLlamaCppModel('qwen3.5-2b-q4', () => {}, undefined, {
      skipSha: true,
      skipCompanion: true,
    });

    expect(requestedUrl).toBe(
      'http://test/api/llama-cpp/models/qwen3.5-2b-q4/install?skipSha=1&skipCompanion=1',
    );
  });
});

describe('ensureNativeEngine terminal-frame handling', () => {
  it('streams verified native install progress to completion', async () => {
    const client = makeClient(
      streamingFetch([
        { type: 'progress', bytesWritten: 1024, totalBytes: 4096 },
        { type: 'verifying', what: 'sha256' },
        { type: 'done', binPath: '/engines/llama-server', cached: false },
      ]),
    );
    const events: NativeEngineResolveEvent[] = [];

    await expect(
      client.ensureNativeEngine('llama-server', (event) => events.push(event), 'cuda'),
    ).resolves.toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(['progress', 'verifying', 'done']);
  });
});

describe('model download inactivity handling', () => {
  it('waits 40 quiet minutes and reports a friendly error', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient(silentFetch());
      let settled = false;
      const pull = client.pullImageModel('flux-test', () => {});
      void pull.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      // Let fetch resolve and the inactivity timer start.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await expect(pull).rejects.toMatchObject({
        message: 'Download stopped: server has gone quiet.',
        details: { cause: 'SseStreamStaleError' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
