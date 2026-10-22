import type { TransformStreamEvent } from '@bendyline/gezel';
import type { EvalJobStreamEvent } from '@bendyline/gezel/eval';
import { z } from 'zod';
import { GezelApiError } from './api-error.js';
import type { MlxInstallEvent } from './mlx-model.js';
import {
  type ConsumeSseJsonOptions,
  SseResponseError,
  SseStreamStaleError,
  consumeSseJson,
} from './sse.js';

const MODEL_DOWNLOAD_STALL_TIMEOUT_MS = 40 * 60_000;
const MODEL_DOWNLOAD_STALLED_MESSAGE = 'Download stopped: server has gone quiet.';
export const MODEL_DOWNLOAD_SSE_POLICY = {
  keepaliveTimeoutMs: MODEL_DOWNLOAD_STALL_TIMEOUT_MS,
  staleMessage: MODEL_DOWNLOAD_STALLED_MESSAGE,
} as const;

/**
 * Streaming progress event for `pullOllamaModel`. `progress.chunk` is the
 * raw NDJSON chunk straight from Ollama (`{status, digest?, total?,
 * completed?}`). `done` is terminal. `error` arrives right before `done`
 * on failure.
 */
export type OllamaPullEvent =
  | { type: 'progress'; chunk: OllamaPullChunk }
  | { type: 'error'; error: string }
  | { type: 'done' };

export interface OllamaPullChunk {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/**
 * Events emitted by the `/api/llama-cpp/models/:id/install` SSE
 * stream. Mirrors the `InstallEvent` shape on the service side.
 */
export type LlamaCppInstallEvent =
  | { type: 'progress'; bytesWritten: number; totalBytes: number }
  /**
   * Surfaced by the shared `downloadWithRetry` helper between
   * attempts. Render "Connection dropped — retrying in 4s
   * (attempt 3/5)…" instead of a fatal error banner.
   */
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'verifying' }
  | { type: 'extracting-metadata' }
  | {
      type: 'companion';
      kind: 'image-recognition';
      id: string;
      name: string;
      bytesWritten: number;
      totalBytes: number;
      error?: string;
    }
  | { type: 'done'; id: string; warning?: string }
  /**
   * Terminal failure. When `mismatch` is present, the failure is a
   * sha256 mismatch against the catalog — the UI can offer "Download
   * anyway" which retries with `{skipSha: true}`.
   */
  | {
      type: 'error';
      error: string;
      mismatch?: { file: string; expected: string; actual: string };
    };

// ── Evals (in-app Benchmarks panel) ──
// The current contract lives in `@bendyline/gezel` (schemas/eval.ts):
// `getEvalCatalog`, `listEvalTargets`, the job methods, and the trial index.
// The three shapes below belong to the first in-app runner's endpoints, kept
// working for existing callers.

/** @deprecated Use `getEvalCatalog()` and `EvalCatalogScenario`. */
export interface EvalScenarioManifest {
  id: string;
  name: string;
  description: string;
  capabilityAxis: string;
  defaultModel: string;
  defaultImageModel?: string;
  timeoutMs: number;
  anchored: boolean;
}

/** @deprecated Use `listEvalTrials()` and `EvalTrialSummary`. */
export interface TrialOutcome {
  trialId: string;
  scenarioId: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  reason: string;
  failureMode?: string;
  runDir: string;
}

/** @deprecated Use `createEvalJob()` + `streamEvalJob()`. */
export type RunEvalEvent =
  | { type: 'spawned'; trialId?: string; runDir?: string }
  | { type: 'log'; line: string }
  | { type: 'done'; result: TrialOutcome }
  | { type: 'error'; error: string };

type ConsumeApiSseJsonOptions<T> = ConsumeSseJsonOptions<T> & {
  staleMessage?: string;
};

