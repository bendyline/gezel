/**
 * Public image-embedding API — the lane-A entry point the enrichment tier
 * calls. Structural copy of embeddings.ts with independent state: its own
 * worker ('image-embeddings' entry), its own crash counter, its own sticky
 * disabledReason and retry cooldown — so an image-model failure reads as
 * "image similarity is off", never as a text-search outage (and vice versa).
 *
 * Failure surface, by blast radius:
 *   - per-image: returned as data in the outcome list (terminal skip or
 *     retryable error) — the gate in ContentIndex.embedImages consumes them.
 *   - pipeline: the model itself won't load → ONE loud log, then the sticky
 *     short marker error. optionalPeerMissing (no @huggingface/transformers)
 *     is a supported npm configuration and logs quietly at info.
 */

import { Worker } from 'node:worker_threads';
import { createLogger } from '@bendyline/gezel';
import { findServiceWorkerEntry } from '../utils/service-worker-entry.js';
import { PipelineLoadError } from './embed-core.js';
import { type FaceDetectOutcome, type FaceModelPaths, runFaceDetect } from './face-embed-core.js';
import { type ImageEmbedJob, type ImageEmbedOutcome, runImageEmbed } from './image-embed-core.js';

export type { ImageEmbedJob, ImageEmbedOutcome } from './image-embed-core.js';
export type { DetectedFaceResult, FaceDetectOutcome, FaceModelPaths } from './face-embed-core.js';

const log = createLogger('memory');

export class ImageEmbeddingsDisabledError extends Error {
  readonly code: string = 'IMAGE_EMBEDDINGS_DISABLED';
  readonly retryable: boolean = false;
  constructor(reason: string) {
    super(`image embeddings disabled: ${reason}`);
    this.name = 'ImageEmbeddingsDisabledError';
  }
}

/** A recoverable model-load outage currently held behind a retry cooldown. */
export class ImageEmbeddingsUnavailableError extends ImageEmbeddingsDisabledError {
  override readonly code = 'IMAGE_EMBEDDINGS_UNAVAILABLE';
  override readonly retryable = true;
  constructor(reason: string) {
    super(reason);
    this.name = 'ImageEmbeddingsUnavailableError';
    this.message = `image embeddings temporarily unavailable: ${reason}`;
  }
}

let disabledReason: string | null = null;
let unavailableReason: string | null = null;
let unavailableUntil = 0;

// Face-lane failure state is deliberately SEPARATE: the shared worker runs
// both models, but a face-model failure must read as "face recognition is
// off", never take lane A (visual similarity) down with it.
let faceDisabledReason: string | null = null;
let faceUnavailableReason: string | null = null;
let faceUnavailableUntil = 0;

const RETRY_COOLDOWN_MS = 60_000;
const ENV_DISABLED_REASON = 'disabled by GEZEL_DISABLE_IMAGE_EMBEDDINGS';

function disabledByEnv(): boolean {
  const raw = process.env.GEZEL_DISABLE_IMAGE_EMBEDDINGS;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

export function imageEmbeddingsDisabledReason(): string | null {
  return disabledByEnv() ? ENV_DISABLED_REASON : (disabledReason ?? currentUnavailableReason());
}

/**
 * Cheap per-batch gate for the enrichment tier: flags only, no model load.
 * The first real embed classifies a missing peer / unloadable model and makes
 * this report it from then on.
 */
export function imageEmbedAvailability(): { ok: boolean; reason?: string } {
  const reason = imageEmbeddingsDisabledReason();
  return reason ? { ok: false, reason } : { ok: true };
}

/** Face-lane availability for callers (config opt-in is checked elsewhere). */
export function faceEmbedAvailability(): { ok: boolean; reason?: string } {
  const reason = faceDisabledReason ?? currentFaceUnavailableReason();
  return reason ? { ok: false, reason } : { ok: true };
}

// ── worker plumbing (mirror of embeddings.ts) ─────────────────────────────

type AnyOutcomes = ImageEmbedOutcome[] | FaceDetectOutcome[];

interface Pending {
  kind: 'clip' | 'faces';
  resolve: (results: AnyOutcomes) => void;
  reject: (err: unknown) => void;
}

interface WorkerReply {
  id: number;
  results?: AnyOutcomes;
  error?: string;
  fatal?: boolean;
  retryable?: boolean;
  optionalPeerMissing?: boolean;
}

let worker: Worker | null = null;
let workerUsable = true;
let crashCount = 0;
let nextId = 1;
const pending = new Map<number, Pending>();

function workerEntry(): string | null {
  if (process.env.VITEST) return null;
  return findServiceWorkerEntry(import.meta.url, 'image-embeddings');
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
    w.unref();
    worker = w;
    return w;
  } catch (err) {
    log.warn(
      `[memory] image-embed worker failed to start; using in-process inference: ${describe(err)}`,
    );
    workerUsable = false;
    return null;
  }
}

