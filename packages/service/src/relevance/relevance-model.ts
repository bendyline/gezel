import { Worker } from 'node:worker_threads';
import { createLogger } from '@bendyline/gezel';
import { retireModelWorker } from '../utils/retire-model-worker.js';
import { findServiceWorkerEntry } from '../utils/service-worker-entry.js';
import {
  type RelevanceScoreOutcome,
  type ResolvedRelevanceModel,
  disposeRelevanceModels,
  loadRelevanceModel,
  scoreRelevancePairs,
} from './relevance-core.js';

/**
 * Host side of the relevance model: owns its worker, per-model readiness,
 * outages, and the "never hold a turn for a model load" rule. A cold model
 * answers `cold` immediately and warms in the background; the next query gets
 * scores. Callers never see an exception — every outcome is a status.
 */

const log = createLogger('relevance');

export type RelevanceRunStatus =
  | 'scored'
  | 'partial'
  | 'timeout'
  | 'cold'
  | 'unavailable'
  | 'disabled';

export interface RelevanceScoreResult {
  status: RelevanceRunStatus;
  /** Activated 0–1 scores, one per passage; null where none was computed. */
  scores?: Array<number | null>;
  ms: number;
  modelId: string;
  truncatedPassages?: number;
  reason?: string;
}

/** What SearchService and the preview route depend on — swappable in tests. */
export interface RelevanceScorer {
  status(modelId: string): 'cold' | 'warming' | 'ready' | 'unavailable' | 'disabled';
  score(request: {
    model: ResolvedRelevanceModel;
    query: string;
    passages: string[];
    budgetMs: number;
    waitForLoad?: boolean;
  }): Promise<RelevanceScoreResult>;
  warm(model: ResolvedRelevanceModel): Promise<boolean>;
}

const RETRY_COOLDOWN_MS = 60_000;
const DEFAULT_IDLE_MS = 30 * 60_000;

