import { z } from 'zod';

/**
 * ─ Model scorecard ───────────────────────────────────────────────────
 *
 * The durable, shippable record of "how did each model do on the standard
 * suites, on a real device". Written by `pnpm eval:scorecard`, read by the
 * handboek `::handboek-model-scorecard` macro, and checked in so the
 * shipped articles carry real measurements rather than claims.
 *
 * ## The one rule that makes this scientific
 *
 * **A comparison is only valid inside a single sweep.** Two models are
 * comparable when they ran the same scenario set, on the same device,
 * against the same harness commit and the same catalog pin. Change any of
 * those and the numbers describe different experiments that happen to
 * share a scale.
 *
 * That collides with the practical need to add a model later without
 * re-running everything, so the format keeps BOTH: a `runs[]` list where
 * each run is one internally-comparable sweep, and per-model results that
 * name the run they came from. Rendering then has an honest job — present
 * one run as the headline table, and mark anything measured elsewhere as
 * what it is. Nothing merges silently.
 *
 * ## What counts against a model
 *
 * Only `failureClass: 'model'` trials. A capacity denial, a wedged engine,
 * an operator interrupt, or a grader bug is not a capability signal, and
 * folding those into a pass rate is the fastest way to publish a wrong
 * number. Each cell therefore records the failure-class split, and the
 * headline rate is computed over *attributable* trials.
 *
 * ## What we deliberately do not publish as comparable
 *
 * LLM-judge axis scores. They come from a frontier model that changes
 * under us, so they are recorded WITH the judge model id and are only ever
 * compared inside one run. The deterministic pass/fail is the longitudinal
 * signal; the judge is colour.
 */

/** Schema version — bump only on a breaking shape change. */
export const SCORECARD_SCHEMA_VERSION = 1;

/**
 * Below this many trials a pass fraction is rendered as a raw count, never
 * a percentage. Mirrors the eval harness's `MIN_TRIALS_FOR_RATE`: at n=1 a
 * medium local model is close to a coin flip, and "100%" from one trial is
 * a claim the sample cannot support.
 */
export const MIN_TRIALS_FOR_RATE = 3;

export const ScorecardDeviceSchema = z
  .object({
    /** Short human label, e.g. "Mac Studio (M4 Max)". */
    label: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    /** Total physical RAM in GB, rounded. */
    memoryGb: z.number().positive().optional(),
    /** OS release string, e.g. "darwin 25.5.0". */
    osRelease: z.string().optional(),
    cpuModel: z.string().optional(),
  })
  .strict();
export type ScorecardDevice = z.infer<typeof ScorecardDeviceSchema>;

/**
 * Everything that has to match for two models to be comparable. Two runs
 * with identical provenance may be merged; anything else may not.
 */
export const ScorecardProvenanceSchema = z
  .object({
    /** ISO date the sweep started. */
    startedAt: z.string().min(1),
    device: ScorecardDeviceSchema,
    /** Short git sha of the gezel checkout that ran the sweep. */
    harnessCommit: z.string().min(1),
    /** Exact `@bendyline/gilde` version the catalog resolved. */
    gildeVersion: z.string().min(1),
    /** Trials per scenario requested. */
    count: z.number().int().positive(),
    /** Judge model id when `--llm-judge` ran, else null. */
    judgeModelId: z.string().nullable(),
    /** Native engine build identifiers, keyed by engine. */
    engineBuilds: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ScorecardProvenance = z.infer<typeof ScorecardProvenanceSchema>;

export const ScorecardRunSchema = z
  .object({
    /** Stable id, e.g. "2026-08-09-mac-studio-m4max". */
    id: z.string().min(1),
    provenance: ScorecardProvenanceSchema,
    /** Suites this run covered end to end. */
    suites: z.array(z.string().min(1)).min(1),
    /**
     * Scenario ids per suite AS RUN. Pinned here rather than read from the
     * live registry so a later suite edit cannot silently reinterpret an
     * old result — the record says what was actually measured.
     */
    scenariosBySuite: z.record(z.string(), z.array(z.string().min(1))),
    /** Free-text operator note (what changed, why this sweep happened). */
    note: z.string().optional(),
  })
  .strict();
export type ScorecardRun = z.infer<typeof ScorecardRunSchema>;

/** One model × one scenario cell. */
export const ScorecardCellSchema = z
  .object({
    scenarioId: z.string().min(1),
    trials: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    /**
     * Trials whose failure was NOT the model's fault (infra, operator,
     * grader). Excluded from the attributable denominator — see the module
     * header. A cell where this equals `trials - successes` and successes
     * is 0 measured nothing about the model.
     */
    nonModelFailures: z.number().int().nonnegative(),
    /** Median wall-clock across the cell's trials, ms. */
    medianDurationMs: z.number().nonnegative().optional(),
  })
  .strict();
export type ScorecardCell = z.infer<typeof ScorecardCellSchema>;

export const ScorecardModelResultSchema = z
  .object({
    /** Catalog model id, e.g. "gemma4-e4b-q4". */
    modelId: z.string().min(1),
    /** Display name for the articles. */
    label: z.string().min(1),
    /** Local engine the sweep used, e.g. "llama-cpp" | "mlx" | "ds4". */
    engine: z.string().min(1),
    /** Capability tier at sweep time (tiny | small | medium | large | frontier). */
    tier: z.string().min(1),
    /** Parameter size label, e.g. "31B". */
    parameterSize: z.string().optional(),
    /** Quantization label, e.g. "Q4_K_M". */
    quantization: z.string().optional(),
    /** Context window the engine actually launched with, tokens. */
    grantedContextTokens: z.number().int().positive().optional(),
    /** The run this result belongs to — the comparability key. */
    runId: z.string().min(1),
    suiteId: z.string().min(1),
    cells: z.array(ScorecardCellSchema),
  })
  .strict();
export type ScorecardModelResult = z.infer<typeof ScorecardModelResultSchema>;

export const ScorecardDatasetSchema = z
  .object({
    schemaVersion: z.literal(SCORECARD_SCHEMA_VERSION),
    /**
     * Newest first. The first entry that covers a suite is that suite's
     * headline run.
     */
    runs: z.array(ScorecardRunSchema),
    results: z.array(ScorecardModelResultSchema),
  })
  .strict()
  .superRefine((dataset, ctx) => {
    const runIds = new Set(dataset.runs.map((run) => run.id));
    for (const result of dataset.results) {
      if (!runIds.has(result.runId)) {
        ctx.addIssue({
          code: 'custom',
          message: `result ${result.modelId}/${result.suiteId} names unknown run "${result.runId}"`,
        });
      }
    }
    const seen = new Set<string>();
    for (const result of dataset.results) {
      const key = `${result.runId}::${result.suiteId}::${result.modelId}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', message: `duplicate result for ${key}` });
      }
      seen.add(key);
    }
  });
export type ScorecardDataset = z.infer<typeof ScorecardDatasetSchema>;