function onMessage(msg: WorkerReply): void {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) {
    if (p.kind === 'faces') {
      // Attribute the failure to the face lane only.
      if (msg.fatal) markFaceDisabled(msg.error, msg.optionalPeerMissing ?? false);
      if (msg.retryable) {
        markFaceTemporarilyUnavailable(msg.error);
        p.reject(new ImageEmbeddingsUnavailableError(faceUnavailableReason ?? msg.error));
      } else {
        p.reject(new Error(msg.error));
      }
      return;
    }
    if (msg.fatal) markDisabled(msg.error, msg.optionalPeerMissing ?? false);
    if (msg.retryable) {
      markTemporarilyUnavailable(msg.error);
      p.reject(new ImageEmbeddingsUnavailableError(unavailableReason ?? msg.error));
    } else {
      p.reject(new Error(msg.error));
    }
    return;
  }
  p.resolve(msg.results ?? []);
}

function onWorkerDown(reason: string): void {
  const dead = worker;
  worker = null;
  if (dead) void dead.terminate().catch(() => {});
  const inflight = Array.from(pending.values());
  pending.clear();
  for (const p of inflight) p.reject(new Error(`image-embed worker stopped: ${reason}`));
  crashCount++;
  if (crashCount >= 3) {
    workerUsable = false;
    log.warn(
      `[memory] image-embed worker crashed ${crashCount}×; falling back to in-process inference. Last: ${reason}`,
    );
  }
}

function sendToWorker(w: Worker, images: ImageEmbedJob[]): Promise<ImageEmbedOutcome[]> {
  const id = nextId++;
  return new Promise<AnyOutcomes>((resolve, reject) => {
    pending.set(id, { kind: 'clip', resolve, reject });
    w.postMessage({ id, kind: 'clip', images });
  }) as Promise<ImageEmbedOutcome[]>;
}

function sendFacesToWorker(
  w: Worker,
  images: ImageEmbedJob[],
  models: FaceModelPaths,
): Promise<FaceDetectOutcome[]> {
  const id = nextId++;
  return new Promise<AnyOutcomes>((resolve, reject) => {
    pending.set(id, { kind: 'faces', resolve, reject });
    w.postMessage({ id, kind: 'faces', images, models });
  }) as Promise<FaceDetectOutcome[]>;
}

