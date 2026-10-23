/**
 * The vision model's queue for camera frames, shared by every camera on the
 * install. The recognition engine runs one request at a time, so:
 *  - one review is in flight across all cameras;
 *  - each camera holds at most one waiting frame, and a newer frame replaces
 *    it — a review of what was in view ten seconds ago is worth less than a
 *    review of what is in view now;
 *  - an hourly ceiling bounds what a busy doorway can cost.
 * A review never blocks capture: a camera offers a frame and gets an answer,
 * or a reason it got none, later.
 */

import type { ImageRecognition, LookoutQuestion } from '@bendyline/gezel';
import {
  type ParsedCameraReview,
  buildCameraReviewRequest,
  createAwakeTimeout,
  createLogger,
  parseCameraReviewAnswer,
} from '@bendyline/gezel';
import { simulatedReview, simulatedStepOf } from './simulator.js';

const log = createLogger('camera');

export const REVIEWS_PER_HOUR = 120;
/** Wall budget for one review, including the wait for engine memory. */
const REVIEW_BUDGET_MS = 90_000;

export interface CameraReviewJob {
  /** Camera identity (`projectId/bindingId`); one waiting job per key. */
  key: string;
  jpeg: Buffer;
  questions: LookoutQuestion[];
}

export type CameraReviewOutcome =
  | { ok: true; review: ParsedCameraReview; durationMs: number; modelId?: string }
  | {
      ok: false;
      reason: 'superseded' | 'hourly-limit' | 'no-model' | 'failed' | 'canceled';
      detail?: string;
    };

export interface CameraReviewerDeps {
  recognize(input: {
    bytes: Buffer;
    mimeType: string;
    mode: 'extract';
    schema: unknown;
    prompt: { system: string; user: string; maxTokens: number };
    cache: false;
    timeoutMsOverride: number;
    signal: AbortSignal;
  }): Promise<ImageRecognition>;
  available(): Promise<boolean>;
  now?(): number;
}

interface Waiting {
  job: CameraReviewJob;
  signal: AbortSignal;
  resolve(outcome: CameraReviewOutcome): void;
}

export class CameraReviewer {
  private running = false;
  private readonly waiting = new Map<string, Waiting>();
  private readonly recent: number[] = [];

  constructor(private readonly deps: CameraReviewerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Whether the hourly ceiling has room. */
  private underLimit(): boolean {
    const hourAgo = this.now() - 60 * 60_000;
    while (this.recent.length > 0 && (this.recent[0] as number) < hourAgo) this.recent.shift();
    return this.recent.length < REVIEWS_PER_HOUR;
  }

  review(job: CameraReviewJob, signal: AbortSignal): Promise<CameraReviewOutcome> {
    return new Promise((resolve) => {
      const prior = this.waiting.get(job.key);
      if (prior) prior.resolve({ ok: false, reason: 'superseded' });
      this.waiting.set(job.key, { job, signal, resolve });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.waiting.entries().next();
    if (next.done) return;
    const [key, item] = next.value;
    this.waiting.delete(key);
    this.running = true;
    try {
      item.resolve(await this.run(item));
    } finally {
      this.running = false;
      if (this.waiting.size > 0) void this.pump();
    }
  }

  private async run(item: Waiting): Promise<CameraReviewOutcome> {
    if (item.signal.aborted) return { ok: false, reason: 'canceled' };
    const request = buildCameraReviewRequest(item.job.questions);
    const started = this.now();

    // The simulated camera answers for itself; no model is needed.
    const step = simulatedStepOf(item.job.jpeg);
    if (step) {
      const parsed = parseCameraReviewAnswer(
        simulatedReview(step, [...request.keys.keys()]),
        request.keys,
      );
      if (!parsed) return { ok: false, reason: 'failed' };
      this.recent.push(started);
      return { ok: true, review: parsed, durationMs: 1, modelId: 'simulator' };
    }

    if (!this.underLimit()) return { ok: false, reason: 'hourly-limit' };
    if (!(await this.deps.available().catch(() => false))) return { ok: false, reason: 'no-model' };
    this.recent.push(started);

    const timeout = createAwakeTimeout(REVIEW_BUDGET_MS);
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    item.signal.addEventListener('abort', abort, { once: true });
    timeout.signal.addEventListener('abort', abort, { once: true });
    try {
      const recognition = this.deps.recognize({
        bytes: item.job.jpeg,
        mimeType: 'image/jpeg',
        mode: 'extract',
        schema: request.schema,
        prompt: { system: request.system, user: request.user, maxTokens: request.maxTokens },
        cache: false,
        timeoutMsOverride: 60_000,
        signal: ctrl.signal,
      });
      // The engine's own wait for memory does not watch the signal; racing
      // keeps a stuck admission from holding the queue for every camera.
      const result = await Promise.race([
        recognition,
        new Promise<null>((resolve) =>
          ctrl.signal.addEventListener('abort', () => resolve(null), { once: true }),
        ),
      ]);
      if (!result) {
        return {
          ok: false,
          reason: item.signal.aborted ? 'canceled' : 'failed',
          detail: 'timed out',
        };
      }
      if (result.status !== 'ok' && result.status !== 'partial') {
        return {
          ok: false,
          reason: 'failed',
          ...(result.failureReason ? { detail: result.failureReason } : {}),
        };
      }
      const parsed = parseCameraReviewAnswer(result.structured?.data, request.keys);
      if (!parsed)
        return {
          ok: false,
          reason: 'failed',
          detail: 'the model did not answer in the expected shape',
        };
      return {
        ok: true,
        review: parsed,
        durationMs: this.now() - started,
        modelId: result.modelId,
      };
    } catch (err) {
      log.warn('camera review failed:', err instanceof Error ? err.message : err);
      return {
        ok: false,
        reason: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      item.signal.removeEventListener('abort', abort);
      timeout.dispose();
    }
  }
}
