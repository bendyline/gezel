import { z } from 'zod';

/**
 * In-app eval runner contract.
 *
 * Two boundaries share these shapes. The eval harness (`evals/`, shipped
 * compiled inside the service) talks to the daemon through a JSON catalog and
 * a line-oriented progress channel on stdout; the daemon talks to the UI
 * through `/api/eval/*`. Both sides parse with the schemas below, so a field
 * the harness renames fails loudly at the seam instead of rendering as blank.
 *
 * The harness stays the only owner of trial orchestration, grading, and
 * scoring. Nothing here re-derives a verdict: the daemon indexes what the
 * harness wrote (`result.json`, `score.json`, `postmortem.md`) and the UI
 * aggregates with the published scorecard's rules (`scoreModel`).
 */

/** Every chat provider the harness can target (evals/src/providers.ts). */
export const EvalProviderIdSchema = z.enum([
  'llama-cpp',
  'mlx',
  'ds4',
  'codex-cli',
  'anthropic-cli',
  'copilot',
  'anthropic',
  'openai',
  'apple-foundation-models',
]);
export type EvalProviderId = z.infer<typeof EvalProviderIdSchema>;

export const EvalProviderCategorySchema = z.enum([
  'local-engine',
  'cli-wrapper',
  'cloud-sdk',
  'system-model',
]);
export type EvalProviderCategory = z.infer<typeof EvalProviderCategorySchema>;

/**
 * What a scenario needs beyond a chat model. Declared on the scenario so a
 * runner can say "this install can't grade X" before spending an hour on it,
 * rather than discovering it as a failed trial.
 */
export const EvalRequirementSchema = z.enum([
  /** An installed image model (sd-cpp). */
  'image-model',
  /** The embedding engine (retrieval scenarios). */
  'embeddings',
  /** The real DocBlocks CLI. */
  'docblocks',
  /** Headless Chromium for the runtime layer of its grader. */
  'chromium',
  /** The Vitest test runner for its grader. */
  'vitest',
  /** Live internet access (clones, real web). Not hermetic. */
  'network',
  /** A sibling source checkout that only a developer machine has. */
  'external-checkout',
]);
export type EvalRequirement = z.infer<typeof EvalRequirementSchema>;

export const EvalScenarioKindSchema = z.enum([
  /** Hand-authored scenario under evals/src/scenarios. */
  'scenario',
  /** Generated from a gilde craftbook's test.json. */
  'craftbook',
  /** Craftbook authoring / selection probe. */
  'craftbook-authoring',
]);
export type EvalScenarioKind = z.infer<typeof EvalScenarioKindSchema>;

export const EvalCatalogScenarioSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  kind: EvalScenarioKindSchema,
  /** One of the frozen longitudinal anchors (tictactoe, petshop, tankcombat). */
  anchored: z.boolean(),
  /** Authored wall-clock ceiling, ms. The runner may extend a progressing trial to 2x. */
  timeoutMs: z.number().int().positive(),
  /** Matrix cap for saturated scenarios; `--count` above it is trimmed. */
  suggestedTrials: z.number().int().positive().optional(),
  defaultImageModelId: z.string().optional(),
  requires: z.array(EvalRequirementSchema),
  /** Advisory LLM-judge axes, when the scenario declares any. */
  judgeAxes: z.array(z.string()),
  /** Suites this scenario belongs to, in registry order. */
  suites: z.array(z.string()),
});
export type EvalCatalogScenario = z.infer<typeof EvalCatalogScenarioSchema>;

export const EvalCatalogSuiteSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  /** Member scenario ids in intended run order (cheapest first). */
  scenarioIds: z.array(z.string().min(1)),
  /** Sum of member ceilings at one trial each — the planning number. */
  authoredCeilingMs: z.number().int().nonnegative(),
});
export type EvalCatalogSuite = z.infer<typeof EvalCatalogSuiteSchema>;

