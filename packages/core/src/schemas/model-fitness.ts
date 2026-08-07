/**
 * Model fitness — the persisted result of a *proeve van bekwaamheid*
 * (competence trial) run against an installed local model. The product
 * twin of the eval harness's preflight admission report
 * (evals/src/preflight.ts): five checks with ok/detail evidence, an
 * `admitted` aggregate, and the measured decode throughput.
 *
 * Records live in `config.modelFitness`, keyed `"<provider>:<modelId>"`.
 * The config field itself is deliberately `z.record(z.string(), z.unknown())` — a
 * malformed or future-versioned record must never fail the whole-config
 * parse (Store.readConfig is all-or-nothing). This schema is enforced
 * per entry at the ModelFitnessManager boundary; invalid entries are
 * skipped, not fatal.
 *
 * Fitness is advisory everywhere it is consumed: badges warn, routing
 * skips fresh not-admitted models, but nothing ever hard-blocks a user
 * from selecting a model.
 */

import { z } from 'zod';

export const FitnessCheckSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type FitnessCheck = z.infer<typeof FitnessCheckSchema>;

export const ModelFitnessStatusSchema = z.enum(['probed', 'failed', 'deferred', 'blocked']);
export type ModelFitnessStatus = z.infer<typeof ModelFitnessStatusSchema>;

export const ModelFitnessTriggerSchema = z.enum(['install', 'manual']);
export type ModelFitnessTrigger = z.infer<typeof ModelFitnessTriggerSchema>;

export const ModelFitnessRecordSchema = z.object({
  schemaVersion: z.literal(1),
  /** Local engine family the probe ran against ('llama-cpp', 'ds4', …). */
  provider: z.string(),
  /** Catalog model id (e.g. `gemma4-e4b-q4`). */
  modelId: z.string(),
  /**
   * `probed` — the trial ran to completion (checks may still fail);
   * `failed` — probe machinery broke (spawn throw, timeout) before a
   * verdict; `deferred` — install-triggered probe gave up waiting for
   * capacity headroom; `blocked` — the engine was busy serving other
   * requests and could not be freed in time, so the check never ran
   * (transient, retriable — not a model defect).
   */
  status: ModelFitnessStatusSchema,
  /** All gating checks passed (eval-report parity). */
  admitted: z.boolean(),
  /**
   * Practical decode tokens/sec. New probes measure this under the
   * representative-context turn; older records contain their short-prompt
   * result. The nested evidence below disambiguates the two shapes.
   */
  genTokensPerSec: z.number().nullable(),
  /** Engine-reported decode rate from the short warm-up turn. */
  shortPromptGenTokensPerSec: z.number().nullable().optional(),
  /**
   * Warm-engine turn with an approximately 20K-token neutral context. Optional
   * so records written before this evidence existed remain readable.
   */
  representativeContext: z
    .object({
      targetPromptTokens: z.number().int().positive(),
      promptTokens: z.number().int().nonnegative().nullable(),
      cachedPromptTokens: z.number().int().nonnegative().nullable(),
      completionTokens: z.number().int().nonnegative().nullable(),
      durationMs: z.number().nonnegative().nullable(),
      ttftMs: z.number().nonnegative().nullable(),
      promptTokensPerSec: z.number().positive().nullable(),
      genTokensPerSec: z.number().positive().nullable(),
    })
    .optional(),
  createdAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  trigger: ModelFitnessTriggerSchema,
  /** Installed weights sha256 at probe time — staleness key. */
  sha256: z.string().optional(),
  /** Catalog version at probe time — staleness key. */
  catalogVersion: z.string().optional(),
  /** GGUF train context window recorded at install time. */
  contextWindow: z.number().int().optional(),
  /** Host memory profile at probe time — drift softens the badge. */
  host: z.object({
    totalRamBytes: z.number(),
    gpuVramBytes: z.number().nullable(),
    source: z.string(),
  }),
  checks: z.object({
    spawn: FitnessCheckSchema,
    toolRoundTrip: FitnessCheckSchema,
    throughput: FitnessCheckSchema,
    reasoningBudget: FitnessCheckSchema,
    contextFit: FitnessCheckSchema,
  }),
});
export type ModelFitnessRecord = z.infer<typeof ModelFitnessRecordSchema>;

/** Canonical `config.modelFitness` map key. */
export function modelFitnessKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}