async function embedInProcess(images: ImageEmbedJob[]): Promise<ImageEmbedOutcome[]> {
  try {
    return await runImageEmbed(images);
  } catch (err) {
    if (err instanceof PipelineLoadError) {
      if (err.retryable) {
        markTemporarilyUnavailable(err.message);
        throw new ImageEmbeddingsUnavailableError(unavailableReason ?? err.message);
      }
      markDisabled(err.message, err.optionalPeerMissing);
      throw new ImageEmbeddingsDisabledError(disabledReason ?? err.message);
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
  unavailableUntil = Date.now() + RETRY_COOLDOWN_MS;
  log.warn(
    `[memory] image-embed model load failed; visual similarity will retry after ${Math.ceil(RETRY_COOLDOWN_MS / 1_000)}s.`,
  );
  log.warn('[memory] underlying transient error:', message);
}

function markDisabled(message: string, optionalPeerMissing = false): void {
  if (disabledReason) return;
  disabledReason = firstLine(message);
  if (optionalPeerMissing) {
    log.info(`[memory] visual image similarity is off — ${disabledReason}`);
    return;
  }
  log.error(
    '[memory] failed to load the image-embed model; visual similarity is now disabled for this process.',
  );
  log.error('[memory] underlying error:', message);
}

function currentFaceUnavailableReason(): string | null {
  if (!faceUnavailableReason) return null;
  if (Date.now() < faceUnavailableUntil) return faceUnavailableReason;
  faceUnavailableReason = null;
  faceUnavailableUntil = 0;
  return null;
}

function markFaceTemporarilyUnavailable(message: string): void {
  faceUnavailableReason = firstLine(message);
  faceUnavailableUntil = Date.now() + RETRY_COOLDOWN_MS;
  log.warn(
    `[memory] face model load failed; face recognition will retry after ${Math.ceil(RETRY_COOLDOWN_MS / 1_000)}s.`,
  );
  log.warn('[memory] underlying transient error:', message);
}

function markFaceDisabled(message: string, optionalPeerMissing = false): void {
  if (faceDisabledReason) return;
  faceDisabledReason = firstLine(message);
  if (optionalPeerMissing) {
    log.info(`[memory] face recognition is off — ${faceDisabledReason}`);
    return;
  }
  log.error(
    '[memory] failed to load a face model; face recognition is now disabled for this process (visual similarity is unaffected).',
  );
  log.error('[memory] underlying error:', message);
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return idx < 0 ? s : s.slice(0, idx);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Embed a batch of image files (absolute path + content hash) into per-image
 * outcomes, preferring the worker and degrading to in-process.
 */
export async function embedImageFiles(images: ImageEmbedJob[]): Promise<ImageEmbedOutcome[]> {
  if (images.length === 0) return [];
  if (disabledByEnv()) throw new ImageEmbeddingsDisabledError(ENV_DISABLED_REASON);
  if (disabledReason) throw new ImageEmbeddingsDisabledError(disabledReason);
  const temporaryReason = currentUnavailableReason();
  if (temporaryReason) throw new ImageEmbeddingsUnavailableError(temporaryReason);
  const w = ensureWorker();
  if (w) {
    try {
      return await sendToWorker(w, images);
    } catch (err) {
      if (err instanceof ImageEmbeddingsUnavailableError) throw err;
      if (disabledReason) throw new ImageEmbeddingsDisabledError(disabledReason);
      log.warn(`[memory] image embed via worker failed; retrying in-process: ${describe(err)}`);
    }
  }
  return embedInProcess(images);
}

/**
 * Detect + embed faces in a batch of image files (lane B). Model files are
 * already on disk (the catalog downloads host-side); this routes to the
 * shared worker or falls back in-process. Failure state is face-scoped.
 */
export async function detectFaces(
  images: ImageEmbedJob[],
  models: FaceModelPaths,
): Promise<FaceDetectOutcome[]> {
  if (images.length === 0) return [];
  if (faceDisabledReason) throw new ImageEmbeddingsDisabledError(faceDisabledReason);
  const temporaryReason = currentFaceUnavailableReason();
  if (temporaryReason) throw new ImageEmbeddingsUnavailableError(temporaryReason);
  const w = ensureWorker();
  if (w) {
    try {
      return await sendFacesToWorker(w, images, models);
    } catch (err) {
      if (err instanceof ImageEmbeddingsUnavailableError) throw err;
      if (faceDisabledReason) throw new ImageEmbeddingsDisabledError(faceDisabledReason);
      log.warn(`[memory] face detect via worker failed; retrying in-process: ${describe(err)}`);
    }
  }
  try {
    return await runFaceDetect(images, models);
  } catch (err) {
    if (err instanceof PipelineLoadError) {
      if (err.retryable) {
        markFaceTemporarilyUnavailable(err.message);
        throw new ImageEmbeddingsUnavailableError(faceUnavailableReason ?? err.message);
      }
      markFaceDisabled(err.message, err.optionalPeerMissing);
      throw new ImageEmbeddingsDisabledError(faceDisabledReason ?? err.message);
    }
    throw err;
  }
}