export const EvalCatalogProviderSchema = z.object({
  id: EvalProviderIdSchema,
  category: EvalProviderCategorySchema,
  defaultModelId: z.string().min(1),
});
export type EvalCatalogProvider = z.infer<typeof EvalCatalogProviderSchema>;

export const EVAL_CATALOG_SCHEMA_VERSION = 1;

/** `evals catalog` stdout — the harness's own registry, not a copy of it. */
export const EvalCatalogSchema = z.object({
  schemaVersion: z.literal(EVAL_CATALOG_SCHEMA_VERSION),
  scenarios: z.array(EvalCatalogScenarioSchema),
  suites: z.array(EvalCatalogSuiteSchema),
  defaultSuiteId: z.string().min(1),
  providers: z.array(EvalCatalogProviderSchema),
  defaultProvider: EvalProviderIdSchema,
  /** Below this many trials a pass fraction is a count, never a rate. */
  minTrialsForRate: z.number().int().positive(),
});
export type EvalCatalog = z.infer<typeof EvalCatalogSchema>;

// ── Harness → daemon progress channel ───────────────────────────────────

/**
 * With `--events`, the harness prints one `[eval-event] {json}` line per
 * event on stdout. Everything else on stdout stays the human log; the daemon
 * forwards both.
 */
export const EVAL_EVENT_LINE_PREFIX = '[eval-event] ';

export const EvalHarnessEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('plan'),
    modelId: z.string(),
    provider: z.string(),
    scenarios: z.array(z.object({ scenarioId: z.string(), trials: z.number().int() })),
    totalTrials: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('preflight'),
    admitted: z.boolean().nullable(),
    decodeTokensPerSec: z.number().optional(),
    skippedReason: z.string().optional(),
  }),
  z.object({
    type: z.literal('trial-start'),
    scenarioId: z.string(),
    trialId: z.string(),
    runDir: z.string(),
    /** 1-based position across the whole matrix. */
    trialIndex: z.number().int().positive(),
    totalTrials: z.number().int().nonnegative(),
    startedAt: z.string(),
  }),
  z.object({
    type: z.literal('trial-end'),
    scenarioId: z.string(),
    trialId: z.string(),
    runDir: z.string(),
    success: z.boolean(),
    reason: z.string(),
    failureClass: z.string().optional(),
    durationMs: z.number().nonnegative(),
    /** Fixed-rubric composite (0-10) when `--write-reports` produced one. */
    composite: z.number().optional(),
  }),
  z.object({
    type: z.literal('matrix-end'),
    status: z.enum(['complete', 'incomplete', 'interrupted']),
    totalTrials: z.number().int().nonnegative(),
    totalSuccesses: z.number().int().nonnegative(),
  }),
]);
export type EvalHarnessEvent = z.infer<typeof EvalHarnessEventSchema>;