export async function consumeApiSseJson<T>(options: ConsumeApiSseJsonOptions<T>): Promise<void> {
  const { staleMessage, ...streamOptions } = options;
  try {
    await consumeSseJson(streamOptions);
  } catch (error) {
    if (error instanceof GezelApiError) throw error;
    const message =
      error instanceof SseStreamStaleError && staleMessage
        ? staleMessage
        : error instanceof Error
          ? error.message
          : 'SSE stream failed';
    const status = error instanceof SseResponseError ? error.status : 0;
    throw new GezelApiError(message, status, {
      cause: error instanceof Error ? error.name : 'unknown',
    });
  }
}

const mismatchSchema = z.object({ file: z.string(), expected: z.string(), actual: z.string() });
export const LlamaCppInstallEventSchema: z.ZodType<LlamaCppInstallEvent> = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('progress'), bytesWritten: z.number(), totalBytes: z.number() }),
    z.object({
      type: z.literal('retrying'),
      attempt: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      delayMs: z.number().nonnegative(),
      reason: z.string(),
    }),
    z.object({ type: z.literal('verifying') }),
    z.object({ type: z.literal('extracting-metadata') }),
    z.object({
      type: z.literal('companion'),
      kind: z.literal('image-recognition'),
      id: z.string(),
      name: z.string(),
      bytesWritten: z.number().nonnegative(),
      totalBytes: z.number().nonnegative(),
      error: z.string().optional(),
    }),
    z.object({ type: z.literal('done'), id: z.string(), warning: z.string().optional() }),
    z.object({ type: z.literal('error'), error: z.string(), mismatch: mismatchSchema.optional() }),
  ],
);
export const MlxInstallEventSchema: z.ZodType<MlxInstallEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    fileIndex: z.number().int().nonnegative(),
    fileCount: z.number().int().positive(),
    file: z.string(),
    bytesWritten: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
    bytesWrittenAll: z.number().nonnegative(),
    totalBytesAll: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    reason: z.string(),
    file: z.string(),
  }),
  z.object({ type: z.literal('verifying'), file: z.string() }),
  z.object({ type: z.literal('extracting-metadata') }),
  z.object({ type: z.literal('done'), id: z.string(), warning: z.string().optional() }),
  z.object({ type: z.literal('error'), error: z.string(), mismatch: mismatchSchema.optional() }),
]);
/**
 * The eval job stream, checked only as far as the stream loop reads it.
 *
 * Deliberately not core's `EvalJobStreamEventSchema`: importing it pulls the
 * whole eval-job schema graph into every client consumer's startup bundle —
 * the desktop UI's initial load paid for a Settings page most people never
 * open. The daemon's job record is the authority for the rest of the shape.
 */
export const EvalJobStreamWireSchema = z.union([
  z.object({ type: z.literal('log'), line: z.string() }),
  z
    .object({
      type: z.enum(['snapshot', 'job']),
      job: z.object({ id: z.string(), status: z.string() }).passthrough(),
      log: z.array(z.string()).optional(),
    })
    .passthrough(),
]) as unknown as z.ZodType<EvalJobStreamEvent>;

export const RunEvalEventSchema: z.ZodType<RunEvalEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('spawned'),
    trialId: z.string().optional(),
    runDir: z.string().optional(),
  }),
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({
    type: z.literal('done'),
    result: z.object({
      trialId: z.string(),
      scenarioId: z.string(),
      modelId: z.string(),
      startedAt: z.string(),
      finishedAt: z.string(),
      durationMs: z.number(),
      success: z.boolean(),
      reason: z.string(),
      failureMode: z.string().optional(),
      runDir: z.string(),
    }),
  }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
export const TransformStreamEventSchema: z.ZodType<TransformStreamEvent> = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('status'),
      phase: z.enum(['queued', 'started']),
      detail: z.string().optional(),
    }),
    z.object({ type: z.literal('thinking-delta'), text: z.string() }),
    z.object({ type: z.literal('output-delta'), text: z.string() }),
    z.object({ type: z.literal('done'), text: z.string() }),
    z.object({ type: z.literal('error'), error: z.string() }),
  ],
);
export const OllamaPullEventSchema: z.ZodType<OllamaPullEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    chunk: z.object({
      status: z.string(),
      digest: z.string().optional(),
      total: z.number().optional(),
      completed: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal('error'), error: z.string() }),
  z.object({ type: z.literal('done') }),
]);
