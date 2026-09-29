/**
 * Runs Kokoro on its own worker thread (kokoro-worker.ts).
 *
 * Protocol (structured clone over the worker port):
 *   host → worker: { id, kind: 'load', deadline }
 *                  { id, kind: 'synthesize', request }
 *                  { id, kind: 'unload' }
 *                  { id, kind: 'cancel' }                    (out of band)
 *   worker → host: { id, kind: 'started' }                   (dequeued; the watchdog starts)
 *                  { id, kind: 'loaded', voices }
 *                  { id, kind: 'utterance', audio }          (PCM buffer transferred)
 *                  { id, kind: 'done' }
 *                  { id, kind: 'error', error, timeout }
 *
 * A worker is never terminated while it has work in flight: terminating a
 * thread whose onnxruntime run is still pending aborts the whole process
 * (`libc++abi: terminating due to uncaught exception of type Napi::Error`),
 * and in embedded mode that process is Electron. A worker that has to go —
 * shutdown, or a stalled run — is retired instead: its work is cancelled,
 * new requests get a fresh worker, and it is terminated once it reports idle.
 */

import { Worker } from 'node:worker_threads';
import { createLogger } from '@bendyline/gezel';
import { findServiceWorkerEntry } from '../../utils/service-worker-entry.js';
import {
  InProcessKokoroBackend,
  type KokoroBackend,
  type KokoroEngineConfig,
  type KokoroSynthesisRequest,
  KokoroTimeoutError,
  type KokoroUtteranceAudio,
  type KokoroVoiceTable,
  kokoroLoadStallMessage,
  kokoroStallMessage,
} from './kokoro-engine.js';

const log = createLogger('audio');

export type KokoroWorkerRequest =
  | { id: number; kind: 'load'; deadline: boolean }
  | { id: number; kind: 'synthesize'; request: KokoroSynthesisRequest }
  | { id: number; kind: 'unload' }
  | { id: number; kind: 'cancel' };

export type KokoroWorkerReply =
  | { id: number; kind: 'started' }
  | { id: number; kind: 'loaded'; voices: KokoroVoiceTable | undefined }
  | { id: number; kind: 'utterance'; audio: KokoroUtteranceAudio }
  | { id: number; kind: 'done' }
  | { id: number; kind: 'error'; error: string; timeout: boolean };

/**
 * Past the engine's own budget, so an asynchronous stall still reports the
 * engine's message and only a wedged run is given up on from here.
 */
const WATCHDOG_GRACE_MS = 5_000;

/** Crashes before synthesis moves onto the calling thread for good. */
const MAX_CRASHES = 3;

/** How long shutdown waits for a cancelled sentence to finish. One takes a few seconds at most. */
const SHUTDOWN_DRAIN_MS = 10_000;

interface Call {
  onReply(reply: KokoroWorkerReply): void;
  fail(err: Error): void;
}

type Outgoing =
  | { kind: 'load'; deadline: boolean }
  | { kind: 'synthesize'; request: KokoroSynthesisRequest }
  | { kind: 'unload' };

/** One worker thread, and the requests it has not finished. */
class Slot {
  /** Posted and not yet answered with `done`, `error`, or `loaded`. */
  readonly outstanding = new Set<number>();
  retired = false;
  private idleWaiters: Array<() => void> = [];

  constructor(readonly worker: Worker) {}