/** Parse one stdout line; null for ordinary log lines and malformed events. */
export function parseEvalHarnessEventLine(line: string): EvalHarnessEvent | null {
  const start = line.indexOf(EVAL_EVENT_LINE_PREFIX);
  if (start === -1) return null;
  try {
    const parsed = EvalHarnessEventSchema.safeParse(
      JSON.parse(line.slice(start + EVAL_EVENT_LINE_PREFIX.length)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── Daemon API ──────────────────────────────────────────────────────────

/** Where the daemon runs the harness from. `compiled` is every non-checkout install. */
export const EvalHarnessModeSchema = z.enum(['source', 'compiled']);
export type EvalHarnessMode = z.infer<typeof EvalHarnessModeSchema>;

export const EvalTargetSchema = z.object({
  provider: EvalProviderIdSchema,
  modelId: z.string().min(1),
  label: z.string(),
  category: EvalProviderCategorySchema,
  available: z.boolean(),
  /** Why the target can't run here, in words a person can act on. */
  unavailableReason: z.string().optional(),
  /** The model this install uses by default for that provider. */
  isDefault: z.boolean().optional(),
});
export type EvalTarget = z.infer<typeof EvalTargetSchema>;

export const EvalImageModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
});
export type EvalImageModelOption = z.infer<typeof EvalImageModelOptionSchema>;

export const EvalEnvironmentSchema = z.object({
  harness: EvalHarnessModeSchema,
  /** Requirements this install can satisfy; the rest are named per scenario. */
  satisfied: z.array(EvalRequirementSchema),
  /** Where runs are written, so a person can open it. */
  runsDir: z.string(),
});
export type EvalEnvironment = z.infer<typeof EvalEnvironmentSchema>;

export const EvalTargetsResponseSchema = z.object({
  targets: z.array(EvalTargetSchema),
  imageModels: z.array(EvalImageModelOptionSchema),
  environment: EvalEnvironmentSchema,
});
export type EvalTargetsResponse = z.infer<typeof EvalTargetsResponseSchema>;

export const EvalGeneralistModeSchema = z.enum(['auto', 'on', 'off']);

export const EvalJobTargetSpecSchema = z.object({
  provider: EvalProviderIdSchema,
  modelId: z.string().min(1),
});
export type EvalJobTargetSpec = z.infer<typeof EvalJobTargetSpecSchema>;

/** Largest trial count one job may request per scenario. */
export const EVAL_JOB_MAX_COUNT = 10;
/** Largest number of models one job may sweep. */
export const EVAL_JOB_MAX_TARGETS = 8;

export const EvalJobSpecSchema = z
  .object({
    /** Run a named suite, optionally narrowed by `scenarioIds` (kept in suite order). */
    suiteId: z.string().min(1).optional(),
    scenarioIds: z.array(z.string().min(1)).max(500).optional(),
    /** Trials per scenario. */
    count: z.number().int().min(1).max(EVAL_JOB_MAX_COUNT),
    /** Honour `count` even where a scenario's `suggestedTrials` would trim it. */
    countStrict: z.boolean().optional(),
    /** Each target runs the whole selection, one after another. */
    targets: z.array(EvalJobTargetSpecSchema).min(1).max(EVAL_JOB_MAX_TARGETS),
    imageModelId: z.string().min(1).optional(),
    generalistMode: EvalGeneralistModeSchema.optional(),
    /** Absolute per-trial ceiling; never throughput-scaled. */
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000)
      .optional(),
    skipPreflight: z.boolean().optional(),
    note: z.string().max(500).optional(),
  })
  .refine((spec) => spec.suiteId !== undefined || (spec.scenarioIds?.length ?? 0) > 0, {
    message: 'choose a suite or at least one scenario',
  });
export type EvalJobSpec = z.infer<typeof EvalJobSpecSchema>;

export const EvalJobStatusSchema = z.enum([
  'queued',
  /** Another eval (in-app or the CLI) owns this device's engines. */
  'waiting-for-device',
  'running',
  'completed',
  /** The harness could not run the job at all (setup error). */
  'failed',
  'cancelled',
  /** The daemon stopped while the job was running. */
  'interrupted',
]);
export type EvalJobStatus = z.infer<typeof EvalJobStatusSchema>;

export const EvalJobTargetStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type EvalJobTargetStatus = z.infer<typeof EvalJobTargetStatusSchema>;

export const EvalJobCurrentTrialSchema = z.object({
  scenarioId: z.string(),
  trialId: z.string(),
  trialIndex: z.number().int().positive(),
  startedAt: z.string(),
});
export type EvalJobCurrentTrial = z.infer<typeof EvalJobCurrentTrialSchema>;

export const EvalJobTargetProgressSchema = z.object({
  provider: EvalProviderIdSchema,
  modelId: z.string(),
  status: EvalJobTargetStatusSchema,
  /** Matrix root for this target's trials. */
  runDir: z.string(),
  /** Known once the harness prints its plan (after suggestedTrials caps). */
  plannedTrials: z.number().int().nonnegative().optional(),
  completedTrials: z.number().int().nonnegative(),
  passedTrials: z.number().int().nonnegative(),
  currentTrial: EvalJobCurrentTrialSchema.optional(),
  preflight: z
    .object({
      admitted: z.boolean().nullable(),
      decodeTokensPerSec: z.number().optional(),
      skippedReason: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type EvalJobTargetProgress = z.infer<typeof EvalJobTargetProgressSchema>;

export const EvalJobSchema = z.object({
  id: z.string().min(1),
  spec: EvalJobSpecSchema,
  status: EvalJobStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Job-level failure (setup, harness crash). Per-target errors live on targets. */
  error: z.string().optional(),
  /** Who holds the device while `waiting-for-device`. */
  waitingOn: z.string().optional(),
  harness: EvalHarnessModeSchema,
  targets: z.array(EvalJobTargetProgressSchema),
  /** Job folder under the runs dir. */
  dir: z.string(),
});
export type EvalJob = z.infer<typeof EvalJobSchema>;

export const EvalJobListResponseSchema = z.object({ jobs: z.array(EvalJobSchema) });
export type EvalJobListResponse = z.infer<typeof EvalJobListResponseSchema>;

/** SSE frames for one job: a replayed snapshot, then live log lines and job updates. */
export const EvalJobStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), job: EvalJobSchema, log: z.array(z.string()) }),
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({ type: z.literal('job'), job: EvalJobSchema }),
]);
export type EvalJobStreamEvent = z.infer<typeof EvalJobStreamEventSchema>;

