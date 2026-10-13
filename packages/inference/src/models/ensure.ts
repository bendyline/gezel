import { randomUUID } from 'node:crypto';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import type { MlxModelManager } from '../providers/mlx/index.js';

/**
 * Backends `/v1/models/ensure` understands today. Ollama is intentionally
 * not yet wired — `/api/ollama/pull` is the current path; deferred to a
 * later phase.
 */
export type EnsureBackend = 'llama-cpp' | 'mlx' | 'ds4';

/**
 * One event from an in-flight install job. The shape is a
 * superset across both backends — fields irrelevant to the active
 * backend are simply omitted. Apps should branch on `type`.
 */
export type EnsureEvent =
  | { type: 'progress'; jobId: string; modelId: string; bytesWritten: number; totalBytes: number }
  | { type: 'verifying'; jobId: string; modelId: string; file?: string }
  | { type: 'extracting-metadata'; jobId: string; modelId: string }
  | {
      type: 'retrying';
      jobId: string;
      modelId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'done'; jobId: string; modelId: string; warning?: string }
  | { type: 'error'; jobId: string; modelId: string; error: string };

export interface EnsureModelResult {
  /**
   * `ready` — the model is already installed; no job started. Callers
   * can immediately call `POST /v1/chat/completions`.
   *
   * `downloading` — an install job is in flight (existing or freshly
   * started). Poll via `GET /v1/models/ensure/:jobId` or subscribe via
   * `GET /v1/models/ensure/:jobId/events`.
   */
  status: 'ready' | 'downloading';
  modelId: string;
  jobId?: string;
}

export interface JobSnapshot {
  jobId: string;
  modelId: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  /**
   * Cached recent events so a late subscriber can replay history
   * before live events arrive. Capped to the last 64 to bound memory.
   */
  events: EnsureEvent[];
}

export interface EnsureModelOrchestrator {
  /**
   * Idempotent: if the model is already installed, returns immediately
   * with `status: 'ready'`. If an install for the same model is in
   * flight, returns the existing `jobId`. Otherwise starts a new job
   * and returns its `jobId`. Throws a `KnownEnsureError` for unknown
   * models, unsupported backends, or unsupported provider sources on
   * the selected backend (e.g. an MLX-only model requested via the
   * llama-cpp backend) so the route can map to 404 / 400.
   */
  ensure(qualifiedModelId: string): Promise<EnsureModelResult>;
  getJob(jobId: string): JobSnapshot | null;
  subscribeJob(jobId: string, listener: (event: EnsureEvent) => void): () => void;
}

/**
 * Error class with a structured `code` so the route can pick the
 * right HTTP status. Avoids regex-matching error message strings.
 */
export class KnownEnsureError extends Error {
  readonly code:
    | 'unknown_model'
    | 'unsupported_backend'
    | 'no_source_for_backend'
    | 'ambiguous_model';
  constructor(code: KnownEnsureError['code'], message: string) {
    super(message);
    this.name = 'KnownEnsureError';
    this.code = code;
  }
}

export interface CreateEnsureModelOptions {
  llamaCpp: LlamaCppModelManager;
  ds4: LlamaCppModelManager;
  mlx: MlxModelManager;
  catalog: CatalogService;
  /**
   * Fired (fire-and-forget) the moment a fresh install job starts, with
   * the backend + catalog id. Lets the host kick off engine-side
   * provisioning that's independent of the weight download — notably
   * warming the MLX Python venv (uv + mlx-vlm + torch wheels, 1–5 min
   * cold) in parallel with the download instead of paying it serially
   * on the first chat turn. Not called when the model is already
   * installed or an install for it is already in flight. The host owns
   * error handling — this orchestrator never awaits it.
   */
  onInstallStart?: (info: { backend: EnsureBackend; catalogId: string }) => void;
}

interface ActiveJob {
  jobId: string;
  modelId: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  events: EnsureEvent[];
  listeners: Set<(event: EnsureEvent) => void>;
}

const RECENT_EVENT_CAP = 64;

/**
 * Parse a qualified id (`<backend>:<catalogId>`) into its parts. Bare
 * ids and forward-slash separators are rejected — `/v1/models/ensure`
 * requires explicit disambiguation so the caller (and the user reading
 * an error message) can see exactly which backend was selected.
 */
export function parseQualifiedModelId(
  qualified: string,
): { backend: EnsureBackend; catalogId: string } | null {
  const trimmed = qualified.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf(':');
  if (idx < 0) return null;
  const backendRaw = trimmed.slice(0, idx);
  const catalogId = trimmed.slice(idx + 1).trim();
  if (!catalogId) return null;
  if (backendRaw !== 'llama-cpp' && backendRaw !== 'mlx' && backendRaw !== 'ds4') return null;
  return { backend: backendRaw, catalogId };
}

