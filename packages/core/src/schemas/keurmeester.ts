import { z } from 'zod';

/**
 * The Keurmeester — a frontier-model quality inspector consulted when a
 * small/local model's existing recovery machinery (continuation nudges,
 * stuck-step redrives, gates) has given up. The consult produces a
 * structured verdict: a diagnosis plus exactly one action. Every consult
 * is recorded as an append-only case under `~/.gezel/keurmeester/` so
 * interventions can be audited, measured, and harvested into digests.
 */

/** Which exhaustion point summoned the Keurmeester. */
export const KeurmeesterTriggerKindSchema = z.enum([
  /** Chat continuation-nudge budget spent and the turn still looks stalled. */
  'nudge_budget_exhausted',
  /** Compaction self-chat loop halted the turn (context pressure cycle). */
  'context_loop',
  /** A step's completion gate hit maxAttempts and would pause for help. */
  'gate_exhausted',
  /** TaskScheduler stuck-step redrive budget spent; task about to pause. */
  'step_redrive_exhausted',
  /**
   * A turn ABORTED with a silent-stall-class provider error (visible
   * output never arrived; the mid-stream watchdog killed it). Distinct
   * from transport errors, which never consult — this is the model
   * drowning, one layer below the completed-turn triggers.
   */
  'turn_aborted',
  /**
   * The gate-escalation ladder plateaued at stage 3: the model kept
   * producing (rewrites, resubmits) while the same failing-check
   * signature never moved — the busy-but-not-delivering shape the
   * A/B showed sits below every exhaustion trigger. Fired
   * from the frozen-resubmit path, the pre-maxAttempts stage-3 gate
   * path, and the chat deliverable-contract's stop-retrying point.
   */
  'deliverable_plateau',
]);
export type KeurmeesterTriggerKind = z.infer<typeof KeurmeesterTriggerKindSchema>;

/**
 * The one action a verdict carries. The ladder, smallest first:
 * corrective prompt → step rewrite → craftbook rewrite → bounded
 * takeover. `stand_down` is an explicit "the existing give-up behavior
 * is correct here" — it's a first-class outcome, not a failure.
 */
export const KeurmeesterActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('corrective_prompt'),
    /** Sent to the struggling model as its next-turn prompt. */
    prompt: z.string().min(1),
  }),
  z.object({
    kind: z.literal('rewrite_step'),
    /** Step id inside the task's embedded craftbook. */
    stepId: z.string().min(1),
    /** Replacement step prompt. */
    prompt: z.string().min(1),
    name: z.string().optional(),
    /** Replacement deliverable spec, when the fix is a gated deliverable. */
    deliverable: z.string().optional(),
  }),
  z.object({
    kind: z.literal('rewrite_craftbook'),
    /** Full replacement craftbook document (markdown or JSON CraftbookDoc). */
    document: z.string().min(1),
    rationale: z.string().min(1),
  }),
  z.object({
    kind: z.literal('takeover_step'),
    /** Instruction for the Keurmeester's own bounded execution turn. */
    instruction: z.string().min(1),
  }),
  z.object({
    kind: z.literal('stand_down'),
    reason: z.string().min(1),
  }),
]);
export type KeurmeesterAction = z.infer<typeof KeurmeesterActionSchema>;

/** The Keurmeester's read on WHY the model is struggling. */
export const KeurmeesterFailureClassSchema = z.enum([
  /** Model finished reasoning but produced no visible content/tool call. */
  'silent_stall',
  /** Repeated identical or near-identical tool calls without progress. */
  'tool_loop',
  /** Model cannot produce the deliverable even with correct guidance. */
  'capability_ceiling',
  /** The task/craftbook as shaped is too big or ambiguous for this model. */
  'task_shape',
  /** Context-window pressure (compaction cycles, truncation thrash). */
  'context_pressure',
  'unknown',
]);
export type KeurmeesterFailureClass = z.infer<typeof KeurmeesterFailureClassSchema>;

export const KeurmeesterVerdictSchema = z.object({
  diagnosis: z.string().min(1),
  failureClass: KeurmeesterFailureClassSchema,
  action: KeurmeesterActionSchema,
  confidence: z.enum(['low', 'medium', 'high']),
});
export type KeurmeesterVerdict = z.infer<typeof KeurmeesterVerdictSchema>;

/**
 * Case records are append-only JSONL pairs sharing a `caseId`: an
 * `opened` record at consult time and (usually) a `closed` record once
 * the outcome is observable. No rewrites — a re-triggered case gets a
 * new pair and the old one closes as `re_triggered`.
 */
export const KeurmeesterCaseOpenedSchema = z.object({
  record: z.literal('case.opened'),
  caseId: z.string().min(1),
  /** ISO timestamp. */
  ts: z.string().min(1),
  trigger: KeurmeesterTriggerKindSchema,
  sessionId: z.string().optional(),
  gezelId: z.string().min(1),
  projectId: z.string().optional(),
  /** `${projectId}#${num}` task reference, when task-scoped. */
  taskRef: z.string().optional(),
  stepId: z.string().optional(),
  /** Struggling model's provider/model/tier. */
  providerName: z.string().min(1),
  model: z.string().optional(),
  modelTier: z.string().optional(),
  /** Keurmeester consult target. */
  consultProviderName: z.string().min(1),
  consultModel: z.string().optional(),
  /** Trigger-specific detector signals (continuations used, plateau ms, …). */
  signals: z.record(z.string(), z.unknown()),
  /** Absent when the consult itself failed (transport/parse). */
  verdict: KeurmeesterVerdictSchema.optional(),
  /** False when the verdict was recorded but downgraded/not applied. */
  applied: z.boolean(),
  consultDurationMs: z.number().int().nonnegative(),
  promptChars: z.number().int().nonnegative(),
  responseChars: z.number().int().nonnegative(),
  /** Full consult prompt + raw response — written only under debugMode. */
  debug: z
    .object({
      prompt: z.string(),
      rawResponse: z.string(),
    })
    .optional(),
});
export type KeurmeesterCaseOpened = z.infer<typeof KeurmeesterCaseOpenedSchema>;

export const KeurmeesterCaseOutcomeSchema = z.enum([
  /** The struggling model made observable progress after the intervention. */
  'unblocked',
  /** The same session/step summoned the Keurmeester again. */
  're_triggered',
  /** No progress within the observation window; existing give-up path ran. */
  'gave_up',
  'takeover_completed',
  'takeover_failed',
  /** Observation window closed without a definitive signal. */
  'unknown',
]);
export type KeurmeesterCaseOutcome = z.infer<typeof KeurmeesterCaseOutcomeSchema>;

export const KeurmeesterCaseClosedSchema = z.object({
  record: z.literal('case.closed'),
  caseId: z.string().min(1),
  ts: z.string().min(1),
  outcome: KeurmeesterCaseOutcomeSchema,
  /** How many of the struggling model's turns were observed before closing. */
  turnsObserved: z.number().int().nonnegative(),
});
export type KeurmeesterCaseClosed = z.infer<typeof KeurmeesterCaseClosedSchema>;

export const KeurmeesterCaseRecordSchema = z.discriminatedUnion('record', [
  KeurmeesterCaseOpenedSchema,
  KeurmeesterCaseClosedSchema,
]);
export type KeurmeesterCaseRecord = z.infer<typeof KeurmeesterCaseRecordSchema>;