function disabledByEnv(): boolean {
  const raw = process.env.GEZEL_DISABLE_RELEVANCE_MODEL;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function idleMs(): number {
  const raw = Number(process.env.GEZEL_RELEVANCE_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

interface WorkerReply {
  id: number;
  ok?: boolean;
  expired?: boolean;
  scores?: Array<number | null>;
  partial?: boolean;
  truncatedPassages?: number;
  inferMs?: number;
  error?: string;
  fatal?: boolean;
  retryable?: boolean;
}

type Pending = { resolve: (reply: WorkerReply) => void };

/** Where in-process inference runs (tests and the VITEST fallback). */
export interface RelevanceBackend {
  warm(model: ResolvedRelevanceModel): Promise<void>;
  score(
    model: ResolvedRelevanceModel,
    query: string,
    passages: string[],
    deadlineAt: number,
  ): Promise<RelevanceScoreOutcome>;
}

const coreBackend: RelevanceBackend = {
  warm: async (model) => {
    await loadRelevanceModel(model);
  },
  score: (model, query, passages, deadlineAt) =>
    scoreRelevancePairs(model, query, passages, deadlineAt),
};

class RelevanceModelHost implements RelevanceScorer {
  constructor(private readonly backend: RelevanceBackend = coreBackend) {}

  private worker: Worker | null = null;
  private workerUsable = true;
  /** Set by service shutdown: no new worker or request until reopened. */
  private closed = false;
  private crashCount = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly readiness = new Map<string, 'warming' | 'ready'>();
  private readonly warming = new Map<string, Promise<boolean>>();
  private readonly outages = new Map<string, { reason: string; until: number }>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  status(modelId: string): 'cold' | 'warming' | 'ready' | 'unavailable' | 'disabled' {
    if (disabledByEnv() || !this.workerUsableOrTest()) return 'disabled';
    if (this.outage(modelId)) return 'unavailable';
    return this.readiness.get(modelId) ?? 'cold';
  }

  async warm(model: ResolvedRelevanceModel): Promise<boolean> {
    // During shutdown a warm-up would start (or load) a worker as the process exits.
    if (this.closed) return false;
    if (this.status(model.id) === 'ready') return true;
    const running = this.warming.get(model.id);
    if (running) return running;
    this.readiness.set(model.id, 'warming');
    const promise = this.request({ kind: 'warm', model }).then((reply) => {
      this.warming.delete(model.id);
      if (reply.ok) {
        this.readiness.set(model.id, 'ready');
        return true;
      }
      this.readiness.delete(model.id);
      this.recordFailure(model.id, reply);
      return false;
    });
    this.warming.set(model.id, promise);
    return promise;
  }

  async score(request: {
    model: ResolvedRelevanceModel;
    query: string;
    passages: string[];
    budgetMs: number;
    waitForLoad?: boolean;
  }): Promise<RelevanceScoreResult> {
    const started = performance.now();
    const modelId = request.model.id;
    const done = (result: Omit<RelevanceScoreResult, 'ms' | 'modelId'>): RelevanceScoreResult => ({
      ...result,
      ms: Math.round(performance.now() - started),
      modelId,
    });
    if (this.closed) return done({ status: 'unavailable', reason: 'the service is shutting down' });
    const status = this.status(modelId);
    if (status === 'disabled') return done({ status: 'disabled' });
    if (status === 'unavailable') {
      return done({ status: 'unavailable', reason: this.outage(modelId) ?? undefined });
    }
    if (status !== 'ready') {
      const warming = this.warm(request.model);
      if (!request.waitForLoad) return done({ status: 'cold' });
      if (!(await warming)) {
        return done({ status: 'unavailable', reason: this.outage(modelId) ?? undefined });
      }
    }
    this.touch();
    const deadlineAt = Date.now() + request.budgetMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = await Promise.race([
      this.request({
        kind: 'score',
        model: request.model,
        query: request.query,
        passages: request.passages,
        deadlineAt,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), request.budgetMs + 50);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!reply || reply.expired) return done({ status: 'timeout' });
    if (reply.error) {
      this.recordFailure(modelId, reply);
      return done({ status: 'unavailable', reason: reply.error });
    }
    return done({
      status: reply.partial ? 'partial' : 'scored',
      scores: reply.scores ?? [],
      truncatedPassages: reply.truncatedPassages ?? 0,
    });
  }

  private recordFailure(modelId: string, reply: WorkerReply): void {
    const reason = reply.error ?? 'unknown failure';
    const until = reply.fatal ? Number.POSITIVE_INFINITY : Date.now() + RETRY_COOLDOWN_MS;
    this.outages.set(modelId, { reason, until });
    log.warn(
      `[relevance] ${modelId} ${reply.fatal ? 'disabled until restart' : `unavailable for ${RETRY_COOLDOWN_MS / 1000}s`}: ${reason}`,
    );
  }

  private outage(modelId: string): string | null {
    const outage = this.outages.get(modelId);
    if (!outage) return null;
    if (Date.now() < outage.until) return outage.reason;
    this.outages.delete(modelId);
    return null;
  }

  private workerUsableOrTest(): boolean {
    return this.workerUsable || Boolean(process.env.VITEST);
  }

  // ── transport: the worker in production, in-process under VITEST ──────

  private async request(
    msg:
      | { kind: 'warm'; model: ResolvedRelevanceModel }
      | {
          kind: 'score';
          model: ResolvedRelevanceModel;
          query: string;
          passages: string[];
          deadlineAt: number;
        },
  ): Promise<WorkerReply> {
    const worker = this.ensureWorker();
    if (!worker) return this.inProcess(msg);
    const id = this.nextId++;
    return new Promise<WorkerReply>((resolve) => {
      this.pending.set(id, { resolve });
      worker.postMessage({ id, ...msg });
    });
  }

  private async inProcess(
    msg:
      | { kind: 'warm'; model: ResolvedRelevanceModel }
      | {
          kind: 'score';
          model: ResolvedRelevanceModel;
          query: string;
          passages: string[];
          deadlineAt: number;
        },
  ): Promise<WorkerReply> {
    try {
      if (msg.kind === 'warm') {
        await this.backend.warm(msg.model);
        return { id: 0, ok: true };
      }
      if (Date.now() > msg.deadlineAt) return { id: 0, expired: true };
      const outcome: RelevanceScoreOutcome = await this.backend.score(
        msg.model,
        msg.query,
        msg.passages,
        msg.deadlineAt,
      );
      return { id: 0, ...outcome };
    } catch (err) {
      return {
        id: 0,
        error: err instanceof Error ? err.message : String(err),
        fatal: true,
      };
    }
  }

  private ensureWorker(): Worker | null {
    if (this.closed || process.env.VITEST || !this.workerUsable) return null;
    if (this.worker) return this.worker;
    const entry = findServiceWorkerEntry(import.meta.url, 'relevance-model');
    if (!entry) {
      this.workerUsable = false;
      log.warn('[relevance] worker entry is missing; the relevance model is disabled');
      return null;
    }
    try {
      const worker = new Worker(entry);
      worker.on('message', (reply: WorkerReply) => {
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        pending.resolve(reply);
      });
      worker.on('error', (err) =>
        this.onWorkerDown(err instanceof Error ? err.message : String(err)),
      );
      worker.on('exit', (code) => {
        if (code !== 0) this.onWorkerDown(`worker exited with code ${code}`);
      });
      worker.unref();
      this.worker = worker;
      return worker;
    } catch (err) {
      this.workerUsable = false;
      log.warn(`[relevance] worker failed to start: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private onWorkerDown(reason: string): void {
    const dead = this.worker;
    this.worker = null;
    if (dead) void dead.terminate().catch(() => {});
    for (const pending of this.pending.values()) {
      pending.resolve({ id: 0, error: `relevance worker stopped: ${reason}`, retryable: true });
    }
    this.pending.clear();
    this.readiness.clear();
    this.warming.clear();
    this.crashCount++;
    if (this.crashCount >= 3) {
      this.workerUsable = false;
      log.warn(`[relevance] worker crashed ${this.crashCount} times; disabled until restart`);
    }
  }

  /** Drop the worker (and its resident model) after it sits idle. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), idleMs());
    this.idleTimer.unref();
  }

  /**
   * Close for service shutdown: refuse new work, then terminate the worker once
   * its in-flight warm-up or scoring has finished, waiting at most `drainMs`
   * (see retire-model-worker.ts for why it must never be torn down mid-run).
   */
  async shutdown(drainMs: number): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    if (!worker) return;
    if (await retireModelWorker(worker, () => this.pending.size === 0, drainMs)) {
      if (this.worker === worker) this.worker = null;
      this.readiness.clear();
      this.warming.clear();
      return;
    }
    log.warn('[relevance] scoring was still running at shutdown; leaving its worker to exit');
  }

  /** Reopen after shutdown — an embedded service can be started again in the same process. */
  open(): void {
    this.closed = false;
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.readiness.clear();
    this.warming.clear();
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate().catch(() => {});
    if (process.env.VITEST) disposeRelevanceModels();
  }
}

let host: RelevanceModelHost | null = null;

/** The process-wide relevance scorer. */
export function relevanceScorer(): RelevanceScorer & { dispose(): void } {
  host ??= new RelevanceModelHost();
  return host;
}

/** Shut the process-wide scorer down for service shutdown; see `RelevanceModelHost.shutdown`. */
export async function shutdownRelevanceScorer(drainMs: number): Promise<void> {
  await host?.shutdown(drainMs);
}

/** Reopen the process-wide scorer when a service starts. */
export function openRelevanceScorer(): void {
  host?.open();
}

/** A private scorer over an explicit backend — tests, and nothing else. */
export function createRelevanceScorer(backend: RelevanceBackend): RelevanceScorer & {
  dispose(): void;
  shutdown(drainMs: number): Promise<void>;
  open(): void;
} {
  return new RelevanceModelHost(backend);
}
