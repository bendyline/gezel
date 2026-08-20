/**
 * Public embedding API. Generates 384-dimensional vectors from text using a
 * local transformers.js model (all-MiniLM-L6-v2) — runs entirely on-device, no
 * API keys. The model downloads on first use (~23 MB) and is cached in the OS
 * cache directory.
 *
 * Two robustness properties live here, both added after an out-of-memory in the
 * model crashed the whole Electron app (a many-chunk file made ONNX attempt a
 * multi-gigabyte allocation in `BFCArena::Extend`, which trapped — SIGTRAP — on
 * the main thread):
 *
 *   1. Inference runs in BOUNDED sub-batches (see `embed-core`) so no single
 *      ONNX `Run` can balloon, regardless of how many texts a caller passes.
 *   2. Inference runs in a WORKER THREAD (`embed-worker`), keeping the heavy
 *      synchronous native call off the Electron main/UI thread. When the worker
 *      can't be created — under vitest there's no built worker file, and a raw
 *      `new Worker('*.ts')` wouldn't load through vitest's transform — we
 *      degrade to in-process inference, which is still bounded by (1).
 */

import { Worker } from 'node:worker_threads';
import { createLogger } from '@bendyline/gezel';
import { findServiceWorkerEntry } from '../utils/service-worker-entry.js';
import { PipelineLoadError, queryInstruction, runEmbed } from './embed-core.js';

const log = createLogger('memory');

/**
 * Marker class so callers can tell "the indexer is off on purpose" apart from a
 * new failure worth logging. The extractor uses this to stay silent after the
 * first failure.
 */
export class EmbeddingsDisabledError extends Error {
  readonly code: string = 'EMBEDDINGS_DISABLED';
  readonly retryable: boolean = false;
  constructor(reason: string) {
    super(`memory embeddings disabled: ${reason}`);
    this.name = 'EmbeddingsDisabledError';
  }
}

/** A recoverable model-load outage currently held behind a retry cooldown. */
export class EmbeddingsUnavailableError extends EmbeddingsDisabledError {
  override readonly code = 'EMBEDDINGS_UNAVAILABLE';
  override readonly retryable = true;
  constructor(reason: string) {
    super(reason);
    this.name = 'EmbeddingsUnavailableError';
    this.message = `memory embeddings temporarily unavailable: ${reason}`;
  }
}

// Once the model fails to load, we permanently flip into a disabled state.
// Every subsequent call throws the short marker error instead of re-attempting
// the import and re-printing the full model-load error on every chat turn.
let disabledReason: string | null = null;
let unavailableReason: string | null = null;
let unavailableUntil = 0;

export type EmbeddingPipelineStatus = 'cold' | 'warming' | 'ready' | 'disabled' | 'unavailable';

// Interactive callers need to know whether a query is about to pay the model's
// one-time load cost. Keep this deliberately coarse: it is process-local
// readiness, not durable health state. A cold/warming caller can fail open and
// let the already-started load finish in the background.
let pipelineStatus: 'cold' | 'warming' | 'ready' = 'cold';

/** Avoid hammering the model registry when a first-use download is offline. */
const EMBEDDING_RETRY_COOLDOWN_MS = 60_000;

const ENV_DISABLED_REASON = 'disabled by GEZEL_DISABLE_EMBEDDINGS';

function disabledByEnv(): boolean {
  const raw = process.env.GEZEL_DISABLE_EMBEDDINGS;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

export function embeddingsDisabledReason(): string | null {
  return disabledByEnv() ? ENV_DISABLED_REASON : (disabledReason ?? currentUnavailableReason());
}

export function embeddingPipelineStatus(): EmbeddingPipelineStatus {
  if (disabledByEnv() || disabledReason) return 'disabled';
  if (currentUnavailableReason()) return 'unavailable';
  return pipelineStatus;
}

// ── worker plumbing ───────────────────────────────────────────────────────

interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (err: unknown) => void;
}