export const EvalRubricBandSchema = z.enum(['ship-ready', 'needs-tuning', 'framework-gap']);
export type EvalRubricBand = z.infer<typeof EvalRubricBandSchema>;

/** One trial as indexed from its run directory. */
export const EvalTrialSummarySchema = z.object({
  trialId: z.string(),
  scenarioId: z.string(),
  modelId: z.string(),
  provider: z.string().optional(),
  /** The in-app job that produced it; absent for CLI or legacy runs. */
  jobId: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  /** True while the harness still has `status.json` and no `result.json`. */
  running: z.boolean(),
  success: z.boolean().optional(),
  reason: z.string().optional(),
  failureMode: z.string().optional(),
  /** pass | model | infra | operator | grader. Only `model` counts against a model. */
  failureClass: z.string().optional(),
  failureClassRule: z.string().optional(),
  generalistMode: z.string().optional(),
  modelTier: z.string().optional(),
  /** Fixed-rubric composite, 0-10. */
  composite: z.number().optional(),
  band: EvalRubricBandSchema.optional(),
  /** Mean decode throughput the perf collector measured. */
  decodeTokensPerSec: z.number().optional(),
  runDir: z.string(),
});
export type EvalTrialSummary = z.infer<typeof EvalTrialSummarySchema>;

export const EvalTrialListResponseSchema = z.object({
  trials: z.array(EvalTrialSummarySchema),
  /** Trials that matched before `limit` was applied. */
  total: z.number().int().nonnegative(),
});
export type EvalTrialListResponse = z.infer<typeof EvalTrialListResponseSchema>;

export const EvalRubricAxisSchema = z.object({
  score: z.number(),
  summary: z.string(),
});
export type EvalRubricAxis = z.infer<typeof EvalRubricAxisSchema>;

export const EvalTrialDetailSchema = z.object({
  trial: EvalTrialSummarySchema,
  rubric: z
    .object({
      completion: EvalRubricAxisSchema,
      quality: EvalRubricAxisSchema,
      efficiency: EvalRubricAxisSchema,
      behavior: EvalRubricAxisSchema,
      includedInModelAggregate: z.boolean(),
    })
    .optional(),
  failureClassEvidence: z.string().optional(),
  /** Deterministic postmortem the harness wrote beside the result. */
  postmortemMarkdown: z.string().optional(),
  /** Last lines of the trial's human-readable timeline. */
  logTail: z.array(z.string()),
  /** Deliverables the trial left in its artifacts snapshot. */
  artifacts: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() })),
});
export type EvalTrialDetail = z.infer<typeof EvalTrialDetailSchema>;