export async function createEnsureModelOrchestrator(
  opts: CreateEnsureModelOptions,
): Promise<EnsureModelOrchestrator> {
  // Keyed by qualified id for de-duplication: a second `ensure` for the
  // same model joins the existing job instead of starting a parallel
  // install (which both backends already reject anyway, but we want a
  // friendlier behavior at the orchestrator layer).
  const jobsByModel = new Map<string, ActiveJob>();
  const jobsById = new Map<string, ActiveJob>();

  function emit(job: ActiveJob, event: EnsureEvent): void {
    job.events.push(event);
    if (job.events.length > RECENT_EVENT_CAP) {
      job.events.splice(0, job.events.length - RECENT_EVENT_CAP);
    }
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        // Listener crashes shouldn't kill the job pump.
      }
    }
  }

  async function isInstalled(backend: EnsureBackend, catalogId: string): Promise<boolean> {
    const manager =
      backend === 'llama-cpp' ? opts.llamaCpp : backend === 'ds4' ? opts.ds4 : opts.mlx;
    const model = await manager.resolveModel(catalogId).catch(() => null);
    return model !== null;
  }

  async function startJob(
    qualifiedModelId: string,
    backend: EnsureBackend,
    catalogId: string,
  ): Promise<string> {
    const jobId = randomUUID();
    const job: ActiveJob = {
      jobId,
      modelId: qualifiedModelId,
      status: 'running',
      startedAt: Date.now(),
      events: [],
      listeners: new Set(),
    };
    jobsByModel.set(qualifiedModelId, job);
    jobsById.set(jobId, job);

    // Let the host overlap engine-side provisioning with the download
    // (e.g. warm the MLX venv). Fire-and-forget — never let a host
    // callback throw into the job-start path.
    try {
      opts.onInstallStart?.({ backend, catalogId });
    } catch {
      // Host owns its own errors; a throw here must not abort the job.
    }

    const manager =
      backend === 'llama-cpp' ? opts.llamaCpp : backend === 'ds4' ? opts.ds4 : opts.mlx;
    const iter = manager.install(catalogId);

    // Drive the install loop in the background. Subscribers get every
    // event via `emit`; the job's terminal status is set on the last
    // event of either backend's contract (`done` or `error`).
    void (async () => {
      try {
        for await (const ev of iter) {
          const enriched = { ...ev, jobId, modelId: qualifiedModelId } as EnsureEvent;
          emit(job, enriched);
          if (ev.type === 'done') {
            job.status = 'done';
          } else if (ev.type === 'error') {
            job.status = 'error';
          }
        }
        // Defensive: if the iterable closes without emitting a terminal
        // event, surface a synthetic error so subscribers see a final
        // state instead of waiting forever.
        if (job.status === 'running') {
          job.status = 'error';
          emit(job, {
            type: 'error',
            jobId,
            modelId: qualifiedModelId,
            error: 'install loop closed without a terminal event',
          });
        }
      } catch (err) {
        job.status = 'error';
        emit(job, {
          type: 'error',
          jobId,
          modelId: qualifiedModelId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Free the per-model slot so a follow-up `ensure` can start a
        // fresh job (e.g. after a failed install the user retries).
        // The completed-job snapshot stays available by `jobId` for a
        // while so polling clients can still read it.
        jobsByModel.delete(qualifiedModelId);
        // Keep the completed job in `jobsById` for ~10 minutes so SSE
        // reconnects + late status checks still find it.
        setTimeout(() => jobsById.delete(jobId), 10 * 60_000).unref?.();
      }
    })();

    return jobId;
  }

  return {
    async ensure(qualifiedModelId: string): Promise<EnsureModelResult> {
      const parsed = parseQualifiedModelId(qualifiedModelId);
      if (!parsed) {
        throw new KnownEnsureError(
          'ambiguous_model',
          `Expected "<backend>:<catalogId>" — got "${qualifiedModelId}". Call /v1/models for the catalog.`,
        );
      }
      const { backend, catalogId } = parsed;

      // Catalog validation: confirm the model exists and has a source
      // for the requested backend before either resolving or starting
      // a job. Catches typos and "MLX-only model on a non-Apple host"
      // up front instead of as a job error 30s later.
      const detail = await opts.catalog.get('chat-model', catalogId).catch(() => null);
      if (!detail || detail.manifest.kind !== 'chat-model') {
        throw new KnownEnsureError(
          'unknown_model',
          `chat-model "${catalogId}" is not in the catalog`,
        );
      }
      const source =
        backend === 'llama-cpp'
          ? detail.manifest.llamaCpp
          : backend === 'ds4'
            ? detail.manifest.ds4
            : detail.manifest.mlx;
      if (!source) {
        const alternatives = [
          detail.manifest.llamaCpp ? `llama-cpp:${catalogId}` : null,
          detail.manifest.mlx ? `mlx:${catalogId}` : null,
          detail.manifest.ds4 ? `ds4:${catalogId}` : null,
        ].filter((id): id is string => Boolean(id));
        throw new KnownEnsureError(
          'no_source_for_backend',
          `chat-model "${catalogId}" has no ${backend} source${alternatives.length > 0 ? ` — try ${alternatives.map((id) => `"${id}"`).join(' or ')}` : ''}`,
        );
      }

      if (await isInstalled(backend, catalogId)) {
        return { status: 'ready', modelId: qualifiedModelId };
      }

      const existing = jobsByModel.get(qualifiedModelId);
      if (existing) {
        return { status: 'downloading', modelId: qualifiedModelId, jobId: existing.jobId };
      }

      const jobId = await startJob(qualifiedModelId, backend, catalogId);
      return { status: 'downloading', modelId: qualifiedModelId, jobId };
    },

    getJob(jobId: string): JobSnapshot | null {
      const job = jobsById.get(jobId);
      if (!job) return null;
      return {
        jobId: job.jobId,
        modelId: job.modelId,
        status: job.status,
        startedAt: job.startedAt,
        events: [...job.events],
      };
    },

    subscribeJob(jobId: string, listener: (event: EnsureEvent) => void): () => void {
      const job = jobsById.get(jobId);
      if (!job) return () => {};
      // Replay buffered events so a late subscriber doesn't miss the
      // earlier `progress` chunks (same pattern as ChatEventBus).
      for (const past of job.events) listener(past);
      // If the job is already terminal, no live events are coming. Tell
      // the caller via a synthetic empty unsubscribe — the buffered
      // replay above already delivered the final state.
      if (job.status !== 'running') {
        return () => {};
      }
      job.listeners.add(listener);
      return () => {
        job.listeners.delete(listener);
      };
    },
  };
}