  settled(id: number): void {
    this.outstanding.delete(id);
    if (this.outstanding.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  whenIdle(): Promise<void> {
    if (this.outstanding.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function isTerminal(reply: KokoroWorkerReply): boolean {
  return reply.kind === 'done' || reply.kind === 'error' || reply.kind === 'loaded';
}

export interface KokoroWorkerBackendOptions {
  /** Where the worker entry is. Defaults to the one tsup emits beside the daemon. */
  resolveEntry?: () => string | null;
  watchdogGraceMs?: number;
  shutdownDrainMs?: number;
}

export class KokoroWorkerBackend implements KokoroBackend {
  private readonly resolveEntry: () => string | null;
  private readonly watchdogGraceMs: number;
  private readonly shutdownDrainMs: number;
  private slot: Slot | null = null;
  private fallback: InProcessKokoroBackend | null = null;
  private crashes = 0;
  private nextId = 1;
  private readonly calls = new Map<number, Call>();
  /** Which slot each live call was posted to, so retiring a slot fails exactly its calls. */
  private readonly callSlot = new Map<number, Slot>();

  constructor(
    private readonly config: KokoroEngineConfig,
    opts: KokoroWorkerBackendOptions = {},
  ) {
    this.resolveEntry =
      opts.resolveEntry ?? (() => findServiceWorkerEntry(import.meta.url, 'kokoro'));
    this.watchdogGraceMs = opts.watchdogGraceMs ?? WATCHDOG_GRACE_MS;
    this.shutdownDrainMs = opts.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS;
  }

  load(opts: { deadline: boolean }): Promise<KokoroVoiceTable | undefined> {
    const slot = this.ensureSlot();
    if (!slot) return this.inProcess().load(opts);
    return new Promise((resolve, reject) => {
      const watchdog = new Watchdog();
      const id = this.post(
        slot,
        { kind: 'load', deadline: opts.deadline },
        {
          onReply: (reply) => {
            if (reply.kind === 'started') {
              if (opts.deadline) {
                watchdog.arm(this.config.loadTimeoutMs + this.watchdogGraceMs, () =>
                  this.onStall(
                    slot,
                    id,
                    new KokoroTimeoutError(kokoroLoadStallMessage(this.config.loadTimeoutMs)),
                  ),
                );
              }
            } else if (reply.kind === 'loaded') {
              watchdog.clear();
              resolve(reply.voices);
            } else if (reply.kind === 'error') {
              watchdog.clear();
              reject(replyError(reply));
            }
          },
          fail: (err) => {
            watchdog.clear();
            reject(err);
          },
        },
      );
    });
  }

  async synthesize(
    request: KokoroSynthesisRequest,
    signal: AbortSignal | undefined,
    onUtterance: (audio: KokoroUtteranceAudio) => void | Promise<void>,
  ): Promise<void> {
    const slot = this.ensureSlot();
    if (!slot) return this.inProcess().synthesize(request, signal, onUtterance);
    if (signal?.aborted) throw abortError(signal);
    const stallMs = this.config.inferenceTimeoutMs + this.watchdogGraceMs;
    let completed = 0;
    // Utterances are handed on strictly in order, each after the last one's
    // consumer (an SSE write) has finished.
    let delivered: Promise<void> = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
      const watchdog = new Watchdog();
      const release = () => {
        watchdog.clear();
        signal?.removeEventListener('abort', onAbort);
      };
      const id = this.post(
        slot,
        { kind: 'synthesize', request },
        {
          onReply: (reply) => {
            if (reply.kind === 'started' || reply.kind === 'utterance') {
              watchdog.arm(stallMs, () =>
                this.onStall(
                  slot,
                  id,
                  new KokoroTimeoutError(
                    kokoroStallMessage(this.config.inferenceTimeoutMs, completed),
                  ),
                ),
              );
            }
            if (reply.kind === 'utterance') {
              completed += 1;
              delivered = delivered.then(() => onUtterance(reply.audio));
            } else if (reply.kind === 'done') {
              release();
              delivered.then(resolve, reject);
            } else if (reply.kind === 'error') {
              release();
              reject(replyError(reply));
            }
          },
          fail: (err) => {
            release();
            reject(err);
          },
        },
      );
      // The caller stops waiting now; the worker stops after its current
      // sentence, and anything it sends for this id after that is dropped.
      const onAbort = () => {
        this.forget(id);
        slot.worker.postMessage({ id, kind: 'cancel' } satisfies KokoroWorkerRequest);
        release();
        reject(abortError(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async unload(): Promise<void> {
    if (this.fallback) return this.fallback.unload();
    const slot = this.slot;
    if (!slot) return;
    await new Promise<void>((resolve) => {
      this.post(
        slot,
        { kind: 'unload' },
        {
          onReply: (reply) => {
            if (isTerminal(reply)) resolve();
          },
          fail: () => resolve(),
        },
      );
    });
  }

  async shutdown(): Promise<void> {
    await this.fallback?.shutdown();
    const slot = this.slot;
    if (!slot) return;
    this.retire(slot, new Error('The Kokoro speech engine is shutting down.'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      slot.whenIdle().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.shutdownDrainMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) {
      log.warn('[kokoro] a synthesis was still running at shutdown; leaving its worker to exit');
    }
  }

  private inProcess(): InProcessKokoroBackend {
    this.fallback ??= new InProcessKokoroBackend(this.config);
    return this.fallback;
  }

  private post(slot: Slot, message: Outgoing, call: Call): number {
    const id = this.nextId++;
    this.calls.set(id, call);
    this.callSlot.set(id, slot);
    slot.outstanding.add(id);
    slot.worker.postMessage({ id, ...message } satisfies KokoroWorkerRequest);
    return id;
  }

  private forget(id: number): void {
    this.calls.delete(id);
    this.callSlot.delete(id);
  }

  private ensureSlot(): Slot | null {
    if (this.fallback) return null;
    if (this.slot) return this.slot;
    const entry = this.resolveEntry();
    if (!entry) {
      log.warn('[kokoro] worker entry is missing; speech synthesis will block the event loop');
      return null;
    }
    let worker: Worker;
    try {
      worker = new Worker(entry, { workerData: this.config });
    } catch (err) {
      log.warn(
        `[kokoro] worker failed to start (${err instanceof Error ? err.message : String(err)}); speech synthesis will block the event loop`,
      );
      return null;
    }
    const slot = new Slot(worker);
    worker.on('message', (reply: KokoroWorkerReply) => this.onMessage(slot, reply));
    worker.on('error', (err) =>
      this.onWorkerDown(slot, err instanceof Error ? err.message : String(err)),
    );
    worker.on('exit', (code) => this.onWorkerDown(slot, `worker exited with code ${code}`));
    worker.unref();
    this.slot = slot;
    return slot;
  }

  private onMessage(slot: Slot, reply: KokoroWorkerReply): void {
    const call = this.calls.get(reply.id);
    if (isTerminal(reply)) this.forget(reply.id);
    call?.onReply(reply);
    if (!isTerminal(reply)) return;
    slot.settled(reply.id);
    if (slot.retired && slot.outstanding.size === 0) void slot.worker.terminate().catch(() => {});
  }

  /**
   * Stop sending this worker work and fail its callers. It is terminated
   * once its last in-flight request settles — never before.
   */
  private retire(slot: Slot, err: Error): void {
    if (this.slot === slot) this.slot = null;
    if (slot.retired) return;
    slot.retired = true;
    for (const [id, owner] of [...this.callSlot]) {
      if (owner !== slot) continue;
      const call = this.calls.get(id);
      this.forget(id);
      slot.worker.postMessage({ id, kind: 'cancel' } satisfies KokoroWorkerRequest);
      call?.fail(err);
    }
    if (slot.outstanding.size === 0) void slot.worker.terminate().catch(() => {});
  }

  /** An exit nobody asked for. A retired worker's exit is the one we asked for. */
  private onWorkerDown(slot: Slot, reason: string): void {
    if (slot.retired) return;
    slot.outstanding.clear();
    this.retire(slot, new Error(`The Kokoro speech engine stopped (${reason}). Retry.`));
    this.crashes += 1;
    log.warn(`[kokoro] ${reason} (crash ${this.crashes}/${MAX_CRASHES})`);
    if (this.crashes >= MAX_CRASHES) {
      log.warn('[kokoro] worker keeps crashing; speech synthesis moves onto the event loop');
      this.inProcess();
    }
  }

  /**
   * A run that stopped producing audio. It cannot be interrupted, so the
   * caller is released, the other callers move to a fresh worker on retry,
   * and this one is left to finish on its own before it is terminated.
   */
  private onStall(slot: Slot, id: number, err: KokoroTimeoutError): void {
    log.warn(`[kokoro] ${err.message}`);
    const call = this.calls.get(id);
    this.forget(id);
    slot.worker.postMessage({ id, kind: 'cancel' } satisfies KokoroWorkerRequest);
    call?.fail(err);
    this.retire(slot, new Error('The Kokoro speech engine was restarted after a stall. Retry.'));
  }
}

function replyError(reply: { error: string; timeout: boolean }): Error {
  return reply.timeout ? new KokoroTimeoutError(reply.error) : new Error(reply.error);
}

class Watchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;

  arm(ms: number, onExpire: () => void): void {
    this.clear();
    this.timer = setTimeout(onExpire, ms);
    this.timer.unref?.();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