interface WorkerReply {
  id: number;
  vectors?: number[][];
  error?: string;
  fatal?: boolean;
  retryable?: boolean;
  optionalPeerMissing?: boolean;
}

let worker: Worker | null = null;
// Flips false once we give up on the worker path (no built file, spawn error,
// or a crash loop) and fall back to in-process inference for good.
let workerUsable = true;
let crashCount = 0;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * Locate the built worker from either service bundle shape. Under vitest there
 * is no dist build, so let the caller fall back to in-process.
 */
function workerEntry(): string | null {
  if (process.env.VITEST) return null;
  return findServiceWorkerEntry(import.meta.url, 'embeddings');
}

function ensureWorker(): Worker | null {
  if (!workerUsable) return null;
  if (worker) return worker;
  const entry = workerEntry();
  if (!entry) {
    workerUsable = false;
    return null;
  }
  try {
    const w = new Worker(entry);
    w.on('message', onMessage);
    w.on('error', (err) => onWorkerDown(err instanceof Error ? err.message : String(err)));
    w.on('exit', (code) => {
      if (code !== 0) onWorkerDown(`worker exited with code ${code}`);
    });
    // Background, best-effort work — never hold the event loop open or block
    // process shutdown waiting on the embedder.
    w.unref();
    worker = w;
    return w;
  } catch (err) {
    log.warn(`[memory] embed worker failed to start; using in-process inference: ${describe(err)}`);
    workerUsable = false;
    return null;
  }
}

function onMessage(msg: WorkerReply): void {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) {
    if (msg.fatal) markDisabled(msg.error, msg.optionalPeerMissing ?? false);
    if (msg.retryable) {
      markTemporarilyUnavailable(msg.error);
      p.reject(new EmbeddingsUnavailableError(unavailableReason ?? msg.error));
    } else {
      p.reject(new Error(msg.error));
    }
    return;
  }
  p.resolve(msg.vectors ?? []);
}

function onWorkerDown(reason: string): void {
  const dead = worker;
  worker = null;
  if (dead) void dead.terminate().catch(() => {});
  // Reject everything still in flight — those requests died with the worker.
  const inflight = Array.from(pending.values());
  pending.clear();
  for (const p of inflight) p.reject(new Error(`embed worker stopped: ${reason}`));
  crashCount++;
  // A crash loop (model genuinely broken on this box) → stop spawning workers
  // and degrade to in-process. We don't disable outright: in-process is still
  // bounded by the sub-batching, so search keeps working.
  if (crashCount >= 3) {
    workerUsable = false;
    log.warn(
      `[memory] embed worker crashed ${crashCount}×; falling back to in-process inference. Last: ${reason}`,
    );
  }
}

function sendToWorker(w: Worker, texts: string[]): Promise<number[][]> {
  const id = nextId++;
  return new Promise<number[][]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, texts });
  });
}

async function embedInProcess(texts: string[]): Promise<number[][]> {
  try {
    return await runEmbed(texts);
  } catch (err) {
    if (err instanceof PipelineLoadError) {
      if (err.retryable) {
        markTemporarilyUnavailable(err.message);
        throw new EmbeddingsUnavailableError(unavailableReason ?? err.message);
      }
      markDisabled(err.message, err.optionalPeerMissing);
      throw new EmbeddingsDisabledError(disabledReason ?? err.message);
    }
    throw err;
  }
}

function currentUnavailableReason(): string | null {
  if (!unavailableReason) return null;
  if (Date.now() < unavailableUntil) return unavailableReason;
  unavailableReason = null;
  unavailableUntil = 0;
  return null;
}

function markTemporarilyUnavailable(message: string): void {
  unavailableReason = firstLine(message);
  unavailableUntil = Date.now() + EMBEDDING_RETRY_COOLDOWN_MS;
  log.warn(
    `[memory] embedding model load failed; semantic search will retry after ${Math.ceil(EMBEDDING_RETRY_COOLDOWN_MS / 1_000)}s.`,
  );
  log.warn('[memory] underlying transient error:', message);
}

