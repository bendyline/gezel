/**
 * Worker-thread host for Kokoro speech synthesis, so an ONNX run never
 * blocks the daemon's event loop — or, in embedded mode, Electron's main
 * process. Protocol in kokoro-worker-host.ts.
 *
 * One request at a time, FIFO. A cancel is read out of band, between
 * utterances: a synthesis that is cancelled stops after its current sentence.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { KokoroEngine, type KokoroEngineConfig, KokoroTimeoutError } from './kokoro-engine.js';
import type { KokoroWorkerReply, KokoroWorkerRequest } from './kokoro-worker-host.js';

if (!parentPort) throw new Error('kokoro-worker must be run as a worker thread');
const port = parentPort;
const engine = new KokoroEngine(workerData as KokoroEngineConfig);
const cancelled = new Set<number>();

let queue: Promise<void> = Promise.resolve();

port.on('message', (msg: KokoroWorkerRequest) => {
  if (msg.kind === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  queue = queue.then(() => handle(msg));
});

function reply(message: KokoroWorkerReply, transfer?: ArrayBuffer[]): void {
  port.postMessage(message, transfer);
}

async function handle(msg: Exclude<KokoroWorkerRequest, { kind: 'cancel' }>): Promise<void> {
  try {
    // Time spent waiting behind another request is not a stall.
    reply({ id: msg.id, kind: 'started' });
    if (msg.kind === 'load') {
      reply({ id: msg.id, kind: 'loaded', voices: await engine.load({ deadline: msg.deadline }) });
      return;
    }
    if (msg.kind === 'unload' || cancelled.has(msg.id)) {
      if (msg.kind === 'unload') engine.unload();
      reply({ id: msg.id, kind: 'done' });
      return;
    }
    await engine.synthesize(msg.request, {
      cancelled: () => cancelled.has(msg.id),
      onUtterance: (audio) => {
        reply({ id: msg.id, kind: 'utterance', audio }, [audio.pcm.buffer as ArrayBuffer]);
      },
    });
    reply({ id: msg.id, kind: 'done' });
  } catch (err) {
    reply({
      id: msg.id,
      kind: 'error',
      error: err instanceof Error ? err.message : String(err),
      timeout: err instanceof KokoroTimeoutError,
    });
  } finally {
    cancelled.delete(msg.id);
  }
}
