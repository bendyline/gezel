import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KokoroEngineConfig, KokoroUtteranceAudio } from './kokoro-engine.js';
import { KokoroTimeoutError } from './kokoro-engine.js';
import { KokoroWorkerBackend } from './kokoro-worker-host.js';

/**
 * A worker that speaks the kokoro-worker protocol without a model, so the
 * host's lifecycle — ordering, cancellation, stalls, crashes, shutdown — can
 * be driven exactly. Behaviour comes from `workerData.fake`. A `once` marker
 * file makes a misbehaviour happen only in the first worker, so a test can
 * see the replacement behave.
 */
const FAKE_WORKER = `
import { existsSync, writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
const fake = workerData.fake;
const cancelled = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve();
const first = () => {
  if (!fake.once || existsSync(fake.once)) return false;
  writeFileSync(fake.once, 'x');
  return true;
};
parentPort.on('message', (msg) => {
  if (msg.kind === 'cancel') { cancelled.add(msg.id); return; }
  queue = queue.then(() => handle(msg));
});
async function handle(msg) {
  parentPort.postMessage({ id: msg.id, kind: 'started' });
  if (msg.kind === 'load') {
    parentPort.postMessage({ id: msg.id, kind: 'loaded', voices: { af_heart: { name: 'Heart' } } });
    return;
  }
  if (msg.kind === 'unload') { parentPort.postMessage({ id: msg.id, kind: 'done' }); return; }
  if (fake.mode === 'crash' && first()) process.exit(3);
  const stall = fake.mode === 'stall' && first();
  for (let i = 0; i < fake.utterances; i++) {
    if (cancelled.has(msg.id)) break;
    await sleep(stall ? fake.stallMs : fake.perUtteranceMs);
    const pcm = new Uint8Array([i, 0, i, 0]);
    parentPort.postMessage(
      { id: msg.id, kind: 'utterance', audio: { pcm, sampleRate: 24000, characters: 5 } },
      [pcm.buffer],
    );
  }
  parentPort.postMessage({ id: msg.id, kind: 'done' });
}
`;

interface Fake {
  mode?: 'normal' | 'stall' | 'crash';
  utterances?: number;
  perUtteranceMs?: number;
  stallMs?: number;
  once?: string;
}

describe('KokoroWorkerBackend', () => {
  let dir: string;
  let entry: string;
  const backends: KokoroWorkerBackend[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-kokoro-host-'));
    entry = join(dir, 'fake-worker.mjs');
    await writeFile(entry, FAKE_WORKER, 'utf8');
  });

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((b) => b.shutdown()));
    await rm(dir, { recursive: true, force: true });
  });

  function backend(fake: Fake = {}, opts: { inferenceTimeoutMs?: number } = {}) {
    const config = {
      cacheDir: dir,
      dtype: 'q8',
      inferenceTimeoutMs: opts.inferenceTimeoutMs ?? 5_000,
      loadTimeoutMs: 5_000,
      fake: { mode: 'normal', utterances: 3, perUtteranceMs: 5, stallMs: 0, ...fake },
    } as KokoroEngineConfig;
    const created = new KokoroWorkerBackend(config, {
      resolveEntry: () => entry,
      watchdogGraceMs: 0,
      shutdownDrainMs: 2_000,
    });
    backends.push(created);
    return created;
  }

  const request = { text: 'One. Two. Three.', voice: 'af_heart', speed: 1 };

  it('loads on the worker and hands back its voices', async () => {
    await expect(backend().load({ deadline: true })).resolves.toEqual({
      af_heart: { name: 'Heart' },
    });
  });

  it('delivers utterances in order and resolves after the last', async () => {
    const seen: number[] = [];
    await backend().synthesize(request, undefined, async (audio: KokoroUtteranceAudio) => {
      // A slow consumer must not reorder what follows it.
      await new Promise((r) => setTimeout(r, 5));
      seen.push(audio.pcm[0]!);
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('rejects an aborted synthesis at once, without waiting for the sentence', async () => {
    const b = backend({ utterances: 5, perUtteranceMs: 400 });
    const controller = new AbortController();
    const started = Date.now();
    const running = b.synthesize(request, controller.signal, () => {});
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('gives up on a stalled run and serves the next request from a fresh worker', async () => {
    const b = backend(
      { mode: 'stall', stallMs: 600, once: join(dir, 'stalled') },
      { inferenceTimeoutMs: 100 },
    );
    await expect(b.synthesize(request, undefined, () => {})).rejects.toBeInstanceOf(
      KokoroTimeoutError,
    );
    const seen: number[] = [];
    await b.synthesize(request, undefined, (audio) => {
      seen.push(audio.pcm[0]!);
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('reports a crashed worker to its caller and replaces it', async () => {
    const b = backend({ mode: 'crash', once: join(dir, 'crashed') });
    await expect(b.synthesize(request, undefined, () => {})).rejects.toThrow(/stopped/);
    expect(existsSync(join(dir, 'crashed'))).toBe(true);
    const seen: number[] = [];
    await b.synthesize(request, undefined, (audio) => {
      seen.push(audio.pcm[0]!);
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('lets an in-flight sentence finish before shutting the worker down', async () => {
    // Terminating a worker mid-run aborts the process for a real onnxruntime
    // run, so shutdown must outlast the sentence in progress.
    const b = backend({ utterances: 4, perUtteranceMs: 300 });
    const running = b.synthesize(request, undefined, () => {});
    running.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await b.shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await expect(running).rejects.toThrow(/shutting down/);
  });
});