function markDisabled(message: string, optionalPeerMissing = false): void {
  if (disabledReason) return;
  disabledReason = firstLine(message);
  if (optionalPeerMissing) {
    // Not a fault: the base npm install deliberately omits the ML peers and the
    // README documents that as supported. Reporting it as an error made every
    // lean install look damaged on its first chat, so state it once and move on.
    log.info(`[memory] vector memory is off — ${disabledReason}`);
    return;
  }
  // Loud once with the underlying model/runtime error. Subsequent callers get
  // the short `EmbeddingsDisabledError`.
  log.error(
    '[memory] failed to load embedding pipeline; vector memory is now disabled for this process.',
  );
  log.error('[memory] underlying error:', message);
}

/** Embed `texts`, preferring the worker and degrading to in-process. */
async function embedMany(texts: string[]): Promise<number[][]> {
  if (disabledByEnv()) throw new EmbeddingsDisabledError(ENV_DISABLED_REASON);
  if (disabledReason) throw new EmbeddingsDisabledError(disabledReason);
  const temporaryReason = currentUnavailableReason();
  if (temporaryReason) throw new EmbeddingsUnavailableError(temporaryReason);
  if (pipelineStatus === 'cold') pipelineStatus = 'warming';
  try {
    const w = ensureWorker();
    if (w) {
      try {
        const vectors = await sendToWorker(w, texts);
        pipelineStatus = 'ready';
        return vectors;
      } catch (err) {
        // A retryable pipeline-load failure already has a cooldown and should not
        // immediately repeat the same download in-process.
        if (err instanceof EmbeddingsUnavailableError) throw err;
        // The model is unloadable — the worker tagged it fatal and we've already
        // set disabledReason. Surface the canonical error.
        if (disabledReason) throw new EmbeddingsDisabledError(disabledReason);
        // Transient worker failure (it crashed mid-request and we rejected the
        // in-flight call). Fall through so this call still completes in-process.
        log.warn(`[memory] embed via worker failed; retrying in-process: ${describe(err)}`);
      }
    }
    const vectors = await embedInProcess(texts);
    pipelineStatus = 'ready';
    return vectors;
  } catch (err) {
    if (!disabledReason && !currentUnavailableReason()) pipelineStatus = 'cold';
    throw err;
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return idx < 0 ? s : s.slice(0, idx);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedMany([text]);
  return vector ?? [];
}

/**
 * Embed a SEARCH QUERY. Same pipeline as `embed`, but prepends the model's
 * query-side retrieval instruction when it has one (bge-*); for symmetric
 * models this is identical to `embed`. Indexed passages must go through
 * `embed`/`embedBatch` (no prefix) — the asymmetry is the whole point. Every
 * query-side call site (content search, memory recall, unified search) routes
 * here so the prefix stays in exactly one place.
 */
export async function embedQuery(text: string): Promise<number[]> {
  return embed(queryInstruction() + text);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return embedMany(texts);
}

/**
 * Load the embedding pipeline ahead of the first real caller.
 *
 * The model loads lazily on first use, and that load was measured at ~41s on
 * a fresh install. Whoever arrives first pays it — and the unified search sits
 * in the titlebar, so it was routinely the user's first keystroke, with the
 * search box appearing to ignore them. The first chat turn loads the same
 * pipeline for memory extraction anyway, so warming moves the cost off an
 * interactive path rather than adding one.
 *
 * Never throws: embeddings being disabled or unavailable is a supported
 * configuration, and the callers already degrade to keyword-only search.
 */
export async function warmEmbeddings(): Promise<boolean> {
  if (disabledByEnv() || disabledReason) return false;
  if (pipelineStatus === 'ready') return true;
  try {
    await embed('warm');
    return true;
  } catch {
    return false;
  }
}
